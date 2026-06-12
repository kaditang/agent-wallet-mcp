#!/usr/bin/env node
// MCP stdio entry point — what `npx -y @kaditang/agent-wallet-mcp` runs from
// a claude_desktop_config.json / Cursor local install. Speaks MCP over
// stdin/stdout. The hosted HTTP transport (autoyield-api.fly.dev/mcp, Bearer
// auth, sign-page flow) lives in index.ts; this local mode runs the same 13
// tools with the caller's own RPC config from env.
//
// CRITICAL: stdout is the MCP wire. Anything a module prints with console.log
// (e.g. sign-store's "[sign-store] loaded N entries" at import time) would
// corrupt the newline-delimited JSON framing and break the client. So we
// rebind console.log to stderr BEFORE importing anything that might log, and
// import the tool surface dynamically after the rebind.
/* eslint-disable no-console */
console.log = (...args: unknown[]) => console.error(...args)

async function main() {
  const [{ Server }, { StdioServerTransport }, types, tools] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/index.js"),
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("@modelcontextprotocol/sdk/types.js"),
    import("./tools.js"),
  ])

  const server = new Server(
    { name: "agent-wallet", version: "0.2.1" },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(types.ListToolsRequestSchema, async () => ({
    tools: tools.getToolList() as any,
  }))
  server.setRequestHandler(types.CallToolRequestSchema, async (r) =>
    tools.dispatch(r.params, { userId: "stdio-local" }),
  )

  await server.connect(new StdioServerTransport())
  console.error("[stdio] agent-wallet MCP ready (13 tools)")
}

main().catch((e) => {
  console.error("[stdio] fatal:", e)
  process.exit(1)
})
