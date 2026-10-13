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
  server.setRequestHandler(CallToolRequestSchema, async (r) => {
    try {
      return await dispatch(r.params, ctx)
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: toolErrorMessage(e) }) }],
        isError: true,
      }
    }
  })
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts({ readOnly: ctx.readOnly }) }))
  server.setRequestHandler(GetPromptRequestSchema, async (r) =>
    getPrompt(r.params.name, (r.params.arguments ?? {}) as Record<string, string>, { readOnly: ctx.readOnly }),
  )
  return server
}
