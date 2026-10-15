import { afterEach, describe, expect, it, vi } from "vitest"
import { redactError } from "../metrics.js"

describe("compare_yields DefiLlama cache", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("downloads the pool list once for back-to-back and concurrent calls", async () => {
    const pool = { symbol: "USDC", project: "kamino-lend", chain: "Solana", apy: 5, apyBase: 5, tvlUsd: 5e6, pool: "p1" }
    const f = vi.fn(async () => Response.json({ data: [pool] }))
    vi.stubGlobal("fetch", f)
    const { compareYields, _clearYieldsCache } = await import("../../sol/yields.js")
    _clearYieldsCache()
    await Promise.all([compareYields(), compareYields()])
    await compareYields()
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("serves a stale copy when a refresh fails, instead of erroring", async () => {
    const { compareYields, _clearYieldsCache } = await import("../../sol/yields.js")
    _clearYieldsCache()
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: [] })))
    await compareYields()
    vi.useFakeTimers({ now: Date.now() + 6 * 60_000, toFake: ["Date"] }) // past the 5-min TTL
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })))
    await expect(compareYields()).resolves.toMatchObject({ rankedBy: "riskAdjustedApy" })
    vi.useRealTimers()
  })
})

describe("export_history fetches in parallel but keeps order", () => {
  it("returns trades in signature order with ≤5 concurrent fetches", async () => {
    vi.resetModules()
    let inFlight = 0
    let peak = 0
    const sigs = Array.from({ length: 12 }, (_, i) => ({ signature: `s${i}`, err: null, blockTime: 1_000 + i }))
    vi.doMock("../../sol/connection.js", () => ({
      withRpcFallback: async (fn: any) =>
        fn({
          getSignaturesForAddress: async () => sigs,
          getParsedTransaction: async (sig: string) => {
            inFlight++
            peak = Math.max(peak, inFlight)
            await new Promise((r) => setTimeout(r, 15 - Number(sig.slice(1)))) // later sigs resolve first
            inFlight--
            return null // no trades; we only care about ordering + concurrency here
          },
        }),
    }))
    const { fetchTradeHistory } = await import("../../sol/history.js")
    const out = await fetchTradeHistory("3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq", 12)
    expect(out).toEqual([])
    expect(peak).toBeLessThanOrEqual(5)
    expect(peak).toBeGreaterThan(1)
    vi.doUnmock("../../sol/connection.js")
  })
})

describe("metrics error redaction", () => {
  it("removes wallet/mint addresses and URLs, truncates", () => {
    const e = redactError("jupiter quote 400 for XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W via https://api.jup.ag/x?k=1 wallet 3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq")
    expect(e).toBe("jupiter quote 400 for [addr] via [url] wallet [addr]")
    expect(redactError("x".repeat(500)).length).toBe(160)
  })
})

describe("compare_yields speculative tier", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("ranks a high-APY, very weak pool after every core pool, and never as a top pick", async () => {
    const pools = [
      // Real 2026-10-15 shape: 63.7% on $0.2M, unknown protocol, predicted down → score ~8.
      { symbol: "USDC", project: "ample", chain: "Base", apy: 63.7, apyBase: 20, apyReward: 43.7, tvlUsd: 205_290, sigma: 40, predictions: { predictedClass: "Down", predictedProbability: 80 }, pool: "weak" },
      { symbol: "USDC", project: "compound-v3", chain: "Ethereum", apy: 5.5, apyBase: 5.5, tvlUsd: 35.6e6, sigma: 0.5, pool: "comp" },
      { symbol: "USDC", project: "kamino-lend", chain: "Solana", apy: 5.9, apyBase: 5.9, tvlUsd: 8e6, sigma: 0.5, pool: "kamino" },
    ]
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: pools })))
    const { compareYields, _clearYieldsCache, SPECULATIVE_BELOW } = await import("../../sol/yields.js")
    _clearYieldsCache()
    const r = await compareYields({ amountUsdc: 10_000 })
    const weak = r.results.find((p) => p.poolId === "weak")!
    expect(weak.riskScore).toBeLessThan(SPECULATIVE_BELOW)
    expect(weak.tier).toBe("speculative")
    expect(weak.riskNotes.join(" ")).toMatch(/speculative/)
    expect(r.results[r.results.length - 1].poolId).toBe("weak")
    expect(r.topByRiskAdjustedOverall?.tier).toBe("core")
    expect(r.topExecutable?.poolId).toBe("kamino")
  })
})
