// Backed xStocks (Solana) — verified mints with real Jupiter liquidity
// Source: https://lite-api.jup.ag/tokens/v2/search (queried 2026-05-07)
// All Token-2022 standard.

export const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

export type XStock = {
  ticker: string
  symbol: string // on-chain symbol
  mint: string
  decimals: number
  liquidityUsd: number
}

// Snapshot of major xStocks. Liquidity values are point-in-time (2026-05-07).
// Refresh via Jupiter token search if needed.
export const XSTOCKS: Record<string, XStock> = {
  NVDA: {
    ticker: "NVDA",
    symbol: "NVDAx",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    decimals: 8,
    liquidityUsd: 2_080_000,
  },
  AAPL: {
    ticker: "AAPL",
    symbol: "AAPLx",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    decimals: 8,
    liquidityUsd: 339_000,
  },
  TSLA: {
    ticker: "TSLA",
    symbol: "TSLAx",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    decimals: 8,
    liquidityUsd: 2_207_000,
  },
  SPY: {
    ticker: "SPY",
    symbol: "SPYx",
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    decimals: 8,
    liquidityUsd: 3_063_000,
  },
}

export function findXStock(ticker: string): XStock | undefined {
  return XSTOCKS[ticker.toUpperCase()]
}
