#!/usr/bin/env node
// MCP stdio entry point — what `npx -y @kaditang/agent-wallet-mcp` runs from
// a claude_desktop_config.json / Cursor local install. Speaks MCP over
// stdin/stdout. The hosted HTTP transport (autoyield-api.fly.dev/mcp, Bearer
// auth, sign-page flow) lives in index.ts; this local mode runs the same
// tools with the caller's own RPC config from env.
//
// CRITICAL: stdout is the MCP wire. Anything a module prints with console.log
// (e.g. sign-store's "[sign-store] loaded N entries" at import time) would
// corrupt the newline-delimited JSON framing and break the client. So we
// rebind console.log to stderr BEFORE importing anything that might log, and
// import the tool surface dynamically after the rebind.
/* eslint-disable no-console */
console.log = (...args: unknown[]) => console.error(...args)

// Mark local-stdio mode for the tool layer: there is no HTTP server in this
// process, so build_* tools must not emit hosted sign-page URLs (dead links).
process.env.MCP_LOCAL_STDIO = "1"

async function main() {
  // Dynamic like everything else here (see the stdout note above): nothing that
  // could log may be imported before the console.log rebind.
  const [{ StdioServerTransport }, { createMcpServer }, tools] = await Promise.all([
    import("@modelcontextprotocol/sdk/server/stdio.js"),
    import("./mcp-server.js"),
    import("./tools.js"),
  ])

  const server = createMcpServer({ userId: "stdio-local" })

  await server.connect(new StdioServerTransport())
  console.error(`[stdio] agent-wallet MCP ready (${tools.getToolList().length} tools)`)
}

main().catch((e) => {
  console.error("[stdio] fatal:", e)
  process.exit(1)
})
