// Global (all-callers) per-minute budgets for tools that spend paid upstream
// quota — our primary Solana RPC (shared with the full edition's sign and
// broadcast flow), Jupiter and the StockWaves gate.
//
// Per-IP limits don't bound this: /research needs no login, Claude.ai traffic
// shares egress IPs (so per-IP limits must be generous), and one HTTP request
// can carry a JSON-RPC batch. export_history alone can cost 1 + 200 RPC calls.
// Budgets are kept per edition, so research traffic can never use up the full
// edition's share. Over budget → a short "busy, retry in a minute" error.

import type { Edition } from "./metrics.js"

const WINDOW_MS = 60_000

/** Calls per minute, per edition, summed over every caller. */
const BUDGETS: Record<string, { group: string; perMin: number }> = {
  export_history: { group: "history", perMin: 20 }, // ≤ 201 RPC calls each
  get_portfolio: { group: "wallet", perMin: 300 },
  portfolio_health: { group: "wallet", perMin: 300 },
  suggest_rebalance: { group: "wallet", perMin: 300 },
  track_tx: { group: "wallet", perMin: 300 },
  quote_tokenized_stock: { group: "market", perMin: 300 },
  check_xstock_safety: { group: "market", perMin: 300 },
  build_buy_xstock_tx: { group: "build", perMin: 120 },
  build_sell_xstock_tx: { group: "build", perMin: 120 },
  build_deposit_yield_tx: { group: "build", perMin: 120 },
  build_withdraw_yield_tx: { group: "build", perMin: 120 },
}

const hits = new Map<string, number[]>() // `${edition}:${group}` → call timestamps

/** Record a call if the budget allows it. false = over budget, do not run the tool. */
export function takeBudget(edition: Edition, tool: string, now = Date.now()): boolean {
  const b = BUDGETS[tool]
  if (!b) return true // cheap / cached tools (compare_yields, list_*) are unbudgeted
  const key = `${edition}:${b.group}`
  const arr = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (arr.length >= b.perMin) {
    hits.set(key, arr)
    return false
  }
  arr.push(now)
  hits.set(key, arr)
  return true
}

/** Test hook. */
export function _resetBudgets() {
  hits.clear()
}
