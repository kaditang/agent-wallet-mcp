import { describe, it, expect } from "vitest"
import { computeRebalance } from "../../sol/rebalance.js"

describe("computeRebalance", () => {
  it("suggests buy/sell to move a 70/30 portfolio to 60/40", () => {
    // $70 NVDA + $30 USDY = $100 total. Target 60/40 → NVDA $60, USDY $40.
    const plan = computeRebalance(
      [
        { asset: "NVDA", valueUsd: 70 },
        { asset: "USDY", valueUsd: 30 },
      ],
      [
        { asset: "NVDA", percent: 60 },
        { asset: "USDY", percent: 40 },
      ],
    )
    expect(plan.totalUsd).toBe(100)
    const nvda = plan.actions.find((a) => a.asset === "NVDA")!
    const usdy = plan.actions.find((a) => a.asset === "USDY")!
    expect(nvda.action).toBe("sell")
    expect(nvda.deltaUsd).toBe(-10) // sell $10 NVDA
    expect(usdy.action).toBe("buy")
    expect(usdy.deltaUsd).toBe(10) // buy $10 USDY
  })

  it("holds when already within the drift threshold", () => {
    // 61/39 vs 60/40 target → 1% drift, under the default 3% threshold.
    const plan = computeRebalance(
      [
        { asset: "NVDA", valueUsd: 61 },
        { asset: "USDY", valueUsd: 39 },
      ],
      [
        { asset: "NVDA", percent: 60 },
        { asset: "USDY", percent: 40 },
      ],
    )
    expect(plan.actions.every((a) => a.action === "hold")).toBe(true)
    expect(plan.notes.some((n) => /no rebalance needed/i.test(n))).toBe(true)
  })

  it("sells down a held asset that's not in the target", () => {
    const plan = computeRebalance(
      [
        { asset: "TSLA", valueUsd: 50 },
        { asset: "USDC", valueUsd: 50 },
      ],
      [{ asset: "USDC", percent: 100 }],
    )
    const tsla = plan.actions.find((a) => a.asset === "TSLA")!
    expect(tsla.action).toBe("sell")
    expect(tsla.targetPct).toBe(0)
    expect(tsla.deltaUsd).toBe(-50)
    expect(plan.notes.some((n) => /TSLA.*not in your target/i.test(n))).toBe(true)
  })

  it("warns when targets don't sum to 100", () => {
    const plan = computeRebalance(
      [{ asset: "NVDA", valueUsd: 100 }],
      [
        { asset: "NVDA", percent: 50 },
        { asset: "USDY", percent: 30 },
      ],
    )
    expect(plan.targetsSumPct).toBe(80)
    expect(plan.notes.some((n) => /sum to 80%/i.test(n))).toBe(true)
  })

  it("suppresses dust trades below minTradeUsd", () => {
    // $100.50 NVDA vs target that implies a ~$0.50 sell — under minTradeUsd $1.
    const plan = computeRebalance(
      [
        { asset: "NVDA", valueUsd: 100.5 },
        { asset: "USDY", valueUsd: 99.5 },
      ],
      [
        { asset: "NVDA", percent: 50 },
        { asset: "USDY", percent: 50 },
      ],
      { minTradeUsd: 5, driftThresholdPct: 0 },
    )
    // delta is ~$0.50, under the $5 minTrade → hold despite drift.
    expect(plan.actions.every((a) => a.action === "hold")).toBe(true)
  })

  it("empty / zero-value portfolio degrades gracefully", () => {
    const plan = computeRebalance([], [{ asset: "NVDA", percent: 100 }])
    expect(plan.totalUsd).toBe(0)
    expect(plan.actions).toHaveLength(0)
    expect(plan.notes.some((n) => /no USD-valued positions/i.test(n))).toBe(true)
  })
})
