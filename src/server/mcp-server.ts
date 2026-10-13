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
import { getPrompt, listPrompts } from "./prompts.js"
import { dispatch, getToolList } from "./tools.js"
import { SERVER_VERSION } from "./version.js"

export function createMcpServer(ctx: { userId?: string }) {
  const server = new Server(
    { name: "agent-wallet", version: SERVER_VERSION },
    { capabilities: { tools: {}, prompts: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolList() as any }))
  server.setRequestHandler(CallToolRequestSchema, async (r) => dispatch(r.params, ctx))
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: listPrompts() }))
  server.setRequestHandler(GetPromptRequestSchema, async (r) =>
    getPrompt(r.params.name, (r.params.arguments ?? {}) as Record<string, string>),
  )
  return server
}
