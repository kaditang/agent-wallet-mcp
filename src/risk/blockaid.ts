// Stub — Blockaid is partner-key gated. Wire env BLOCKAID_KEY when you have one.
// Their `transaction-scan` endpoint takes the same shape we use, returns
// { result: "Malicious"|"Warning"|"Benign", reason }.

import type { Hex } from "viem"

const KEY = process.env.BLOCKAID_KEY

export type BlockaidVerdict = {
  ok: boolean
  severity: "block" | "warn" | "info"
  reason?: string
  skipped?: boolean
}

export async function blockaidScan(opts: {
  from: Hex
  to: Hex
  data: Hex
  value?: bigint
  chainId: number
}): Promise<BlockaidVerdict> {
  if (!KEY) {
    return { ok: true, severity: "info", skipped: true }
  }
  try {
    const r = await fetch("https://api.blockaid.io/v0/evm/transaction/scan", {
      method: "POST",
      headers: { "X-API-Key": KEY, "content-type": "application/json" },
      body: JSON.stringify({
        chain: opts.chainId === 84532 ? "base-sepolia" : "ethereum",
        account_address: opts.from,
        data: { to: opts.to, data: opts.data, value: (opts.value ?? 0n).toString() },
      }),
    })
    if (!r.ok) return { ok: true, severity: "info", reason: `lookup ${r.status}` }
    const j = (await r.json()) as { result?: string; reason?: string }
    const verdict = j.result ?? "Benign"
    if (verdict === "Malicious")
      return { ok: false, severity: "block", reason: j.reason ?? "blockaid: malicious" }
    if (verdict === "Warning")
      return { ok: true, severity: "warn", reason: j.reason ?? "blockaid: warning" }
    return { ok: true, severity: "info" }
  } catch (e) {
    return { ok: true, severity: "info", reason: `blockaid error: ${(e as Error).message}` }
  }
}
