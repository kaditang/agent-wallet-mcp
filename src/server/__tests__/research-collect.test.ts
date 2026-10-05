import { describe, expect, it } from "vitest"
import { compactYield, costBpsVsBaseline, isDue, lastRecordT } from "../../research/collect.js"
import { jupImpactToPercent } from "../../sol/jupiter.js"

describe("jupImpactToPercent", () => {
  it("Jupiter's priceImpactPct is a fraction — convert to a real percent", () => {
    // Real MCDx $50k buy quote, 2026-10-05: realized price was ~0.94% worse than $100.
    expect(jupImpactToPercent("0.0108753521283377779094178436")).toBe(1.0875)
    expect(jupImpactToPercent("0")).toBe(0)
  })
  it("null for missing / unparseable input", () => {
    for (const v of [undefined, null, "", "abc"]) expect(jupImpactToPercent(v as any)).toBeNull()
  })
})

describe("isDue", () => {
  const NOW = Date.parse("2026-10-05T12:00:00Z")
  it("due when the file has no records or an unparseable timestamp", () => {
    expect(isDue(undefined, 3_600_000, NOW)).toBe(true)
    expect(isDue("garbage", 3_600_000, NOW)).toBe(true)
  })
  it("respects the interval", () => {
    expect(isDue("2026-10-05T10:00:00Z", 3 * 3_600_000, NOW)).toBe(false) // 2h < 3h
    expect(isDue("2026-10-05T09:00:00Z", 3 * 3_600_000, NOW)).toBe(true) // 3h
  })
})

describe("costBpsVsBaseline", () => {
  it("measures extra cost vs the smallest size from RAW outputs (multiplier cancels)", () => {
    // Real MCDx quotes: $100 → 0.42023913 raw, $50k → 208.16217461 raw.
    const r = costBpsVsBaseline([
      { usd: 100, outRaw: 0.42023913, impactPct: 0.16 },
      { usd: 50_000, outRaw: 208.16217461, impactPct: 1.09 },
    ])
    expect(r["100"]).toBe(0)
    expect(r["50000"]).toBeCloseTo(94, 0) // ~0.94% worse
  })
  it("null for failed quotes; falls back to the smallest SUCCESSFUL size as baseline", () => {
    const r = costBpsVsBaseline([
      { usd: 100, outRaw: null, impactPct: null },
      { usd: 1_000, outRaw: 10, impactPct: 0 },
      { usd: 10_000, outRaw: 99, impactPct: 1 },
    ])
    expect(r["100"]).toBeNull()
    expect(r["1000"]).toBe(0)
    expect(r["10000"]).toBeCloseTo(101.01, 1)
  })
  it("all failed → all null", () => {
    expect(costBpsVsBaseline([{ usd: 100, outRaw: null, impactPct: null }])).toEqual({ "100": null })
  })
})

describe("lastRecordT", () => {
  it("reads the newest record's t, even when that line is cut off", () => {
    const body = `{"t":"2026-10-04T00:00:00Z","x":1}\n{"t":"2026-10-05T00:00:00Z","pools":[{"id":"a"`
    expect(lastRecordT(body)).toBe("2026-10-05T00:00:00Z")
  })
  it("ignores a chunk that starts mid-line and trailing newlines", () => {
    expect(lastRecordT(`ools":[1]}\n{"t":"2026-10-05T01:00:00Z","n":2}\n\n`)).toBe("2026-10-05T01:00:00Z")
    expect(lastRecordT(`ools":[1]}`)).toBeUndefined()
  })
})

describe("compactYield", () => {
  it("keeps the backtest fields, drops derivable text", () => {
    const c = compactYield({
      protocol: "kamino-usdc",
      chain: "solana",
      asset: "USDC",
      apy: 5.5,
      apyBase: 5.5,
      tvlUsd: 6_978_109.4,
      poolId: "d2141a59",
      executable: true,
      riskAdjustedApy: 3.54,
      riskScore: 64,
      riskFactors: { volatility: 0.98, liquidity: 0.65, protocol: 1, stability: 1, sustainability: 1, ilSafety: 1 },
      riskNotes: ["x"],
      note: "y",
    } as any)
    expect(c).toMatchObject({ id: "d2141a59", p: "kamino-usdc", c: "solana", tvl: 6_978_109, radj: 3.54, score: 64, x: true, rew: null })
    expect(c).not.toHaveProperty("riskNotes")
  })
})
