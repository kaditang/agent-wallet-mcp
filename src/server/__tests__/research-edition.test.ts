import "./setup.js"
import { describe, expect, it } from "vitest"
import request from "supertest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { app } from "../index.js"
import { createMcpServer } from "../mcp-server.js"
import { dispatch, getToolList } from "../tools.js"

// The research edition is what goes into the Claude connector directory. The
// directory excludes software that transfers crypto or executes financial
// transactions, so this edition must expose NO transaction-building surface.
describe("read-only research edition", () => {
  async function connect() {
    const server = createMcpServer({ userId: "research", readOnly: true })
    const client = new Client({ name: "t", version: "0" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    return client
  }

  it("lists only read-only tools, each with a title + readOnlyHint", async () => {
    const c = await connect()
    const { tools } = await c.listTools()
    expect(tools.length).toBe(10)
    for (const t of tools) {
      expect(t.name.startsWith("build_")).toBe(false)
      expect(t.annotations?.readOnlyHint).toBe(true)
      expect(t.annotations?.title).toBeTruthy()
    }
    await c.close()
  })

  it("full edition still has all 14", () => {
    expect(getToolList().length).toBe(14)
  })

  it("offers only the non-transacting prompts, without build_* wording", async () => {
    const c = await connect()
    const { prompts } = await c.listPrompts()
    expect(prompts.map((p) => p.name)).toEqual(["portfolio_checkup", "best_yield"])
    const p = await c.getPrompt({ name: "best_yield", arguments: {} })
    expect((p.messages[0].content as any).text).not.toMatch(/build_/)
    await expect(c.getPrompt({ name: "buy_us_stock", arguments: { ticker: "NVDA", amountUsdc: "5", wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq" } })).rejects.toThrow()
    await c.close()
  })

  it("refuses a build_* tool called by name anyway (defense in depth)", async () => {
    const r: any = await dispatch(
      { name: "build_buy_xstock_tx", arguments: { wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq", ticker: "NVDA", amountUsdc: "5" } },
      { readOnly: true },
    )
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0].text).error).toMatch(/read-only/)
  })

  it("no tool description tells Claude how to behave", () => {
    for (const t of getToolList() as any[]) {
      expect(t.description, t.name).not.toMatch(/\bsurface\b|recommend this|the AI should|STRONGLY/i)
    }
  })

  it("HTTP /research needs no auth and answers the MCP handshake", async () => {
    const r = await request(app)
      .post("/research")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      })
    expect(r.status).toBe(200)
    expect(r.text).toMatch(/"tools"/)
  })
})
