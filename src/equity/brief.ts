import { getYahooQuote, type YahooQuote } from "./yahoo.js"
import { getRecentFilings, type Filing } from "./edgar.js"
import { getTokenizedListings, type TokenizedListing } from "./tokenized.js"

export type EquityBrief = {
  ticker: string
  fundamentals: YahooQuote
  recentFilings: Filing[]
  tokenized: TokenizedListing[]
  signals: {
    nearFiftyTwoWeekHigh: boolean
    nearFiftyTwoWeekLow: boolean
    valuationFlag: "premium" | "normal" | "cheap" | "unknown"
    hasRecentEarnings: boolean
  }
  asOf: string
}

export async function buildEquityBrief(ticker: string): Promise<EquityBrief> {
  const T = ticker.toUpperCase()
  const [fundamentals, recentFilings] = await Promise.all([
    getYahooQuote(T),
    getRecentFilings(T).catch(() => []),
  ])
  const tokenized = getTokenizedListings(T)

  const price = fundamentals.price ?? 0
  const lo = fundamentals.fiftyTwoWeekLow ?? 0
  const hi = fundamentals.fiftyTwoWeekHigh ?? 0
  const range = hi - lo
  const nearHigh = range > 0 && hi - price < range * 0.05
  const nearLow = range > 0 && price - lo < range * 0.05

  let valuationFlag: EquityBrief["signals"]["valuationFlag"] = "unknown"
  const fpe = fundamentals.forwardPE
  if (typeof fpe === "number") {
    if (fpe > 35) valuationFlag = "premium"
    else if (fpe < 15) valuationFlag = "cheap"
    else valuationFlag = "normal"
  }

  const hasRecentEarnings = recentFilings.some(
    (f) =>
      (f.form === "10-Q" || f.form === "10-K") &&
      Date.now() - new Date(f.filedAt).getTime() < 1000 * 60 * 60 * 24 * 60,
  )

  return {
    ticker: T,
    fundamentals,
    recentFilings,
    tokenized,
    signals: {
      nearFiftyTwoWeekHigh: nearHigh,
      nearFiftyTwoWeekLow: nearLow,
      valuationFlag,
      hasRecentEarnings,
    },
    asOf: new Date().toISOString(),
  }
}
