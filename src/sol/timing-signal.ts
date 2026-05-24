// "Best entry timing" signal for tokenized stocks.
//
// The microstructure snapshot pipeline (scripts/snapshot-microstructure.ts +
// the GitHub Action) accumulates xStock-vs-underlying premium/discount over
// time in research/snapshots/microstructure.ndjson. This module turns that
// history into a signal: is a given xStock's CURRENT premium unusually high
// (rich — consider waiting) or low (good entry) versus its own recent
// distribution?
//
// DATA SOURCE AT RUNTIME: the Fly image only ships dist/, not research/. So
// we fetch the ndjson from GitHub raw (where the Action commits it) with a
// 30-min cache. This decouples collection (Action → repo) from serving
// (Fly → reads raw GitHub). Falls back to "insufficient-history" on any
// fetch/parse failure — the signal is always advisory, never blocking.

const RAW_URL =
  "https://raw.githubusercontent.com/kaditang/agent-wallet-mcp/main/research/snapshots/microstructure.ndjson"
const CACHE_TTL_MS = 30 * 60 * 1000
// Need at least this many historical samples before the z-score is meaningful.
// At the 2h Action cadence that's ~1 day of data.
const MIN_SAMPLES = 12

export type TimingSignalKind =
  | "good-entry"
  | "fair"
  | "rich-wait"
  | "insufficient-history"

export type TimingSignal = {
  ticker: string
  currentPremiumPct: number | null
  trailingMeanPct: number | null
  trailingStdPct: number | null
  sampleCount: number
  /** Standard deviations the current premium sits above (+) / below (-) the trailing mean. */
  zScore: number | null
  signal: TimingSignalKind
  note: string
}

/**
 * PURE core: given the current premium and the trailing history of premiums
 * for a ticker, classify the entry timing. Unit-tested.
 */
export function computeTimingSignal(
  ticker: string,
  currentPremiumPct: number | null,
  history: number[],
): TimingSignal {
  const clean = history.filter((n) => Number.isFinite(n))
  if (currentPremiumPct == null || clean.length < MIN_SAMPLES) {
    return {
      ticker,
      currentPremiumPct,
      trailingMeanPct: null,
      trailingStdPct: null,
      sampleCount: clean.length,
      zScore: null,
      signal: "insufficient-history",
      note:
        currentPremiumPct == null
          ? "No live premium available."
          : `Only ${clean.length} historical samples (need ${MIN_SAMPLES}). Signal will sharpen as data accrues.`,
    }
  }

  const mean = clean.reduce((a, b) => a + b, 0) / clean.length
  const variance =
    clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length
  const std = Math.sqrt(variance)

  // If std is ~0 (premium has been flat), any deviation is noise — call it fair.
  const zScore = std > 1e-6 ? (currentPremiumPct - mean) / std : 0

  let signal: TimingSignalKind
  let note: string
  if (zScore <= -1) {
    signal = "good-entry"
    note = `Premium (${currentPremiumPct.toFixed(2)}%) is unusually LOW vs its ${clean.length}-sample average (${mean.toFixed(2)}%, z=${zScore.toFixed(1)}). Relatively cheap entry.`
  } else if (zScore >= 1) {
    signal = "rich-wait"
    note = `Premium (${currentPremiumPct.toFixed(2)}%) is unusually HIGH vs its ${clean.length}-sample average (${mean.toFixed(2)}%, z=${zScore.toFixed(1)}). You'd be paying above the typical markup — consider waiting.`
  } else {
    signal = "fair"
    note = `Premium (${currentPremiumPct.toFixed(2)}%) is near its ${clean.length}-sample average (${mean.toFixed(2)}%, z=${zScore.toFixed(1)}). Typical entry.`
  }

  return {
    ticker,
    currentPremiumPct: Number(currentPremiumPct.toFixed(4)),
    trailingMeanPct: Number(mean.toFixed(4)),
    trailingStdPct: Number(std.toFixed(4)),
    sampleCount: clean.length,
    zScore: Number(zScore.toFixed(2)),
    signal,
    note,
  }
}

