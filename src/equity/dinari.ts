import {
  encodeFunctionData,
  erc20Abi,
  parseAbi,
  parseUnits,
  type Hex,
} from "viem"
import { publicClient } from "../kernel.js"
import { USDC } from "../config.js"

// IOrderProcessor.Order — see
// https://github.com/dinaricrypto/sbt-contracts/blob/main/releases/v1.0.0/order_processor.json
export type Order = {
  requestTimestamp: bigint
  recipient: Hex
  assetToken: Hex
  paymentToken: Hex
  sell: boolean
  orderType: number // 0 = MARKET, 1 = LIMIT
  assetTokenQuantity: bigint
  paymentTokenQuantity: bigint
  price: bigint
  tif: number // 0 = DAY, 1 = GTC, 2 = IOC, 3 = FOK
}

const orderProcessorAbi = parseAbi([
  "function createOrderStandardFees((uint64 requestTimestamp,address recipient,address assetToken,address paymentToken,bool sell,uint8 orderType,uint256 assetTokenQuantity,uint256 paymentTokenQuantity,uint256 price,uint8 tif)) returns (uint256)",
])

const factoryAbi = parseAbi([
  "function getDShares() view returns (address[], address[])",
])

const dShareAbi = parseAbi([
  "function symbol() view returns (string)",
])

/**
 * Try to find the dShare token address for a ticker on a given chain by
 * querying the factory. Returns undefined if factory is unconfigured/empty.
 */
export async function findDShareAddress(
  factory: Hex,
  ticker: string,
): Promise<Hex | undefined> {
  let dshares: readonly Hex[]
  try {
    const result = (await publicClient.readContract({
      address: factory,
      abi: factoryAbi,
      functionName: "getDShares",
    })) as [readonly Hex[], readonly Hex[]]
    dshares = result[0]
  } catch {
    return undefined
  }
  for (const addr of dshares) {
    try {
      const sym = (await publicClient.readContract({
        address: addr,
        abi: dShareAbi,
        functionName: "symbol",
      })) as string
      const norm = sym.replace(/^d/i, "").toUpperCase()
      if (norm === ticker.toUpperCase()) return addr
    } catch {
      // skip unreadable
    }
  }
  return undefined
}

/**
 * Build the two-call sequence for a USDC-funded market BUY of a dShare:
 *   1. approve USDC to OrderProcessor
 *   2. createOrderStandardFees(order)
 *
 * Returns the calls array suitable for kernel.sendUserOperation.
 */
export function buildBuyDShareCalls(opts: {
  recipient: Hex
  assetToken: Hex
  orderProcessor: Hex
  amountUsdc: string
}) {
  const paymentAmount = parseUnits(opts.amountUsdc, 6)

  const order: Order = {
    requestTimestamp: BigInt(Math.floor(Date.now() / 1000)),
    recipient: opts.recipient,
    assetToken: opts.assetToken,
    paymentToken: USDC,
    sell: false,
    orderType: 0, // MARKET
    assetTokenQuantity: 0n,
    paymentTokenQuantity: paymentAmount,
    price: 0n,
    tif: 1, // GTC
  }

  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [opts.orderProcessor, paymentAmount],
  })
  const orderData = encodeFunctionData({
    abi: orderProcessorAbi,
    functionName: "createOrderStandardFees",
    args: [order],
  })

  return {
    order,
    calls: [
      { to: USDC, data: approveData, value: 0n },
      { to: opts.orderProcessor, data: orderData, value: 0n },
    ],
  }
}
