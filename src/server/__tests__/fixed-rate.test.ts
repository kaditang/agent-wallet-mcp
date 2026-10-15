import { afterEach, describe, expect, it, vi } from "vitest"
import { fixedRateFromPools, isCandidatePool, isStablePendlePt } from "../../sol/yields.js"

const NOW = Date.UTC(2026, 9, 15)
const pt = (o: Record<string, unknown>) => ({
  project: "pendle-v2", chain: "Ethereum", symbol: "SUSDE", poolMeta: "For buying PT-sUSDe-10DEC2026",
  tvlUsd: 20_000_000, apy: 6.5, pool: "p1", ...o,
})

describe("Pendle fixed-rate alternatives", () => {
  it("keeps only stablecoin PT purchase rows, never the LP rows or non-dollar PTs", () => {
    expect(isStablePendlePt(pt({}))).toBe(true)
    expect(isStablePendlePt(pt({ poolMeta: "For LP | Maturity 10DEC2026" }))).toBe(false)
    expect(isStablePendlePt(pt({ symbol: "WEETH" }))).toBe(false)
    expect(isStablePendlePt(pt({ project: "aave-v3" }))).toBe(false)
    expect(isCandidatePool(pt({}))).toBe(true) // survives the cache filter
  })

  it("parses maturity, drops thin, junk-APY and nearly matured markets, sorts by TVL", () => {
    const rows = fixedRateFromPools(
      [
        pt({ pool: "small", tvlUsd: 4_000_000 }),
        pt({ pool: "junk", apy: 450 }),
        pt({ pool: "soon", poolMeta: "For buying PT-sUSDe-20OCT2026" }),
        pt({ pool: "big", tvlUsd: 30_000_000, symbol: "USDE", poolMeta: "For buying PT-USDe-7JAN2027" }),
        pt({ pool: "mid" }),
      ],
      NOW,
    )
    expect(rows.map((r) => r.poolId)).toEqual(["big", "mid"])
    expect(rows[0]).toMatchObject({ maturity: "2027-01-07", daysToMaturity: 84, executable: false, pt: "PT-USDe-7JAN2027" })
  })
})

describe("compare_yields carries the fixed-rate block without mixing it into the ranking", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("lists PTs separately with the evidence; results stay USDC/treasury only", async () => {
    const usdc = { project: "kamino-lend", chain: "Solana", symbol: "USDC", apy: 5, apyBase: 5, tvlUsd: 50_000_000, pool: "kamino" }
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [usdc, pt({ poolMeta: "For buying PT-sUSDe-10DEC2099" })] })))
    const { compareYields, _clearYieldsCache } = await import("../../sol/yields.js")
    _clearYieldsCache()
    const r = await compareYields()
    expect(r.results.map((x) => x.poolId)).toEqual(["kamino"])
    expect(r.fixedRateAlternatives?.pools.map((x) => x.poolId)).toEqual(["p1"])
    expect(r.fixedRateAlternatives?.evidence).toMatch(/480 expired Pendle markets/)
    expect(r.fixedRateAlternatives?.note).toMatch(/not executable/)
  })

  it("omits the block when there is nothing to show", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })))
    const { compareYields, _clearYieldsCache } = await import("../../sol/yields.js")
    _clearYieldsCache()
    expect((await compareYields()).fixedRateAlternatives).toBeUndefined()
  })
})