// --- snapshot history loader (impure, cached) ---

type SnapshotRecord = {
  t: string
  marketState: string
  entries: { ticker: string; premiumPct: number | null }[]
}

let cache: { records: SnapshotRecord[]; fetchedAt: number } | null = null

async function loadSnapshots(): Promise<SnapshotRecord[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.records
  }
  try {
    const r = await fetch(RAW_URL, { signal: AbortSignal.timeout(8000) })
    if (!r.ok) throw new Error(`raw fetch ${r.status}`)
    const text = await r.text()
    const records: SnapshotRecord[] = []
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        // skip malformed line
      }
    }
    cache = { records, fetchedAt: Date.now() }
    return records
  } catch {
    // On failure, return whatever we have cached (even if stale) or empty.
    return cache?.records ?? []
  }
}

/** Extract the trailing premium history for one ticker from the snapshots. */
export function premiumHistoryFor(
  records: SnapshotRecord[],
  ticker: string,
): number[] {
  const out: number[] = []
  for (const rec of records) {
    const e = rec.entries?.find((x) => x.ticker === ticker)
    if (e && e.premiumPct != null && Number.isFinite(e.premiumPct)) {
      out.push(e.premiumPct)
    }
  }
  return out
}

/**
 * Full signal for a ticker: loads history (cached GitHub raw) and classifies
 * the given live premium against it. `currentPremiumPct` should be computed
 * live by the caller (live xStock price vs live underlying); if omitted we
 * fall back to the most recent snapshot's value.
 */
export async function getTimingSignal(
  ticker: string,
  currentPremiumPct?: number | null,
): Promise<TimingSignal> {
  const records = await loadSnapshots()
  const history = premiumHistoryFor(records, ticker)
  let current = currentPremiumPct ?? null
  if (current == null && history.length > 0) {
    current = history[history.length - 1] // latest snapshot as fallback
  }
  // Exclude the current value from the trailing baseline if it came from the
  // latest snapshot (don't compare a point against a window containing itself).
  const baseline =
    currentPremiumPct == null && history.length > 0
      ? history.slice(0, -1)
      : history
  return computeTimingSignal(ticker, current, baseline)
}

// --- live underlying price (for computing the CURRENT premium) ---
// Same sources as scripts/snapshot-microstructure.ts: Stooq keyless CSV
// primary, Yahoo fallback. Used by quote/portfolio tools to compute the live
// premium before classifying it against the snapshot history.

async function stooqPrice(ticker: string): Promise<number | null> {
  try {
    const url = `https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&f=sd2t2ohlcvn&h&e=csv`
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) })
    if (!r.ok) return null
    const lines = (await r.text()).trim().split("\n")
    if (lines.length < 2) return null
    const close = Number(lines[1].split(",")[6])
    return Number.isFinite(close) && close > 0 ? close : null
  } catch {
    return null
  }
}

async function yahooPrice(ticker: string): Promise<number | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`
    const r = await fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { "user-agent": "Mozilla/5.0 (autoyield)" },
    })
    if (!r.ok) return null
    const j: any = await r.json()
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice
    return typeof p === "number" && p > 0 ? p : null
  } catch {
    return null
  }
}

export async function fetchUnderlyingUsd(ticker: string): Promise<number | null> {
  return (await stooqPrice(ticker)) ?? (await yahooPrice(ticker))
}

/**
 * Convenience: given an xStock's live USD price, fetch the underlying,
 * compute the live premium, and classify against snapshot history.
 * Returns the signal plus the underlying price used (null if unavailable).
 */
export async function getTimingSignalForXStock(
  ticker: string,
  xStockPriceUsd: number,
): Promise<TimingSignal & { underlyingUsd: number | null }> {
  const underlying = await fetchUnderlyingUsd(ticker)
  const premiumPct =
    underlying != null && underlying > 0
      ? ((xStockPriceUsd - underlying) / underlying) * 100
      : null
  const signal = await getTimingSignal(ticker, premiumPct)
  return { ...signal, underlyingUsd: underlying }
}
