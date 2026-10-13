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
import { OUTPUT_SCHEMAS, structuredFromText } from "./output-schemas.js"
import { takeBudget } from "./budget.js"
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

const KNOWN_TOOLS = new Set<string>(getToolList().map((t) => t.name))

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
      result = takeBudget(edition, r.params.name)
        ? await dispatch(r.params, ctx)
        : {
            content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: `${r.params.name} is busy right now (shared per-minute limit). Try again in a minute.` }) }],
            isError: true,
          }
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
    // Only known tool names become metric keys — arbitrary names from a caller
    // would otherwise grow the persisted metrics store without bound.
    recordToolCall(edition, KNOWN_TOOLS.has(r.params.name) ? r.params.name : "_unknown", !result?.isError, Date.now() - t0, err)
    // Tools declare an outputSchema, so a successful result must also carry
    // structuredContent (the SDK client rejects it otherwise). Every tool
    // answers with one JSON object as text; mirror it. The text stays for
    // clients that predate structured output.
    if (!result?.isError && OUTPUT_SCHEMAS[r.params.name] && !result?.structuredContent) {
      const txt = result?.content?.[0]?.text
      result = { ...result, structuredContent: structuredFromText(txt) ?? { text: String(txt ?? "") } }
    }
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
