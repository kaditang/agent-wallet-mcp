import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  parseUnits,
  type Hex,
} from "viem"
import { base } from "viem/chains"

// Aerodrome (Solidly fork on Base) — mainnet only.
export const AERODROME = {
  router: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43" as Hex,
  factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as Hex,
}

// We always read mainnet state for Aerodrome regardless of the backend's
// configured chain — propose tools must be able to inspect mainnet liquidity
// even when the agent currently operates on Sepolia.
const baseClient = createPublicClient({
  chain: base,
  transport: http("https://mainnet.base.org"),
})

const routerAbi = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[])",
  "function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[])",
])

const factoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, bool stable) view returns (address)",
])

export type AerodromeQuote = {
  amountIn: bigint
  amountOut: bigint
  pool: Hex
  stable: boolean
  liquidityWarning?: string
}

/** Quote a swap from USDC → outputToken on Base mainnet via Aerodrome. */
export async function quoteUsdcSwap(opts: {
  usdcMainnet: Hex
  outputToken: Hex
  amountUsdc: string
}): Promise<AerodromeQuote> {
  const amountIn = parseUnits(opts.amountUsdc, 6)

  // Try volatile pool first (typical for tokenized stocks); fall back to stable.
  let stable = false
  let pool = (await baseClient.readContract({
    address: AERODROME.factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [opts.usdcMainnet, opts.outputToken, false],
  })) as Hex
  if (pool === "0x0000000000000000000000000000000000000000") {
    stable = true
    pool = (await baseClient.readContract({
      address: AERODROME.factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [opts.usdcMainnet, opts.outputToken, true],
    })) as Hex
  }
  if (pool === "0x0000000000000000000000000000000000000000") {
    throw new Error("no aerodrome pool for this pair")
  }

  const amounts = (await baseClient.readContract({
    address: AERODROME.router,
    abi: routerAbi,
    functionName: "getAmountsOut",
    args: [
      amountIn,
      [{ from: opts.usdcMainnet, to: opts.outputToken, stable, factory: AERODROME.factory }],
    ],
  })) as bigint[]
  const amountOut = amounts[amounts.length - 1]

  // Heuristic: if 1 USDC quote in output token implies more than 50% slippage
  // off a "fair" reading, flag it. We don't have an oracle here, so we just
  // surface the raw output and let the LLM decide.
  let liquidityWarning: string | undefined
  if (amountOut === 0n) {
    liquidityWarning = "pool returns zero output — liquidity exhausted or stale"
  }

  return { amountIn, amountOut, pool, stable, liquidityWarning }
}

/**
 * Build approve + swapExactTokensForTokens for USDC -> outputToken.
 * minAmountOut should be set with slippage cap by the caller.
 */
export function buildAerodromeBuyCalls(opts: {
  recipient: Hex
  usdcMainnet: Hex
  outputToken: Hex
  amountUsdc: string
  minAmountOut: bigint
  stable: boolean
  deadlineSec?: number
}) {
  const amountIn = parseUnits(opts.amountUsdc, 6)
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts.deadlineSec ?? 600))

  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [AERODROME.router, amountIn],
  })

  const swapData = encodeFunctionData({
    abi: routerAbi,
    functionName: "swapExactTokensForTokens",
    args: [
      amountIn,
      opts.minAmountOut,
      [
        {
          from: opts.usdcMainnet,
          to: opts.outputToken,
          stable: opts.stable,
          factory: AERODROME.factory,
        },
      ],
      opts.recipient,
      deadline,
    ],
  })

  return [
    { to: opts.usdcMainnet, data: approveData, value: 0n },
    { to: AERODROME.router, data: swapData, value: 0n },
  ]
}
