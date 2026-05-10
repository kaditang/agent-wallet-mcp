// Backed xStocks (Solana) — verified mints with real Jupiter liquidity.
// Source: https://lite-api.jup.ag/tokens/v2/search + per-mint $1 USDC route probe.
// All Token-2022 standard. Liquidity values are point-in-time snapshots — for
// live numbers see `getLiveTokenMeta` in jupiter-meta.ts (5 min cache).
//
// Coverage rule: include any Backed xStock with > $20k Jupiter liquidity AND a
// working USDC swap route. Tickers below that threshold (e.g. VTIx $900,
// AMDx $2.5k, BMNRx $845 as of 2026-05-10) are excluded — buy_xstock would
// fail liquidity sanity check anyway. When Backed re-seeds those pools,
// re-add here.

export const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

export type XStock = {
  ticker: string
  symbol: string // on-chain symbol
  mint: string
  decimals: number
  liquidityUsd: number
  /** Plain-language name the AI can surface to the user. */
  name: string
  /** Coarse category — lets `compare_yields` / `list_xstocks` group/filter. */
  category:
    | "mega-cap-tech"
    | "crypto-equity"
    | "broad-market-etf"
    | "commodity-etf"
    | "consumer"
    | "ai-defense"
}

// Snapshot of all currently-tradable Backed xStocks on Solana (2026-05-10).
export const XSTOCKS: Record<string, XStock> = {
  // ---------------- mega-cap tech ----------------
  NVDA: {
    ticker: "NVDA",
    symbol: "NVDAx",
    mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    decimals: 8,
    liquidityUsd: 2_280_000,
    name: "NVIDIA Corporation",
    category: "mega-cap-tech",
  },
  AAPL: {
    ticker: "AAPL",
    symbol: "AAPLx",
    mint: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    decimals: 8,
    liquidityUsd: 339_000,
    name: "Apple Inc.",
    category: "mega-cap-tech",
  },
  TSLA: {
    ticker: "TSLA",
    symbol: "TSLAx",
    mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    decimals: 8,
    liquidityUsd: 2_207_000,
    name: "Tesla Inc.",
    category: "mega-cap-tech",
  },
  MSFT: {
    ticker: "MSFT",
    symbol: "MSFTx",
    mint: "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX",
    decimals: 8,
    liquidityUsd: 93_000,
    name: "Microsoft Corporation",
    category: "mega-cap-tech",
  },
  GOOGL: {
    ticker: "GOOGL",
    symbol: "GOOGLx",
    mint: "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN",
    decimals: 8,
    liquidityUsd: 423_000,
    name: "Alphabet Inc. (Class A)",
    category: "mega-cap-tech",
  },
  AMZN: {
    ticker: "AMZN",
    symbol: "AMZNx",
    mint: "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg",
    decimals: 8,
    liquidityUsd: 247_000,
    name: "Amazon.com Inc.",
    category: "mega-cap-tech",
  },
  META: {
    ticker: "META",
    symbol: "METAx",
    mint: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu",
    decimals: 8,
    liquidityUsd: 221_000,
    name: "Meta Platforms Inc.",
    category: "mega-cap-tech",
  },

  // ---------------- crypto-adjacent equities ----------------
  // These are popular with crypto-native users because they're "TradFi access
  // to crypto exposure" — buy MSTR for leveraged BTC, COIN for exchange beta.
  COIN: {
    ticker: "COIN",
    symbol: "COINx",
    mint: "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu",
    decimals: 8,
    liquidityUsd: 666_000,
    name: "Coinbase Global Inc.",
    category: "crypto-equity",
  },
  MSTR: {
    ticker: "MSTR",
    symbol: "MSTRx",
    mint: "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ",
    decimals: 8,
    liquidityUsd: 1_069_000,
    name: "MicroStrategy Inc. (Bitcoin treasury proxy)",
    category: "crypto-equity",
  },
  HOOD: {
    ticker: "HOOD",
    symbol: "HOODx",
    mint: "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg",
    decimals: 8,
    liquidityUsd: 522_000,
    name: "Robinhood Markets Inc.",
    category: "crypto-equity",
  },
  CRCL: {
    ticker: "CRCL",
    symbol: "CRCLx",
    mint: "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1",
    decimals: 8,
    liquidityUsd: 2_587_000,
    name: "Circle Internet Group (USDC issuer)",
    category: "crypto-equity",
  },

  // ---------------- broad-market ETFs ----------------
  SPY: {
    ticker: "SPY",
    symbol: "SPYx",
    mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    decimals: 8,
    liquidityUsd: 3_063_000,
    name: "SPDR S&P 500 ETF (US large-cap)",
    category: "broad-market-etf",
  },
  QQQ: {
    ticker: "QQQ",
    symbol: "QQQx",
    mint: "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ",
    decimals: 8,
    liquidityUsd: 2_409_000,
    name: "Invesco QQQ (Nasdaq-100)",
    category: "broad-market-etf",
  },

  // ---------------- commodity ETFs ----------------
  GLD: {
    ticker: "GLD",
    symbol: "GLDx",
    mint: "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re",
    decimals: 8,
    liquidityUsd: 341_000,
    name: "SPDR Gold Shares (physical gold ETF)",
    category: "commodity-etf",
  },

  // ---------------- consumer staples ----------------
  MCD: {
    ticker: "MCD",
    symbol: "MCDx",
    mint: "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2",
    decimals: 8,
    liquidityUsd: 23_000,
    name: "McDonald's Corporation",
    category: "consumer",
  },

  // ---------------- AI / defense ----------------
  PLTR: {
    ticker: "PLTR",
    symbol: "PLTRx",
    mint: "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4",
    decimals: 8,
    liquidityUsd: 47_000,
    name: "Palantir Technologies Inc.",
    category: "ai-defense",
  },
}

export function findXStock(ticker: string): XStock | undefined {
  return XSTOCKS[ticker.toUpperCase()]
}
