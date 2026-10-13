import { describe, expect, it } from "vitest"
import { assessSizeCost, extraCostBps } from "../../sol/size-cost.js"
import { isWeekendGap } from "../../sol/timing-signal.js"

describe("extraCostBps", () => {
  it("bps of the per-share price at size vs the reference", () => {
    // MCDx 2026-10-05: $100 → 0.42023913 raw, $50k → 208.16217461 raw.
    const ref = 100 / 0.42023913
    const big = 50_000 / 208.16217461
    expect(extraCostBps(big, ref)).toBeCloseTo(94, 0)
    expect(extraCostBps(ref, ref)).toBe(0)
  })
  it("null on missing/invalid prices", () => {
    expect(extraCostBps(0, 10)).toBeNull()
    expect(extraCostBps(10, NaN)).toBeNull()
  })
})

describe("assessSizeCost", () => {
  it("levels at the 10 / 50 bps thresholds", () => {
    expect(assessSizeCost(2, 10_000).level).toBe("negligible")
    expect(assessSizeCost(10, 10_000).level).toBe("moderate")
    expect(assessSizeCost(50, 10_000).level).toBe("moderate")
    expect(assessSizeCost(94, 50_000).level).toBe("high")
  })
  it("note states the size and the percentage", () => {
    expect(assessSizeCost(94, 50_000).note).toMatch(/\$50,000 costs ~0\.94% more/)
  })
})

describe("isWeekendGap (Sat, or Sun before 18:00 ET)", () => {
  // October 2026 → EDT (UTC-4).
  it("Saturday any time", () => {
    expect(isWeekendGap(new Date("2026-10-10T04:30:00Z"))).toBe(true) // Sat 00:30 ET
    expect(isWeekendGap(new Date("2026-10-11T03:00:00Z"))).toBe(true) // Sat 23:00 ET
  })
  it("Sunday until futures reopen at 18:00 ET", () => {
    expect(isWeekendGap(new Date("2026-10-11T21:59:00Z"))).toBe(true) // Sun 17:59 ET
    expect(isWeekendGap(new Date("2026-10-11T22:00:00Z"))).toBe(false) // Sun 18:00 ET
  })
  it("not on Friday evening or weekdays (Friday evening was not in the study)", () => {
    expect(isWeekendGap(new Date("2026-10-10T01:00:00Z"))).toBe(false) // Fri 21:00 ET
    expect(isWeekendGap(new Date("2026-10-12T15:00:00Z"))).toBe(false) // Mon 11:00 ET
  })
  it("EST winter dates use UTC-5", () => {
    // Sun 2026-01-11 22:30Z = 17:30 EST → still gap; 23:00Z = 18:00 EST → not.
    expect(isWeekendGap(new Date("2026-01-11T22:30:00Z"))).toBe(true)
    expect(isWeekendGap(new Date("2026-01-11T23:00:00Z"))).toBe(false)
  })
})
