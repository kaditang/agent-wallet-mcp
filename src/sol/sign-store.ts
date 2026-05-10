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
  /** Authenticated MCP user that built this tx (req.userId from requireAuth).
   *  Stamped at stash time. Used for audit traceability and to detect when
   *  someone else's sign id is being abused for rebuild traffic. */
  userId?: string
  ticker?: string
  /** "Headline" symbol — for buy/deposit this is the OUTPUT (what user gets);
   *  for sell/withdraw this is the INPUT (what user is selling). */
  symbol?: string
  /** USDC amount for deposit/buy (input is USDC). undefined for sell/withdraw. */
  amountUsdc?: number
  expectedOut?: number
  /** What's being spent: amount + symbol. Set for ALL kinds — used by sign page
   *  to show "Spending X foo" regardless of direction. */
  inputAmount?: number
  inputSymbol?: string
  /** USD value estimate of the trade (for high-value confirm gating). */
  valueUsdEstimate?: number
  protocol?: string
  unsignedTxBase64: string
  lastValidBlockHeight?: number
  createdAt: number
  signature?: string
  /** Set once a broadcast has started — guards against double-broadcast. */
  broadcastingAt?: number
  /** Number of times /sign/rebuild has refreshed this tx. Capped to prevent
   *  a leaked sign id from being used as a free Jupiter quote oracle. */
  rebuildCount?: number
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

/** Hard cap on how many times a single sign id can be rebuilt. Each rebuild
 *  costs us a Jupiter quote + swap-tx call. 20 is generous for a real user
 *  (they'd hit "rebuild" once per blockhash expiry, ~60s) and tight enough
 *  that a leaked id can't be milked indefinitely. */
export const REBUILD_CAP_PER_ID = 20

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

/**
 * Reserve one rebuild slot for this sign id. Returns the new rebuild count if
 * under cap; throws RebuildCapError if at/over cap. Call BEFORE the expensive
 * Jupiter call so we don't burn quote quota on a capped id.
 */
export class RebuildCapError extends Error {
  constructor() {
    super(`rebuild cap (${REBUILD_CAP_PER_ID}) exceeded for this sign id`)
    this.name = "RebuildCapError"
  }
}

export function reserveRebuild(id: string): number {
  const tx = STORE.get(id)
  if (!tx) return 0
  const next = (tx.rebuildCount ?? 0) + 1
  if (next > REBUILD_CAP_PER_ID) throw new RebuildCapError()
  tx.rebuildCount = next
  flushToDisk()
  return next
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
 * Distinct error class for broadcast-lock conflicts so callers can branch on
 * `instanceof` instead of regex-matching error messages.
 */
export class BroadcastLockError extends Error {
  reason: "already-broadcast" | "in-flight"
  constructor(reason: "already-broadcast" | "in-flight", message?: string) {
    super(
      message ??
        (reason === "already-broadcast"
          ? "already broadcast — signature exists for this tx id"
          : "a broadcast is already in flight for this tx id"),
    )
    this.name = "BroadcastLockError"
    this.reason = reason
  }
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
    throw new BroadcastLockError("already-broadcast")
  }
  if (tx?.broadcastingAt) {
    throw new BroadcastLockError("in-flight")
  }
  const existing = LOCKS.get(id)
  if (existing) {
    // Should be unreachable because broadcastingAt is set synchronously below,
    // but keep as a safety net.
    await existing.catch(() => {})
    throw new BroadcastLockError("in-flight")
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
