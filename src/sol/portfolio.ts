import { getBalances } from "./balances.js"
import { jupiterQuote } from "./jupiter.js"
import { SOL_USDC, XSTOCKS } from "./tokens.js"

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
  totalValueUsdc: number
  unsupportedToken2022Count: number
}

/**
 * Compose a USD-denominated snapshot of a wallet:
 *   - SOL native balance (informational, not valued — we don't track SOL price here)
 *   - USDC at face value
 *   - Each held xStock priced via a Jupiter sell-quote (small probe size)
 */
export async function getPortfolio(walletAddress: string): Promise<PortfolioSummary> {
  const bal = await getBalances(walletAddress)

  const positions: PortfolioPosition[] = []
  for (const x of bal.xstocks) {
    const stock = Object.values(XSTOCKS).find((s) => s.mint === x.mint)
    if (!stock) {
      positions.push({ symbol: x.symbol, mint: x.mint, amount: x.amount, note: "unknown xStock" })
      continue
    }
    if (x.amount <= 0) continue
    try {
      // Probe with a small fraction of holdings to estimate fair price.
      const probeAtomic = BigInt(Math.max(1, Math.floor(x.amount * 0.1 * 10 ** stock.decimals)))
      const quote = await jupiterQuote({
        inputMint: stock.mint,
        outputMint: SOL_USDC,
        amountAtomic: probeAtomic,
      })
      const probeShares = Number(probeAtomic) / 10 ** stock.decimals
      const probeUsdc = Number(quote.outAmount) / 1_000_000
      const pricePerShare = probeShares > 0 ? probeUsdc / probeShares : 0
      positions.push({
        ticker: stock.ticker,
        symbol: stock.symbol,
        mint: stock.mint,
        amount: x.amount,
        pricePerShareUsdc: pricePerShare,
        valueUsdc: pricePerShare * x.amount,
      })
    } catch (e) {
      positions.push({
        ticker: stock.ticker,
        symbol: stock.symbol,
        mint: stock.mint,
        amount: x.amount,
        note: `pricing failed: ${(e as Error).message.slice(0, 80)}`,
      })
    }
  }

  const totalValue =
    bal.usdc +
    positions.reduce((s, p) => s + (p.valueUsdc ?? 0), 0)

  return {
    wallet: walletAddress,
    asOf: new Date().toISOString(),
    sol: bal.sol,
    usdc: bal.usdc,
    xstocks: positions,
    totalValueUsdc: totalValue,
    unsupportedToken2022Count: bal.otherToken2022.length,
  }
}
