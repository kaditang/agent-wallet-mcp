import { describe, expect, it } from "vitest"
import { scoreYield } from "../../sol/yield-score.js"

describe("scoreYield", () => {
  it("a deep, low-risk, base-rate pool keeps almost all its APY", () => {
    const s = scoreYield({
      apy: 6,
      apyBase: 6,
      tvlUsd: 200_000_000,
      sigma: 0.5,
      predictedClass: "Stable/Up",
      predictedProbability: 0.9,
      outlier: false,
      ilRisk: "no",
      protocolRisk: "low",
    })
    expect(s.riskScore).toBeGreaterThan(85)
    expect(s.riskAdjustedApy).toBeGreaterThan(5)
    expect(s.riskNotes).toHaveLength(0)
  })

  it("a high-APY reward-farm on a thin pool gets heavily discounted", () => {
    const s = scoreYield({
      apy: 40,
      apyBase: 2, // 95% of yield is reward emissions
      apyReward: 38,
      tvlUsd: 150_000,
      sigma: 25, // very volatile
      predictedClass: "Down",
      predictedProbability: 0.8,
      outlier: false,
      ilRisk: "yes",
      protocolRisk: "high",
    })
    expect(s.riskScore).toBeLessThan(40)
    // 40% headline must fall well below its face value after discounting.
    expect(s.riskAdjustedApy).toBeLessThan(15)
    expect(s.riskNotes.length).toBeGreaterThanOrEqual(4)
  })

  it("RANKING FLIP: a safe 6% out-ranks a risky 12% on risk-adjusted APY", () => {
    const safe6 = scoreYield({
      apy: 6,
      apyBase: 6,
      tvlUsd: 200_000_000,
      sigma: 0.4,
      predictedClass: "Stable/Up",
      ilRisk: "no",
      protocolRisk: "low",
    })
    const risky12 = scoreYield({
      apy: 12,
      apyBase: 1,
      apyReward: 11,
      tvlUsd: 300_000,
      sigma: 9,
      predictedClass: "Down",
      predictedProbability: 0.7,
      ilRisk: "yes",
      protocolRisk: "high",
    })
    // The whole thesis: headline 12% > 6% (inputs), but risk-adjusted flips it.
    expect(12).toBeGreaterThan(6)
    expect(safe6.riskAdjustedApy).toBeGreaterThan(risky12.riskAdjustedApy)
  })

  it("outlier flag halves the composite", () => {
    const base = {
      apy: 8,
      apyBase: 8,
      tvlUsd: 50_000_000,
      sigma: 1,
      predictedClass: "Stable/Up",
      ilRisk: "no",
      protocolRisk: "low" as const,
    }
    const clean = scoreYield({ ...base, outlier: false })
    const flagged = scoreYield({ ...base, outlier: true })
    expect(flagged.riskAdjustedApy).toBeCloseTo(clean.riskAdjustedApy * 0.5, 1)
    expect(flagged.riskNotes).toContain(
      "flagged as a statistical outlier — treat with suspicion",
    )
  })

  it("large deposit relative to TVL adds a liquidity discount", () => {
    const signals = {
      apy: 7,
      apyBase: 7,
      tvlUsd: 1_000_000,
      sigma: 1,
      predictedClass: "Stable/Up",
      ilRisk: "no",
      protocolRisk: "low" as const,
    }
    const small = scoreYield(signals, 1_000) // 0.1% of pool
    const huge = scoreYield(signals, 200_000) // 20% of pool
    expect(huge.riskFactors.liquidity).toBeLessThan(small.riskFactors.liquidity)
  })

  it("missing signals degrade gracefully (no NaN, factors stay in range)", () => {
    const s = scoreYield({ apy: 5, tvlUsd: 2_000_000 })
    expect(Number.isFinite(s.riskAdjustedApy)).toBe(true)
    expect(Number.isFinite(s.riskScore)).toBe(true)
    for (const f of Object.values(s.riskFactors)) {
      expect(f).toBeGreaterThan(0)
      expect(f).toBeLessThanOrEqual(1)
    }
  })
})
