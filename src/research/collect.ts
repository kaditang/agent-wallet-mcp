// Pure helpers for the research data collectors (scripts/snapshot-microstructure.ts).
// Research-only: nothing in the MCP service imports this.
//
// Two datasets, each in its own ndjson so the timing-signal loader's 3MB
// Range tail of microstructure.ndjson isn't diluted by bigger records:
//   cost-curve.ndjson — per xStock, Jupiter BUY quotes at several USDC sizes,
//                       every ~3h → "how much can I buy before slippage bites?"
//   yields.ndjson     — the whole risk-scored USDC/treasury pool universe,
//                       ~daily → later backtest: did the risk-adjusted ranking
//                       avoid pools whose yield collapsed?

import type { YieldEntry } from "../sol/yields.js"

/** USDC notional sizes for the cost curve. $100 is the near-zero-impact baseline. */
export const COST_CURVE_SIZES_USD = [100, 1_000, 10_000, 50_000] as const

/**
 * PURE: is a collector due? `lastT` is the ISO timestamp of the newest record
 * in its file (undefined = file empty/missing → due). Interval-based rather
 * than wall-clock-slot based, because GitHub's scheduled runs drift and skip.
 */
export function isDue(lastT: string | undefined, minIntervalMs: number, nowMs = Date.now()): boolean {
  if (!lastT) return true
  const last = Date.parse(lastT)
  if (!Number.isFinite(last)) return true
  return nowMs - last >= minIntervalMs
}

export type QuotePoint = { usd: number; outRaw: number | null; impactPct: number | null }

/**
 * PURE: extra cost (bps) of buying at each size vs the smallest size's price.
 * Uses RAW output for every size, so the xStock share multiplier cancels out
 * of the ratio (no need to know it here). null where a quote failed or the
 * baseline is missing.
 */
export function costBpsVsBaseline(points: QuotePoint[]): Record<string, number | null> {
  const ok = points.filter((p) => p.outRaw != null && p.outRaw > 0)
  const base = ok.length ? ok.reduce((a, b) => (a.usd <= b.usd ? a : b)) : undefined
  const out: Record<string, number | null> = {}
  for (const p of points) {
    if (!base || p.outRaw == null || p.outRaw <= 0) {
      out[String(p.usd)] = null
      continue
    }
    const pricePerRaw = p.usd / p.outRaw
    const basePrice = base.usd / base.outRaw!
    out[String(p.usd)] = Number(((pricePerRaw / basePrice - 1) * 10_000).toFixed(2))
  }
  return out
}

/** PURE: compact a scored pool for storage (riskNotes/note are derivable text). */
export function compactYield(e: YieldEntry) {
  return {
    id: e.poolId,
    p: e.protocol,
    c: e.chain,
    apy: e.apy,
    base: e.apyBase ?? null,
    rew: e.apyReward ?? null,
    tvl: Math.round(e.tvlUsd),
    radj: e.riskAdjustedApy,
    score: e.riskScore,
    f: e.riskFactors,
    x: e.executable,
  }
}

/**
 * PURE: newest record's timestamp from (the tail of) an ndjson body.
 * Matches the `{"t":"<iso>"` line prefix instead of JSON-parsing whole lines:
 * a daily yields record can exceed the tail chunk the script reads, so the
 * last line may be cut — but its prefix (records are written with `t` first)
 * is all we need. A chunk that starts mid-line simply doesn't match there.
 */
export function lastRecordT(ndjson: string): string | undefined {
  const lines = ndjson.trimEnd().split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\{"t":"([^"]+)"/.exec(lines[i])
    if (m && Number.isFinite(Date.parse(m[1]))) return m[1]
  }
  return undefined
}
