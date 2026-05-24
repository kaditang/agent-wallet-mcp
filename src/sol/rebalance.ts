// Rebalance planner — "discipline enforcement", one of the three core V1
// value drivers. Given a wallet's current positions (USD-valued) and a target
// allocation, compute the trades that close the gap. READ-ONLY: it suggests;
// the user executes via the build_*_tx tools and signs in their own wallet.
//
// Pure core (computeRebalance) is unit-tested; the tool handler wires it to
// get_portfolio.

export type RebalanceTarget = { asset: string; percent: number }
export type CurrentPosition = { asset: string; valueUsd: number }

export type RebalanceAction = {
  asset: string
  currentPct: number
  targetPct: number
  /** currentPct − targetPct (positive = over-weight, negative = under-weight). */
  driftPct: number
  currentUsd: number
  targetUsd: number
  /** targetUsd − currentUsd: positive = buy this much, negative = sell. */
  deltaUsd: number
  action: "buy" | "sell" | "hold"
}

export type RebalancePlan = {
  totalUsd: number
  targetsSumPct: number
  actions: RebalanceAction[]
  notes: string[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Compute the rebalance plan.
 * - `positions`: everything that counts toward the allocation base (xStocks +
 *   yield tokens + USDC cash). Exclude SOL (gas reserve) upstream.
 * - `targets`: desired allocation; percents should sum to ~100.
 * - Held assets NOT in `targets` get an implicit target of 0% → suggested
 *   sold down (flagged in notes).
 * - `minTradeUsd` / `driftThresholdPct`: suppress dust trades and noise — an
 *   asset only gets a buy/sell action if BOTH the dollar delta exceeds
 *   minTradeUsd AND the drift exceeds driftThresholdPct.
 */
export function computeRebalance(
  positions: CurrentPosition[],
  targets: RebalanceTarget[],
  opts?: { minTradeUsd?: number; driftThresholdPct?: number },
): RebalancePlan {
  const minTradeUsd = opts?.minTradeUsd ?? 1
  const driftThresholdPct = opts?.driftThresholdPct ?? 3

  const posMap = new Map<string, number>()
  for (const p of positions) {
    posMap.set(p.asset.toUpperCase(), (posMap.get(p.asset.toUpperCase()) ?? 0) + p.valueUsd)
  }
  const totalUsd = positions.reduce((s, p) => s + (p.valueUsd > 0 ? p.valueUsd : 0), 0)

  const targetsSumPct = round2(targets.reduce((s, t) => s + t.percent, 0))
  const notes: string[] = []
  if (Math.abs(targetsSumPct - 100) > 1) {
    notes.push(
      `Target percentages sum to ${targetsSumPct}%, not 100%. Plan is computed proportionally against the actual total, but double-check your targets.`,
    )
  }
  if (totalUsd <= 0) {
    notes.push("Portfolio has no USD-valued positions to rebalance.")
    return { totalUsd: 0, targetsSumPct, actions: [], notes }
  }

  // Union of target assets + currently-held assets (held-but-untargeted → 0%).
  const targetMap = new Map<string, number>()
  for (const t of targets) targetMap.set(t.asset.toUpperCase(), t.percent)
  const allAssets = new Set<string>([...targetMap.keys(), ...posMap.keys()])

  const actions: RebalanceAction[] = []
  for (const asset of allAssets) {
    const currentUsd = posMap.get(asset) ?? 0
    const targetPct = targetMap.get(asset) ?? 0
    const currentPct = (currentUsd / totalUsd) * 100
    const targetUsd = (targetPct / 100) * totalUsd
    const deltaUsd = targetUsd - currentUsd
    const driftPct = currentPct - targetPct

    let action: "buy" | "sell" | "hold" = "hold"
    if (Math.abs(deltaUsd) >= minTradeUsd && Math.abs(driftPct) >= driftThresholdPct) {
      action = deltaUsd > 0 ? "buy" : "sell"
    }

    actions.push({
      asset,
      currentPct: round2(currentPct),
      targetPct: round2(targetPct),
      driftPct: round2(driftPct),
      currentUsd: round2(currentUsd),
      targetUsd: round2(targetUsd),
      deltaUsd: round2(deltaUsd),
      action,
    })
  }

  // Largest absolute trades first — most impactful actions on top.
  actions.sort((a, b) => Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd))

  for (const a of actions) {
    if (a.action === "sell" && !targetMap.has(a.asset)) {
      notes.push(
        `${a.asset} is held (${a.currentPct}%) but not in your target — plan sells it down to 0.`,
      )
    }
  }
  if (actions.every((a) => a.action === "hold")) {
    notes.push(
      `Already within ${driftThresholdPct}% of target on every asset — no rebalance needed. Hold.`,
    )
  }

  return { totalUsd: round2(totalUsd), targetsSumPct, actions, notes }
}
