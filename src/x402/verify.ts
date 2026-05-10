import { decodeEventLog, parseAbi, parseUnits, type Hex } from "viem"
import { publicClient } from "../kernel.js"
import { USDC } from "../config.js"

const erc20 = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
])

const usedTxHashes = new Set<string>()

// Verifies the tx truly transferred at least `expectedAmountUsdc` of USDC
// to `expectedTo`, and that the same proof hasn't been replayed.
export async function verifyPaymentTx(opts: {
  txHash: Hex
  expectedTo: Hex
  expectedAmountUsdc: string
}): Promise<{ ok: boolean; reason?: string }> {
  if (usedTxHashes.has(opts.txHash.toLowerCase())) {
    return { ok: false, reason: "tx already used (replay)" }
  }
  let receipt
  try {
    receipt = await publicClient.getTransactionReceipt({ hash: opts.txHash })
  } catch (e) {
    return { ok: false, reason: `receipt fetch failed: ${(e as Error).message}` }
  }
  if (receipt.status !== "success") return { ok: false, reason: "tx reverted" }

  const need = parseUnits(opts.expectedAmountUsdc, 6)
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC.toLowerCase()) continue
    try {
      const decoded = decodeEventLog({
        abi: erc20,
        data: log.data,
        topics: log.topics,
      })
      if (decoded.eventName !== "Transfer") continue
      const args = decoded.args as { from: Hex; to: Hex; value: bigint }
      if (
        args.to.toLowerCase() === opts.expectedTo.toLowerCase() &&
        args.value >= need
      ) {
        usedTxHashes.add(opts.txHash.toLowerCase())
        return { ok: true }
      }
    } catch {
      // not a Transfer event, skip
    }
  }
  return { ok: false, reason: "no matching Transfer log" }
}
