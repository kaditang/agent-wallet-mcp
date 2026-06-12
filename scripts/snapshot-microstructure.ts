#!/usr/bin/env tsx
/**
 * Tokenized-stock microstructure snapshot.
 *
 * Captures, for every xStock in the registry:
 *   - xStock USD price (Jupiter reference price)
 *   - underlying US stock/ETF price (Stooq keyless CSV, Yahoo fallback)
 *   - premium/discount of the xStock vs the underlying
 *   - on-chain liquidity
 *   - US market state (open / after-hours / weekend)
 *
 * Appends one ndjson record per run to research/snapshots/microstructure.ndjson.
 *
 * This is a RESEARCH scaffold, not a product feature. The accumulating data
 * answers questions like: do xStocks trade at a weekend premium? how fast do
 * they price-in after-hours moves in the underlying? what's the typical
 * NAV premium/discount and how volatile is it?
 *
 * Run once:   npx tsx scripts/snapshot-microstructure.ts
 * Scheduled:  .github/workflows/snapshot.yml (every 2h, commits the result)
 */

import fs from "node:fs"
import path from "node:path"
import { XSTOCKS } from "../src/sol/tokens.js"
import { getLiveTokenMeta } from "../src/sol/jupiter-meta.js"
import { usMarketRegime } from "../src/sol/timing-signal.js"

const OUT_DIR = path.join(process.cwd(), "research", "snapshots")
const OUT_FILE = path.join(OUT_DIR, "microstructure.ndjson")

// --- underlying US price: Stooq (keyless CSV) primary, Yahoo fallback ---

async function stooqPrice(ticker: string): Promise<number | null> {
  try {
    // CSV columns: symbol,date,time,open,high,low,close,volume,name
    const url = `https://stooq.com/q/l/?s=${ticker.toLowerCase()}.us&f=sd2t2ohlcvn&h&e=csv`
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) })
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
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "Mozilla/5.0 (research-snapshot)" },
    })
    if (!r.ok) return null
    const j: any = await r.json()
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice
    return typeof p === "number" && p > 0 ? p : null
  } catch {
    return null
  }
}

async function underlyingPrice(
  ticker: string,
): Promise<{ price: number | null; src: string }> {
  const s = await stooqPrice(ticker)
  if (s != null) return { price: s, src: "stooq" }
  const y = await yahooPrice(ticker)
  if (y != null) return { price: y, src: "yahoo" }
  return { price: null, src: "none" }
}

// US equity market state. NYSE regular hours Mon-Fri 09:30-16:00 ET.
// MUST agree with usMarketRegime (timing-signal.ts) — the runtime signal
// matches the live regime against these stored labels, so a labeling skew
// (the old fixed-UTC-4 version was wrong by an hour every winter under EST)
// silently pollutes the regime-split baselines. Holidays still ignored
// (both sides, consistently); the precise timestamp is recorded so labels
// can be re-derived later if needed.
function usMarketState(
  now: Date,
): "open" | "closed-afterhours" | "closed-weekend" {
  if (usMarketRegime(now) === "open") return "open"
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(now)
  return wd === "Sat" || wd === "Sun" ? "closed-weekend" : "closed-afterhours"
}

async function main() {
  const now = new Date()
  const marketState = usMarketState(now)

  const entries = []
  for (const x of Object.values(XSTOCKS)) {
    const meta = await getLiveTokenMeta(x.mint).catch(() => null)
    const { price: underlying, src } = await underlyingPrice(x.ticker)
    const xPrice = meta?.usdPrice ?? null
    const premiumPct =
      xPrice != null && underlying != null && underlying > 0
        ? Number((((xPrice - underlying) / underlying) * 100).toFixed(4))
        : null
    entries.push({
      ticker: x.ticker,
      symbol: x.symbol,
      xStockUsd: xPrice,
      underlyingUsd: underlying,
      underlyingSrc: src,
      premiumPct,
      liquidityUsd: meta?.liquidityUsd ?? null,
    })
  }

  const record = { t: now.toISOString(), marketState, entries }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.appendFileSync(OUT_FILE, JSON.stringify(record) + "\n")

  // Console summary, sorted by premium descending.
  const withData = entries
    .filter((e) => e.premiumPct != null)
    .sort((a, b) => (b.premiumPct ?? 0) - (a.premiumPct ?? 0))
  console.log(`[snapshot] ${now.toISOString()}  market=${marketState}`)
  console.log(
    `[snapshot] ${withData.length}/${entries.length} tickers with both prices`,
  )
  for (const e of withData) {
    const sign = (e.premiumPct ?? 0) >= 0 ? "+" : ""
    console.log(
      `  ${e.ticker.padEnd(6)} xStock $${String(e.xStockUsd).padEnd(9)} ` +
        `real $${String(e.underlyingUsd).padEnd(9)} ` +
        `premium ${sign}${e.premiumPct}%`,
    )
  }
  console.log(`[snapshot] appended → ${OUT_FILE}`)
}

main().catch((e) => {
  console.error("[snapshot] failed:", e)
  process.exit(1)
})
