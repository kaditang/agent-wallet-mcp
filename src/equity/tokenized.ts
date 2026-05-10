// Tokenized equity issuer infrastructure.
//
// Reality check (2026-05): Dinari migrated production dShares to their own
// "Dinari Financial Network" (chain 98866). Base/Arbitrum/Ethereum addresses
// in their public deployments JSON are STAGING proxies — not seeded with
// real dShares right now. So a "buy NVDA" order constructed for Base today
// will revert at the OrderProcessor level. The architecture below is correct;
// settlement just waits for either (a) Dinari re-deploying on Base, (b) us
// bridging to DFN, or (c) us swapping to Backed/Aerodrome instead.
//
// Backed/xStocks live on Solana primarily; bCOIN trades on Aerodrome (Base).
// AMM-based path (Uniswap-style) is simpler than Dinari's OrderProcessor.

import type { Hex } from "viem"

// Canonical USDC on Base mainnet (Circle native).
export const USDC_BASE_MAINNET: Hex = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"

export type TokenizedListing = {
  issuer: "Backed" | "Dinari" | "Robinhood" | "Ondo"
  symbol: string
  network: string
  chainId: number
  /** assetToken address — ERC20 dShare or wrapped equity. Empty if not seeded. */
  address?: Hex
  kycRequired: boolean
  forUsPersons: boolean
  /** Settlement venue: an OrderProcessor (issuer-driven) or a DEX pool. */
  settlement:
    | { kind: "dinari-order-processor"; orderProcessor: Hex; factory: Hex }
    | { kind: "amm"; pool: Hex; router: Hex; routerKind: "uniswap-v3" | "aerodrome" | "uniswap-v2" }
    | { kind: "off-chain" }
  notes?: string
}

// Dinari OrderProcessor + Factory on chains we touch. Source:
// https://github.com/dinaricrypto/sbt-contracts/blob/main/releases/v1.0.0/order_processor.json
const DINARI = {
  baseSepolia: {
    orderProcessor: "0xC66aAC80b2a07d139F527743151790E0413D063f" as Hex,
    factory: "0x5405C077b4f15132039891545B224cEF90483809" as Hex,
  },
  baseMainnet: {
    orderProcessor: "0x5405C077b4f15132039891545B224cEF90483809" as Hex,
    factory: "0x4cdBd5A0938BE8c57DED76880f774db67dc915A9" as Hex,
  },
  ethereumMainnet: {
    orderProcessor: "0x5405C077b4f15132039891545B224cEF90483809" as Hex,
    factory: "0x4cdBd5A0938BE8c57DED76880f774db67dc915A9" as Hex,
  },
} as const

const MAP: Record<string, TokenizedListing[]> = {
  NVDA: [
    {
      issuer: "Dinari",
      symbol: "dNVDA",
      network: "base-sepolia",
      chainId: 84532,
      kycRequired: true,
      forUsPersons: false,
      settlement: { kind: "dinari-order-processor", ...DINARI.baseSepolia },
      notes: "Dinari staging on Base Sepolia — no real dShares seeded. For architecture validation only.",
    },
    {
      issuer: "Backed",
      symbol: "NVDAx",
      network: "solana",
      chainId: 0,
      kycRequired: false,
      forUsPersons: false,
      settlement: { kind: "off-chain" },
      notes: "Solana — primary venue for Backed xStocks. Not reachable from EVM stack.",
    },
  ],
  AAPL: [
    {
      issuer: "Dinari",
      symbol: "dAAPL",
      network: "base-sepolia",
      chainId: 84532,
      kycRequired: true,
      forUsPersons: false,
      settlement: { kind: "dinari-order-processor", ...DINARI.baseSepolia },
      notes: "Dinari staging — see NVDA notes.",
    },
    {
      issuer: "Backed",
      symbol: "AAPLx",
      network: "solana",
      chainId: 0,
      kycRequired: false,
      forUsPersons: false,
      settlement: { kind: "off-chain" },
    },
  ],
  COIN: [
    {
      issuer: "Backed",
      symbol: "wbCOIN",
      network: "base-mainnet",
      chainId: 8453,
      address: "0xdec933e2392ad908263e70a386fbf34e703ffe8f",
      kycRequired: false,
      forUsPersons: false,
      settlement: {
        kind: "amm",
        pool: "0x17c97dD8E434dcf91C9c838a8d10bc32230EF8b5",
        router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
        routerKind: "aerodrome",
      },
      notes: "Backed wbCOIN/USDC volatile pool on Aerodrome. Real but thin (~hundreds of wbCOIN circulating). Slippage will be material on small trades.",
    },
  ],
  TSLA: [
    {
      issuer: "Backed",
      symbol: "TSLAx",
      network: "solana",
      chainId: 0,
      kycRequired: false,
      forUsPersons: false,
      settlement: { kind: "off-chain" },
    },
  ],
  SPY: [
    {
      issuer: "Backed",
      symbol: "bCSPX",
      network: "base-mainnet",
      chainId: 8453,
      kycRequired: false,
      forUsPersons: false,
      settlement: { kind: "amm", pool: "0x0000000000000000000000000000000000000000", router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", routerKind: "aerodrome" },
      notes: "Tokenized S&P 500 ETF. Aerodrome pool TBD.",
    },
  ],
}

export function getTokenizedListings(ticker: string): TokenizedListing[] {
  return MAP[ticker.toUpperCase()] ?? []
}

/** Pick the best listing for a target chain. Prefers EVM chains we operate on. */
export function pickListingForChain(
  ticker: string,
  chainId: number,
): TokenizedListing | undefined {
  const all = getTokenizedListings(ticker)
  return all.find((l) => l.chainId === chainId)
}
