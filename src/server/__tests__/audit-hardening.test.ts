import "./setup.js"
import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { app } from "../index.js"
import { createMcpServer } from "../mcp-server.js"
import { _resetBudgets, takeBudget } from "../budget.js"
import { _resetMetrics, metricsSummary } from "../metrics.js"
import { dispatch } from "../tools.js"

// 2026-10-13 audit: unauthenticated /research could drive paid RPC without a
// global bound (batches bypass per-IP limits), and arbitrary tool names grew
// the persisted metrics store without bound.
describe("audit hardening", () => {
  beforeEach(() => {
    _resetBudgets()
    _resetMetrics()
  })

  it("global budget: export_history stops at 20/min per edition, other editions unaffected, window slides", () => {
    const t = 1_000_000
    for (let i = 0; i < 20; i++) expect(takeBudget("research", "export_history", t)).toBe(true)
    expect(takeBudget("research", "export_history", t)).toBe(false)
    expect(takeBudget("full", "export_history", t)).toBe(true)
    expect(takeBudget("research", "compare_yields", t)).toBe(true) // unbudgeted
    expect(takeBudget("research", "export_history", t + 60_001)).toBe(true)
  })

  it("over budget → isError result, tool not run", async () => {
    for (let i = 0; i < 20; i++) takeBudget("research", "export_history")
    const server = createMcpServer({ userId: "research", readOnly: true })
    const client = new Client({ name: "t", version: "0" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    const r: any = await client.callTool({ name: "export_history", arguments: { wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq" } })
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toMatch(/busy/)
    await client.close()
  })

  it("unknown tool names are bucketed as _unknown in metrics", async () => {
    const server = createMcpServer({ userId: "research", readOnly: true })
    const client = new Client({ name: "t", version: "0" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    for (const n of ["zzz1", "zzz2", "zzz3"]) await client.callTool({ name: n, arguments: {} }).catch(() => {})
    const tools = metricsSummary(1).editions.research?.tools ?? {}
    expect(Object.keys(tools)).toEqual(["_unknown"])
    expect(tools._unknown.calls).toBe(3)
    await client.close()
  })

  it("rejects oversized JSON-RPC batches on /research", async () => {
    const batch = Array.from({ length: 11 }, (_, i) => ({ jsonrpc: "2.0", id: i, method: "tools/list" }))
    const r = await request(app)
      .post("/research")
      .set("accept", "application/json, text/event-stream")
      .send(batch)
    expect(r.status).toBe(400)
    expect(r.body.error.message).toMatch(/batch too large/)
  })

  it("/metrics answers 404 (not 500) for a non-ASCII token of equal length", async () => {
    const want = process.env.METRICS_TOKEN!
    const r = await request(app).get("/metrics").set("authorization", `Bearer ${"é".repeat(want.length)}`)
    expect(r.status).toBe(404)
  })

  it("amount args accept a JSON number as well as a string (models send numbers after compare_yields)", async () => {
    const asNumber: any = await dispatch({ name: "quote_tokenized_stock", arguments: { ticker: "ZZZZ", amountUsdc: 500 } })
    expect(asNumber.content[0].text).toMatch(/not in xStocks registry/) // got past argument validation
    await expect(dispatch({ name: "quote_tokenized_stock", arguments: { ticker: "ZZZZ", amountUsdc: -5 } })).rejects.toThrow()
    await expect(dispatch({ name: "quote_tokenized_stock", arguments: { ticker: "ZZZZ", amountUsdc: true } })).rejects.toThrow()
  })
})
