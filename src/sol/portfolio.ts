import { getBalances } from "./balances.js"
import { jupiterQuote } from "./jupiter.js"
import { SOL_USDC, XSTOCKS } from "./tokens.js"
import { YIELD_TOKENS } from "./yield-tokens.js"

export type PortfolioPosition = {
  ticker?: string
  symbol: string
  mint: string
  amount: number
  pricePerShareUsdc?: number
  valueUsdc?: number
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
): Promise<{ pricePerShareUsdc: number; valueUsdc: number } | { note: string }> {
  if (amount <= 0) return { note: "zero balance" }
  try {
    // Probe with 10% of holdings, capped to keep API spend small.
    const probeAtomic = BigInt(
      Math.max(1, Math.floor(amount * 0.1 * 10 ** decimals)),
    )
    const quote = await jupiterQuote({
      inputMint: mint,
      outputMint: SOL_USDC,
      amountAtomic: probeAtomic,
    })
    const probeShares = Number(probeAtomic) / 10 ** decimals
    const probeUsdc = Number(quote.outAmount) / 1_000_000
    const pricePerShareUsdc = probeShares > 0 ? probeUsdc / probeShares : 0
    return { pricePerShareUsdc, valueUsdc: pricePerShareUsdc * amount }
  } catch (e) {
    return { note: `pricing failed: ${(e as Error).message.slice(0, 80)}` }
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
