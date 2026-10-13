// Size-aware execution cost for a tokenized-stock buy.
//
// A Jupiter quote at the user's size embeds that size's price impact. Comparing
// it with a small reference quote ($100) tells the user what the SIZE itself
// costs — research data (cost-curve.ndjson, 2026-10) shows a ~30x spread at
// $10k between deep pools (SPYx/TSLAx ~1-2 bps) and thin ones (PLTRx ~55-75,
// MCDx ~30-45). The reference price is also the right one to compare against
// the timing-signal history, which is built from impact-free reference prices.

export const REFERENCE_QUOTE_USD = 100
/** Below this size the main quote already IS a small-size quote — skip the extra call. */
export const SIZE_COST_MIN_USD = REFERENCE_QUOTE_USD * 2

export type SizeCostLevel = "negligible" | "moderate" | "high"

/**
 * PURE: extra cost (bps) of the user's size vs the reference size, from the
 * two per-share prices (any consistent unit — the share multiplier cancels).
 */
export function extraCostBps(pricePerShareAtSize: number, pricePerShareAtRef: number): number | null {
  if (!(pricePerShareAtSize > 0) || !(pricePerShareAtRef > 0)) return null
  return Number(((pricePerShareAtSize / pricePerShareAtRef - 1) * 10_000).toFixed(1))
}

/** PURE: classify + explain. Execution guidance, not investment advice. */
export function assessSizeCost(bps: number, amountUsd: number): { level: SizeCostLevel; note: string } {
  const usd = Math.round(amountUsd).toLocaleString("en-US")
  const pct = (bps / 100).toFixed(2)
  if (bps < 10) {
    return { level: "negligible", note: `Buying $${usd} costs ~${pct}% more per share than a $${REFERENCE_QUOTE_USD} buy — negligible.` }
  }
  if (bps <= 50) {
    return {
      level: "moderate",
      note: `Buying $${usd} costs ~${pct}% more per share than a $${REFERENCE_QUOTE_USD} buy (pool depth). Splitting into a few buys spread over time usually reduces this.`,
    }
  }
  return {
    level: "high",
    note: `Buying $${usd} costs ~${pct}% more per share than a $${REFERENCE_QUOTE_USD} buy — this pool is thin for that size. Consider a smaller size, or several smaller buys spread over hours or days.`,
  }
}
