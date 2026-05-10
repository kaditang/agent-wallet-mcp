import YahooFinance from "yahoo-finance2"

// v3 requires an instance.
const yf: any = new (YahooFinance as any)()
yf.suppressNotices?.(["yahooSurvey"])

export type YahooQuote = {
  ticker: string
  name?: string
  price?: number
  currency?: string
  marketCap?: number
  trailingPE?: number
  forwardPE?: number
  fiftyTwoWeekLow?: number
  fiftyTwoWeekHigh?: number
  averageVolume?: number
  beta?: number
  exchange?: string
  sector?: string
  industry?: string
  asOf: string
}

export async function getYahooQuote(ticker: string): Promise<YahooQuote> {
  const quote: any = await yf.quote(ticker)
  let summary: any = null
  try {
    summary = await yf.quoteSummary(ticker, {
      modules: ["summaryDetail", "assetProfile", "defaultKeyStatistics"],
    })
  } catch {
    // optional, swallow
  }
  const sd = (summary as any)?.summaryDetail ?? {}
  const ap = (summary as any)?.assetProfile ?? {}
  const dks = (summary as any)?.defaultKeyStatistics ?? {}
  return {
    ticker: quote.symbol,
    name: quote.longName ?? quote.shortName,
    price: quote.regularMarketPrice,
    currency: quote.currency,
    marketCap: quote.marketCap,
    trailingPE: quote.trailingPE ?? sd.trailingPE,
    forwardPE: quote.forwardPE ?? sd.forwardPE,
    fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
    averageVolume: quote.averageDailyVolume3Month,
    beta: dks.beta ?? sd.beta,
    exchange: quote.fullExchangeName ?? quote.exchange,
    sector: ap.sector,
    industry: ap.industry,
    asOf: new Date().toISOString(),
  }
}
