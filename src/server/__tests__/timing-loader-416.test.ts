import { afterEach, describe, expect, it, vi } from "vitest"

// GitHub raw returns 416 when `Range: bytes=-N` exceeds the file size. The
// loader must fall back to a plain GET, or every signal silently becomes
// "insufficient-history" whenever the snapshot file is smaller than the tail.
describe("snapshot loader: 416 on an over-long suffix range", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("retries without Range and still builds the baseline", async () => {
    const now = Date.now()
    const body =
      Array.from({ length: 20 }, (_, i) =>
        JSON.stringify({
          t: new Date(now - (i + 1) * 3_600_000).toISOString(),
          marketState: i % 2 ? "open" : "closed-afterhours",
          entries: [{ ticker: "SPY", premiumPct: 0.02 + (i % 5) * 0.01 }],
        }),
      ).join("\n") + "\n"
    const calls: Array<Record<string, string> | undefined> = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
        calls.push(init?.headers)
        return init?.headers?.Range
          ? new Response(null, { status: 416 })
          : new Response(body, { status: 200 })
      }),
    )
    vi.resetModules() // fresh module → empty snapshot cache
    const { getTimingSignal } = await import("../../sol/timing-signal.js")
    const s = await getTimingSignal("SPY", 0.04)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.Range).toMatch(/^bytes=-\d+$/)
    expect(calls[1]?.Range).toBeUndefined()
    expect(s.sampleCount).toBeGreaterThanOrEqual(10) // baseline built, not "insufficient-history" by fetch failure
    expect(s.signal).not.toBe("insufficient-history")
  })
})
