// One place that builds the MCP server, shared by the hosted HTTP transport
// (index.ts) and the local stdio entry (stdio.ts). They used to each wire
// their own Server + handlers, which is how the handshake version drifted
// before; capabilities (tools + prompts) now can't diverge between them.
//
// stdio.ts imports this module DYNAMICALLY, after rebinding console.log to
// stderr — keep this module free of import-time stdout output.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { ZodError } from "zod"
import { sanitizeError } from "./auth.js"
import { recordPrompt, recordToolCall } from "./metrics.js"
import { getPrompt, listPrompts } from "./prompts.js"
import { dispatch, getToolList } from "./tools.js"
import { SERVER_VERSION } from "./version.js"

/**
 * Readable error for a failed tool call. Zod validation errors used to come
 * back as their raw multi-line JSON dump; directory review wants actionable
 * messages ("invalid argument targets.0.percent: expected number").
 */
export function toolErrorMessage(e: unknown): string {
  if (e instanceof ZodError) {
    const parts = e.issues.slice(0, 5).map((i) => {
      const at = i.path.length ? i.path.join(".") : "arguments"
      const got = (i as { received?: unknown }).received
      return `${at}: ${i.message}${got === "undefined" ? " (missing)" : ""}`
    })
    return `invalid arguments — ${parts.join("; ")}`
  }
  return sanitizeError(e)
}

export function createMcpServer(ctx: { userId?: string; readOnly?: boolean }) {
  const server = new Server(
    { name: "agent-wallet", version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolList({ readOnly: ctx.readOnly }) as any }))
  // A tool that THROWS (upstream outage, bad args failing zod, …) used to
  // surface as a JSON-RPC protocol error carrying the raw message — once a
  // whole nginx 503 HTML page. MCP wants tool failures as a result with
  // isError, so the model sees a short, sanitized reason and can retry or
  // explain. Prompts keep protocol errors (InvalidParams is correct there).
  const edition = ctx.readOnly ? "research" : "full"
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    const t0 = Date.now()
    let result: any
    try {
      result = await dispatch(r.params, ctx)
    } catch (e) {
      result = {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: toolErrorMessage(e) }) }],
        isError: true,
      }
    }
    // Anonymous aggregate only: tool name, success, latency (see metrics.ts).
    let err: string | undefined
    if (result?.isError) {
      const txt = String(result?.content?.[0]?.text ?? "")
      try {
        const j = JSON.parse(txt)
        err = String(j.error ?? j.reason ?? txt)
      } catch {
        err = txt
      }
    }
    recordToolCall(edition, r.params.name, !result?.isError, Date.now() - t0, err)
    return result
  })
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts({ readOnly: ctx.readOnly }) }))
  server.setRequestHandler(GetPromptRequestSchema, async (r) => {
    const out = getPrompt(r.params.name, (r.params.arguments ?? {}) as Record<string, string>, { readOnly: ctx.readOnly })
    recordPrompt(edition, r.params.name)
    return out
  })
  return server
}
