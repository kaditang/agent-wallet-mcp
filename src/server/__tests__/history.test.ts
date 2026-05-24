import { describe, it, expect } from "vitest"
import { classifyTrade, toCsv, type RegistryAsset, type HistoryEntry } from "../../sol/history.js"

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"
const USDY = "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6"

const REGISTRY: Record<string, RegistryAsset> = {
  [USDC]: { symbol: "USDC", kind: "usdc" },
  [NVDAX]: { symbol: "NVDAx", kind: "xstock" },
  [USDY]: { symbol: "USDY", kind: "yield" },
}

describe("classifyTrade", () => {
  it("USDC out + asset in = buy, with derived price", () => {
    const t = classifyTrade(
      [
        { mint: USDC, uiDelta: -10 },
        { mint: NVDAX, uiDelta: 0.0456 },
      ],
      REGISTRY,
    )!
    expect(t.action).toBe("buy")
    expect(t.asset).toBe("NVDAx")
    expect(t.amount).toBeCloseTo(0.0456)
    expect(t.usdc).toBe(10)
    expect(t.pricePerUnit).toBeCloseTo(10 / 0.0456)
  })

  it("USDC in + asset out = sell", () => {
    const t = classifyTrade(
      [
        { mint: USDC, uiDelta: 1.95 },
        { mint: NVDAX, uiDelta: -0.009 },
      ],
      REGISTRY,
    )!
    expect(t.action).toBe("sell")
    expect(t.asset).toBe("NVDAx")
    expect(t.amount).toBeCloseTo(0.009)
    expect(t.usdc).toBe(1.95)
  })

  it("classifies a yield-token deposit (USDC → USDY) as a buy", () => {
    const t = classifyTrade(
      [
        { mint: USDC, uiDelta: -10 },
        { mint: USDY, uiDelta: 8.84 },
      ],
      REGISTRY,
    )!
    expect(t.action).toBe("buy")
    expect(t.assetKind).toBe("yield")
    expect(t.asset).toBe("USDY")
  })

  it("returns null for a plain transfer (only one leg)", () => {
    expect(
      classifyTrade([{ mint: NVDAX, uiDelta: 0.05 }], REGISTRY),
    ).toBeNull()
  })

  it("returns null when no USDC leg (token-to-token)", () => {
    expect(
      classifyTrade(
        [
          { mint: NVDAX, uiDelta: -0.05 },
          { mint: USDY, uiDelta: 8 },
        ],
        REGISTRY,
      ),
    ).toBeNull()
  })

  it("ignores unknown mints and dust", () => {
    const t = classifyTrade(
      [
        { mint: USDC, uiDelta: -10 },
        { mint: NVDAX, uiDelta: 0.0456 },
        { mint: "SomeUnknownMint1111111111111111111111111111", uiDelta: 5 },
        { mint: USDY, uiDelta: 1e-12 }, // dust, below epsilon
      ],
      REGISTRY,
    )
    // Unknown mint filtered out, dust filtered → still a clean USDC↔NVDAx buy.
    expect(t).not.toBeNull()
    expect(t!.asset).toBe("NVDAx")
  })
})

describe("toCsv", () => {
  it("renders a header + one row per entry", () => {
    const entries: HistoryEntry[] = [
      {
        action: "buy",
        asset: "NVDAx",
        assetKind: "xstock",
        amount: 0.0456,
        usdc: 10,
        pricePerUnit: 219.3,
        signature: "abc123",
        blockTime: 1716500000,
        isoTime: "2026-05-24T00:00:00.000Z",
        solscanUrl: "https://solscan.io/tx/abc123",
      },
    ]
    const csv = toCsv(entries)
    const lines = csv.split("\n")
    expect(lines[0]).toBe("date,action,asset,amount,usdc,price_per_unit,signature")
    // Text fields are quoted (delimiter/injection safety); numbers stay raw.
    expect(lines[1]).toBe(
      '"2026-05-24T00:00:00.000Z","buy","NVDAx",0.0456,10,219.300000,"abc123"',
    )
  })

  it("neutralizes a formula-injection payload in a text field", () => {
    const entries: HistoryEntry[] = [
      {
        action: "sell",
        asset: "=cmd|'/c calc'!A1", // hostile symbol (defensive — not reachable today)
        assetKind: "xstock",
        amount: 1,
        usdc: 2,
        pricePerUnit: 2,
        signature: "sig",
        blockTime: 0,
        isoTime: "2026-01-01T00:00:00.000Z",
        solscanUrl: "https://solscan.io/tx/sig",
      },
    ]
    const row = toCsv(entries).split("\n")[1]
    // Leading apostrophe added, whole field quoted.
    expect(row).toContain(`"'=cmd|'/c calc'!A1"`)
  })
})
