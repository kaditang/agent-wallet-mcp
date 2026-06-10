import { describe, expect, it } from "vitest"
import {
  computeTimingSignal,
  premiumHistoryFor,
  usMarketRegime,
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

  it("rejects an out-of-range current premium (poisoned price) → insufficient", () => {
    // A spoofed underlying price could yield an absurd premium like 999%.
    const s = computeTimingSignal("NVDA", 999, HISTORY)
    expect(s.signal).toBe("insufficient-history")
    expect(s.note).toMatch(/out-of-range|No valid/i)
  })

  it("drops out-of-range history samples before computing stats", () => {
    // 11 good samples + 3 poisoned (>50%): only 11 valid < 12 → insufficient.
    const poisoned = [...HISTORY.slice(0, 11), 5000, -9999, 1e9]
    const s = computeTimingSignal("NVDA", 1.0, poisoned)
    expect(s.signal).toBe("insufficient-history")
    expect(s.sampleCount).toBe(11) // poisoned samples filtered out
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

  it("filters by market regime (open vs closed)", () => {
    const mixed = [
      ...records, // 2 closed-weekend samples (NVDA 2.1, 2.3)
      {
        t: "2026-05-26T15:00:00Z",
        marketState: "open",
        entries: [{ ticker: "NVDA", premiumPct: 0.5 }],
      },
      {
        t: "2026-05-26T22:00:00Z",
        marketState: "closed-afterhours",
        entries: [{ ticker: "NVDA", premiumPct: 1.8 }],
      },
    ]
    expect(premiumHistoryFor(mixed, "NVDA", "open")).toEqual([0.5])
    expect(premiumHistoryFor(mixed, "NVDA", "closed")).toEqual([2.1, 2.3, 1.8])
    expect(premiumHistoryFor(mixed, "NVDA")).toEqual([2.1, 2.3, 0.5, 1.8]) // no filter = all
  })
})

describe("usMarketRegime", () => {
  // June dates → America/New_York is EDT (UTC-4). Regular hours 9:30-16:00 ET.
  it("open on a weekday during regular hours", () => {
    // Mon 2026-06-08 15:00 UTC = 11:00 ET
    expect(usMarketRegime(new Date("2026-06-08T15:00:00Z"))).toBe("open")
  })

  it("closed after the bell on a weekday", () => {
    // Mon 2026-06-08 21:30 UTC = 17:30 ET
    expect(usMarketRegime(new Date("2026-06-08T21:30:00Z"))).toBe("closed")
  })

  it("closed before the open on a weekday", () => {
    // Mon 2026-06-08 12:00 UTC = 08:00 ET
    expect(usMarketRegime(new Date("2026-06-08T12:00:00Z"))).toBe("closed")
  })

  it("closed on weekends", () => {
    // Sat 2026-06-06 15:00 UTC = 11:00 ET, but Saturday
    expect(usMarketRegime(new Date("2026-06-06T15:00:00Z"))).toBe("closed")
  })

  it("boundary: 9:30 ET is open, 16:00 ET is closed", () => {
    // Mon 2026-06-08 13:30 UTC = 09:30 ET → open (inclusive)
    expect(usMarketRegime(new Date("2026-06-08T13:30:00Z"))).toBe("open")
    // Mon 2026-06-08 20:00 UTC = 16:00 ET → closed (exclusive)
    expect(usMarketRegime(new Date("2026-06-08T20:00:00Z"))).toBe("closed")
  })
})
