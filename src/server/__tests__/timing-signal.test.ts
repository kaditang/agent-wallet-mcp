import { describe, expect, it } from "vitest"
import {
  computeTimingSignal,
  premiumHistoryFor,
} from "../../sol/timing-signal.js"

// A 14-sample baseline centered ~1.0% with small spread.
const HISTORY = [0.9, 1.1, 1.0, 0.8, 1.2, 1.0, 0.95, 1.05, 1.1, 0.9, 1.0, 1.15, 0.85, 1.0]

describe("computeTimingSignal", () => {
  it("insufficient-history when fewer than 12 samples", () => {
    const s = computeTimingSignal("NVDA", 1.0, [1.0, 1.1, 0.9])
    expect(s.signal).toBe("insufficient-history")
    expect(s.zScore).toBeNull()
  })

  it("insufficient-history when no current premium", () => {
    const s = computeTimingSignal("NVDA", null, HISTORY)
    expect(s.signal).toBe("insufficient-history")
  })

  it("rich-wait when current premium is unusually HIGH (z >= 1)", () => {
    // mean ≈ 1.0, std ≈ 0.11 → 1.5% is ~4.5 std above
    const s = computeTimingSignal("NVDA", 1.5, HISTORY)
    expect(s.signal).toBe("rich-wait")
    expect(s.zScore).toBeGreaterThanOrEqual(1)
    expect(s.note).toMatch(/HIGH|wait/i)
  })

  it("good-entry when current premium is unusually LOW (z <= -1)", () => {
    const s = computeTimingSignal("NVDA", 0.4, HISTORY)
    expect(s.signal).toBe("good-entry")
    expect(s.zScore).toBeLessThanOrEqual(-1)
  })

  it("fair when current premium is near the trailing mean", () => {
    const s = computeTimingSignal("NVDA", 1.0, HISTORY)
    expect(s.signal).toBe("fair")
    expect(Math.abs(s.zScore ?? 99)).toBeLessThan(1)
  })

  it("flat history (zero std) → fair, no divide-by-zero", () => {
    const flat = new Array(14).fill(1.0)
    const s = computeTimingSignal("NVDA", 1.0, flat)
    expect(s.signal).toBe("fair")
    expect(s.zScore).toBe(0)
    expect(Number.isFinite(s.trailingStdPct ?? NaN)).toBe(true)
  })
})

describe("premiumHistoryFor", () => {
  const records = [
    {
      t: "2026-05-24T00:00:00Z",
      marketState: "closed-weekend",
      entries: [
        { ticker: "NVDA", premiumPct: 2.1 },
        { ticker: "SPY", premiumPct: 1.2 },
      ],
    },
    {
      t: "2026-05-24T02:00:00Z",
      marketState: "closed-weekend",
      entries: [
        { ticker: "NVDA", premiumPct: 2.3 },
        { ticker: "SPY", premiumPct: null }, // missing → excluded
      ],
    },
  ]

  it("extracts a ticker's premium series, skipping nulls", () => {
    expect(premiumHistoryFor(records, "NVDA")).toEqual([2.1, 2.3])
    expect(premiumHistoryFor(records, "SPY")).toEqual([1.2])
    expect(premiumHistoryFor(records, "TSLA")).toEqual([])
  })
})
