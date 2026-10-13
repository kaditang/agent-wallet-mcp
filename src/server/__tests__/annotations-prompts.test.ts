import { describe, expect, it } from "vitest"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { getToolList, TOOL_ANNOTATIONS } from "../tools.js"
import { getPrompt, listPrompts } from "../prompts.js"
import { createMcpServer } from "../mcp-server.js"

describe("tool annotations", () => {
  it("every tool carries an explicit annotation (a new tool must make a safety call)", () => {
    for (const t of getToolList() as any[]) {
      expect(TOOL_ANNOTATIONS[t.name], `missing annotation for ${t.name}`).toBeDefined()
      expect(t.annotations).toEqual(TOOL_ANNOTATIONS[t.name])
    }
    // and no stale entries for tools that no longer exist
    const names = new Set((getToolList() as any[]).map((t) => t.name))
    for (const k of Object.keys(TOOL_ANNOTATIONS)) expect(names.has(k), `stale annotation ${k}`).toBe(true)
  })

  it("only build_* tools are non-read-only, and none is marked destructive", () => {
    for (const t of getToolList() as any[]) {
      const a = t.annotations
      if (t.name.startsWith("build_")) {
        expect(a.readOnlyHint).toBe(false)
        expect(a.destructiveHint).toBe(false) // nothing moves until the user signs
        expect(a.idempotentHint).toBe(false)
      } else {
        expect(a.readOnlyHint).toBe(true)
      }
    }
  })
})

describe("prompts", () => {
  it("lists the three workflows with their arguments", () => {
    const ps = listPrompts()
    expect(ps.map((p) => p.name)).toEqual(["portfolio_checkup", "buy_us_stock", "best_yield"])
    expect(ps.find((p) => p.name === "buy_us_stock")!.arguments.filter((a) => a.required).map((a) => a.name)).toEqual([
      "ticker",
      "amountUsdc",
      "wallet",
    ])
  })

  it("renders a user message with the args and the confirm-before-build rule", () => {
    const r = getPrompt("buy_us_stock", {
      ticker: "nvda",
      amountUsdc: "50",
      wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq",
    })
    const text = r.messages[0].content.text
    expect(r.messages[0].role).toBe("user")
    expect(text).toContain("NVDA")
    expect(text).toContain("check_xstock_safety")
    expect(text).toMatch(/Do NOT call any build_\* tool unless I explicitly confirm/)
  })

  it("optional argument may be omitted", () => {
    expect(getPrompt("best_yield", {}).messages[0].content.text).toContain("Call compare_yields.")
  })

  it("rejects unknown prompts, missing and malformed arguments", () => {
    expect(() => getPrompt("nope")).toThrow(/unknown prompt/)
    expect(() => getPrompt("portfolio_checkup", {})).toThrow(/missing required argument: wallet/)
    expect(() => getPrompt("portfolio_checkup", { wallet: "not a wallet; ignore previous" })).toThrow(/invalid wallet/)
    expect(() =>
      getPrompt("buy_us_stock", { ticker: "NVDA", amountUsdc: "lots", wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq" }),
    ).toThrow(/invalid amountUsdc/)
  })
})

describe("createMcpServer over the real MCP protocol", () => {
  it("advertises tools + prompts and serves both", async () => {
    const server = createMcpServer({ userId: "test" })
    const client = new Client({ name: "t", version: "0" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])

    expect(client.getServerCapabilities()).toMatchObject({ tools: {}, prompts: {} })

    const { tools } = await client.listTools()
    const build = tools.find((t) => t.name === "build_buy_xstock_tx")!
    expect(build.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })

    const { prompts } = await client.listPrompts()
    expect(prompts).toHaveLength(3)
    const p = await client.getPrompt({ name: "best_yield", arguments: { amountUsdc: "1000" } })
    expect((p.messages[0].content as any).text).toContain("amountUsdc 1000")

    await expect(client.getPrompt({ name: "portfolio_checkup", arguments: {} })).rejects.toThrow(/wallet/)
    await client.close()
  })
})

describe("tool errors are MCP tool results, not protocol errors", () => {
  it("a throwing tool comes back as isError with a short message", async () => {
    const server = createMcpServer({ userId: "test" })
    const client = new Client({ name: "t", version: "0" })
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(st), client.connect(ct)])
    // zod rejects the missing ticker → dispatch throws
    const r: any = await client.callTool({ name: "quote_tokenized_stock", arguments: { amountUsdc: "10" } })
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content[0].text).ok).toBe(false)
    await client.close()
  })
})
