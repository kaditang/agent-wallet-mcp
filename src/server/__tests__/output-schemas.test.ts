import "./setup.js"
import { describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createMcpServer } from "../mcp-server.js"
import { getToolList } from "../tools.js"
import { structuredFromText } from "../output-schemas.js"

// Tools declare outputSchema; the SDK client then REQUIRES structuredContent on
// every successful result and validates it — a missing schema entry is fine,
// but a declared schema without structuredContent breaks the call client-side.
describe("output schemas + structuredContent", () => {
  async function connect(readOnly: boolean) {
    const server = createMcpServer({ userId: "t", readOnly })
    const client = new Client({ name: "t", version: "0" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    return client
  }

  it("every tool declares a loose object outputSchema", () => {
    for (const t of getToolList() as any[]) {
      expect(t.outputSchema, t.name).toBeDefined()
      expect(t.outputSchema.type).toBe("object")
      expect(t.outputSchema.required).toBeUndefined()
      expect(t.outputSchema.additionalProperties).toBe(true)
    }
  })

  it("a successful call returns structuredContent equal to the JSON text (SDK client validates it)", async () => {
    const c = await connect(true)
    const r: any = await c.callTool({ name: "list_yield_tokens", arguments: {} })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toEqual(JSON.parse(r.content[0].text))
    await c.close()
  })

  it("an error result carries no structuredContent and still reaches the client", async () => {
    const c = await connect(true)
    const r: any = await c.callTool({ name: "get_portfolio", arguments: { wallet: "not-a-wallet" } })
    expect(r.isError).toBe(true)
    expect(r.structuredContent).toBeUndefined()
    await c.close()
  })

  it("structuredFromText only accepts a JSON object", () => {
    expect(structuredFromText('{"a":1}')).toEqual({ a: 1 })
    expect(structuredFromText("[1]")).toBeUndefined()
    expect(structuredFromText("nope")).toBeUndefined()
    expect(structuredFromText(undefined)).toBeUndefined()
  })
})
