// Sign-store: tracks unsigned txs the AI built, until the user signs them in
// Phantom and we broadcast.
//
// Persistence: every mutation appends to data/sign-store.json so a restart
// doesn't lose pending sigs. Older-than-TTL entries are dropped on load.
//
// Concurrency: each id has a one-shot "broadcast" lock — if a user clicks
// sign twice we don't double-broadcast.

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

const STORE_PATH = process.env.SIGN_STORE_PATH ?? "data/sign-store.json"
const TTL_MS = 24 * 60 * 60 * 1000

export type SignableTx = {
  id: string
  kind: "buy_xstock" | "sell_xstock" | "deposit_yield" | "withdraw_yield"
  wallet: string
  ticker?: string
  symbol?: string
  amountUsdc?: number
  expectedOut?: number
  protocol?: string
  unsignedTxBase64: string
  lastValidBlockHeight?: number
  createdAt: number
  signature?: string
  /** Set once a broadcast has started — guards against double-broadcast. */
  broadcastingAt?: number
  rebuildRecipe?: {
    inputMint: string
    inputDecimals: number
    outputMint: string
    outputDecimals: number
    outputSymbol: string
    amountInHuman: string
    slippageBps?: number
  }
}

const STORE = new Map<string, SignableTx>()
const LOCKS = new Map<string, Promise<unknown>>() // per-id mutex

// --- persistence ---

function ensureDir() {
  const dir = path.dirname(STORE_PATH)
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(STORE_PATH)) return
    const raw = fs.readFileSync(STORE_PATH, "utf8")
    const arr: SignableTx[] = JSON.parse(raw)
    const now = Date.now()
    for (const tx of arr) {
      if (now - tx.createdAt > TTL_MS) continue
      STORE.set(tx.id, tx)
    }
    console.log(`[sign-store] loaded ${STORE.size} entries from ${STORE_PATH}`)
  } catch (e) {
    console.warn(`[sign-store] could not load: ${(e as Error).message}`)
  }
}

let writeQueued = false
function flushToDisk() {
  if (writeQueued) return
  writeQueued = true
  // Coalesce mutations within ~50ms.
  setTimeout(() => {
    writeQueued = false
    try {
      ensureDir()
      const arr = Array.from(STORE.values())
      const tmp = STORE_PATH + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(arr, null, 2))
      fs.renameSync(tmp, STORE_PATH)
    } catch (e) {
      console.warn(`[sign-store] write failed: ${(e as Error).message}`)
    }
  }, 50)
}

loadFromDisk()

// --- public API ---

export function stashSignableTx(input: Omit<SignableTx, "id" | "createdAt">): string {
  const id = randomUUID()
  STORE.set(id, { ...input, id, createdAt: Date.now() })
  // Sweep expired
  const now = Date.now()
  for (const [k, v] of STORE) {
    if (now - v.createdAt > TTL_MS) STORE.delete(k)
  }
  flushToDisk()
  return id
}

export function getSignableTx(id: string): SignableTx | undefined {
  return STORE.get(id)
}

export function recordSignature(id: string, signature: string): boolean {
  const tx = STORE.get(id)
  if (!tx) return false
  tx.signature = signature
  flushToDisk()
  return true
}

export function updateRebuiltTx(
  id: string,
  patch: Pick<SignableTx, "unsignedTxBase64" | "lastValidBlockHeight" | "expectedOut">,
): void {
  const tx = STORE.get(id)
  if (!tx) return
  Object.assign(tx, patch)
  flushToDisk()
}

/**
 * Run `fn` exclusively for this id — if a broadcast is already in flight,
 * the second caller waits for the first to finish (or fail) and is then told
 * the tx is already broadcasting/done.
 */
export async function withBroadcastLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const tx = STORE.get(id)
  if (tx?.signature) {
    throw new Error("already broadcast — signature exists for this tx id")
  }
  if (tx?.broadcastingAt) {
    throw new Error("a broadcast is already in flight for this tx id")
  }
  const existing = LOCKS.get(id)
  if (existing) {
    // Should be unreachable because broadcastingAt is set synchronously below,
    // but keep as a safety net.
    await existing.catch(() => {})
    throw new Error("a broadcast is already in flight for this tx id")
  }
  if (tx) {
    tx.broadcastingAt = Date.now()
    flushToDisk()
  }
  const p = (async () => {
    try {
      return await fn()
    } finally {
      const t = STORE.get(id)
      if (t) delete t.broadcastingAt
      LOCKS.delete(id)
      flushToDisk()
    }
  })()
  LOCKS.set(id, p)
  return p
}

export function getSignBaseUrl(): string {
  return process.env.WEB_BASE_URL ?? "http://localhost:5173"
}
