// In-memory tx stash. The MCP tool builds a tx, stashes it under a fresh ID,
// returns a /sign.html?id=... URL. The sign page fetches the tx by id, asks
// Phantom to sign + send, and posts the signature back.
//
// V1 only — single-process, in-memory, ~24h retention. For multi-instance
// production we'd move this to Redis or SQLite.

import { randomUUID } from "node:crypto"

export type SignableTx = {
  id: string
  kind: "buy_xstock" | "sell_xstock" | "deposit_yield" | "withdraw_yield"
  wallet: string
  /** Display fields shown on the sign page so user knows what they're signing */
  ticker?: string
  symbol?: string
  amountUsdc?: number
  expectedOut?: number
  protocol?: string
  unsignedTxBase64: string
  lastValidBlockHeight?: number
  createdAt: number
  /** If signed, the signature is recorded here for the MCP `track_tx` tool. */
  signature?: string
}

const STORE = new Map<string, SignableTx>()
const TTL_MS = 24 * 60 * 60 * 1000

export function stashSignableTx(input: Omit<SignableTx, "id" | "createdAt">): string {
  const id = randomUUID()
  STORE.set(id, { ...input, id, createdAt: Date.now() })
  // Sweep expired
  for (const [k, v] of STORE) {
    if (Date.now() - v.createdAt > TTL_MS) STORE.delete(k)
  }
  return id
}

export function getSignableTx(id: string): SignableTx | undefined {
  return STORE.get(id)
}

export function recordSignature(id: string, signature: string): boolean {
  const tx = STORE.get(id)
  if (!tx) return false
  tx.signature = signature
  return true
}

export function getSignBaseUrl(): string {
  // Frontend (Vite) dev server. Override with WEB_BASE_URL env when deploying.
  return process.env.WEB_BASE_URL ?? "http://localhost:5173"
}
