import { getBalances } from "./balances.js"
import { jupiterQuote } from "./jupiter.js"
import { getShareMultiplier, rawToShares, sharesToRaw, type ShareMultiplier } from "./share-multiplier.js"
import { SOL_USDC, XSTOCKS } from "./tokens.js"
import { YIELD_TOKENS } from "./yield-tokens.js"

export type PortfolioPosition = {
  ticker?: string
  symbol: string
  mint: string
  amount: number
  pricePerShareUsdc?: number
  valueUsdc?: number
  /** Shares per raw token (xStocks reinvested dividends). `amount` is already in shares. */
  shareMultiplier?: number
  note?: string
}

export type PortfolioSummary = {
  wallet: string
  asOf: string
  sol: number
  usdc: number
  xstocks: PortfolioPosition[]
  /** Tokenized treasuries / yield-bearing stables (USDY etc.). */
  yieldTokens: PortfolioPosition[]
  totalValueUsdc: number
  unsupportedToken2022Count: number
}

async function priceViaJupiter(
  mint: string,
  decimals: number,
  amount: number,
): Promise<{ pricePerShareUsdc: number; valueUsdc: number; shareMultiplier?: number; note?: string } | { note: string }> {
  if (amount <= 0) return { note: "zero balance" }
  // `amount` comes from getParsedTokenAccountsByOwner uiAmountString, which is in
  // SHARES (the RPC applies the Token-2022 scaled-UI multiplier). Jupiter quotes
  // RAW tokens. Before this conversion the probe price was per RAW token and was
  // then multiplied by a SHARE count — overstating a dividend payer's value by
  // its multiplier (SPYx +0.57%). See share-multiplier.ts.
  const mult: ShareMultiplier = await getShareMultiplier(mint)
  try {
    // Probe with 10% of holdings, capped to keep API spend small.
    const probeAtomic = BigInt(
      Math.max(1, Math.floor(sharesToRaw(amount * 0.1, mult.value) * 10 ** decimals)),
    )
    const quote = await jupiterQuote({
      inputMint: mint,
      outputMint: SOL_USDC,
      amountAtomic: probeAtomic,
    })
    const probeShares = rawToShares(Number(probeAtomic) / 10 ** decimals, mult.value)
    const probeUsdc = Number(quote.outAmount) / 1_000_000
    const pricePerShareUsdc = probeShares > 0 ? probeUsdc / probeShares : 0
    // A sub-cent probe can quote outAmount "0" → pricePerShareUsdc 0. That is a
    // PRICING FAILURE, not a real $0 holding: counting it as $0 would silently
    // drop the position from totalValueUsdc and the rebalance base. Mark it
    // unpriced instead so it surfaces rather than vanishing.
    if (quote.outAmount === "0" || pricePerShareUsdc <= 0) {
      return { note: "could not price (amount too small to quote)" }
    }
    return {
      pricePerShareUsdc,
      valueUsdc: pricePerShareUsdc * amount,
      ...(mult.status === "applied" ? { shareMultiplier: mult.value } : {}),
      // Say so when the multiplier could not be read — for a dividend payer the
      // value is then per raw token and reads up to ~0.6% high.
      ...(mult.status === "unavailable"
        ? { note: "share multiplier unreadable this call — value may read up to ~0.6% high for a dividend-paying xStock" }
        : {}),
    }
  } catch (e) {
    // Strip any URL — a Jupiter/RPC error can embed an endpoint with ?api-key=…
    const msg = (e as Error).message.replace(/https?:\/\/[^\s"']+/gi, "[url]")
    return { note: `pricing failed: ${msg.slice(0, 80)}` }
  }
}

/**
 * Compose a USD-denominated snapshot of a wallet:
 *   - SOL native balance (informational, not valued — we don't track SOL price here)
 *   - USDC at face value
 *   - Each held xStock priced via a Jupiter sell-quote (small probe size)
 *   - Each held yield token (USDY etc.) priced via Jupiter the same way
 */
export async function getPortfolio(walletAddress: string): Promise<PortfolioSummary> {
  const bal = await getBalances(walletAddress)

  // Price xStocks and yield tokens in parallel — each call is one Jupiter
  // request, and getBalances is the slow leg anyway.
  const [stockPositions, yieldPositions] = await Promise.all([
    Promise.all(
      bal.xstocks.map(async (x): Promise<PortfolioPosition> => {
        const stock = Object.values(XSTOCKS).find((s) => s.mint === x.mint)
        const base = {
          ticker: stock?.ticker ?? x.ticker,
          symbol: x.symbol,
          mint: x.mint,
          amount: x.amount,
        }
        if (!stock) return { ...base, note: "unknown xStock" }
        const r = await priceViaJupiter(stock.mint, stock.decimals, x.amount)
        return "valueUsdc" in r ? { ...base, ...r } : { ...base, note: r.note }
      }),
    ),
    Promise.all(
      bal.yieldTokens.map(async (y): Promise<PortfolioPosition> => {
        const yt = Object.values(YIELD_TOKENS).find((t) => t.mint === y.mint)
        const base = {
          symbol: y.symbol,
          mint: y.mint,
          amount: y.amount,
        }
        if (!yt) return { ...base, note: "unknown yield token" }
        const r = await priceViaJupiter(yt.mint, yt.decimals, y.amount)
        return "valueUsdc" in r ? { ...base, ...r } : { ...base, note: r.note }
      }),
    ),
  ])

  const positionsValue = (arr: PortfolioPosition[]) =>
    arr.reduce((s, p) => s + (p.valueUsdc ?? 0), 0)
  const totalValue =
    bal.usdc + positionsValue(stockPositions) + positionsValue(yieldPositions)

  return {
    wallet: walletAddress,
    asOf: new Date().toISOString(),
    sol: bal.sol,
    usdc: bal.usdc,
    xstocks: stockPositions,
    yieldTokens: yieldPositions,
    totalValueUsdc: totalValue,
    unsupportedToken2022Count: bal.otherToken2022.length,
  }
}
