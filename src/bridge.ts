// Tiny stdio<->HTTP MCP bridge. Claude Desktop spawns this; it forwards
// JSON-RPC over stdio to the running HTTP MCP server with bearer auth.

import readline from "node:readline"

const url = process.env.MCP_URL ?? "http://localhost:3030/mcp"
const token = process.env.MCP_TOKEN ?? ""

const rl = readline.createInterface({ input: process.stdin })

rl.on("line", async (line) => {
  if (!line.trim()) return

  // Detect notifications — they don't expect a response, never echo anything
  // back even if the server returns an empty body.
  let isNotification = false
  let reqId: unknown = null
  try {
    const parsed = JSON.parse(line)
    isNotification = parsed && typeof parsed === "object" && !("id" in parsed)
    reqId = parsed?.id ?? null
  } catch {
    // forward as-is; fetch will likely reject
  }

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
      },
      body: line,
    })

    if (isNotification) return

    const ct = resp.headers.get("content-type") ?? ""
    if (ct.includes("text/event-stream")) {
      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf("\n")) >= 0) {
          const evt = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (evt.startsWith("data:")) {
            const payload = evt.slice(5).trim()
            if (payload) process.stdout.write(payload + "\n")
          }
        }
      }
    } else {
      const body = (await resp.text()).trim()
      if (body) process.stdout.write(body + "\n")
    }
  } catch (e) {
    if (isNotification) return
    const err = {
      jsonrpc: "2.0",
      id: reqId,
      error: { code: -32603, message: `bridge: ${(e as Error).message}` },
    }
    process.stdout.write(JSON.stringify(err) + "\n")
  }
})
