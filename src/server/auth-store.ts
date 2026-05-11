// Identity + API key store. Replaces the static DEMO_TOKENS env table.
//
// Flow:
//   1. Frontend POST /auth/challenge -> returns { nonce, message }
//   2. User signs `message` with Phantom (ed25519 over msg bytes)
//   3. Frontend POST /auth/verify { pubkey, nonce, signature(base64) }
//   4. Server verifies signature, mints a 32-byte hex api key
//   5. Server stores sha256(apiKey) -> { pubkey, createdAt, lastUsedAt }
//   6. Returns the apiKey ONCE; frontend displays + user pastes into MCP config
//
// Persistence: data/api-keys.json (same pattern as sign-store).
// API keys are stored hashed; a leaked file does not grant access.
//
// Nonces are kept in memory only (5-min TTL). A reboot drops in-flight logins
// — acceptable since they re-click "sign in".

import fs from "node:fs"
import path from "node:path"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { audit } from "./audit.js"

const STORE_PATH = process.env.AUTH_STORE_PATH ?? "data/api-keys.json"
const NONCE_TTL_MS = 5 * 60 * 1000
/** Max active api keys per pubkey. Prevents a malicious user from looping
 *  sign-in to fill the volume. When over the cap, mintApiKey evicts the
 *  oldest key for that pubkey (LRU-by-createdAt). */
const MAX_KEYS_PER_PUBKEY = 10

export type ApiKeyRecord = {
  pubkey: string
  createdAt: number
  lastUsedAt: number
  /** Optional human-friendly label (e.g. "MacBook Claude"); future feature. */
  label?: string
}

type Stored = {
  // sha256(apiKey) -> record
  keys: Record<string, ApiKeyRecord>
}

const NONCES = new Map<string, { message: string; createdAt: number }>()
let store: Stored = { keys: {} }

function ensureDir() {
  const dir = path.dirname(STORE_PATH)
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadFromDisk() {
  try {
    if (!fs.existsSync(STORE_PATH)) return
    const raw = fs.readFileSync(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw) as Stored
    if (parsed && typeof parsed === "object" && parsed.keys) {
      store = parsed
      console.log(
        `[auth-store] loaded ${Object.keys(store.keys).length} api keys from ${STORE_PATH}`,
      )
    }
  } catch (e) {
    console.warn(`[auth-store] could not load: ${(e as Error).message}`)
  }
}

let writeQueued = false
function flushToDisk() {
  if (writeQueued) return
  writeQueued = true
  setTimeout(() => {
    writeQueued = false
    try {
      ensureDir()
      const tmp = STORE_PATH + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify(store, null, 2))
      fs.renameSync(tmp, STORE_PATH)
    } catch (e) {
      console.warn(`[auth-store] write failed: ${(e as Error).message}`)
    }
  }, 50)
}

loadFromDisk()

// --- nonce / challenge ---

export function issueNonce(): { nonce: string; message: string; expiresAt: number } {
  const nonce = randomUUID()
  const expiresAt = Date.now() + NONCE_TTL_MS
  // Build the message ONCE at issue time and store it. /auth/verify must
  // verify the signature against this exact bytes — rebuilding the message
  // at verify time would race the timestamp and break ed25519 verification.
  const message = `Sign in to autoyield.org\n\nNonce: ${nonce}\nIssued: ${new Date().toISOString().slice(0, 19)}Z`
  NONCES.set(nonce, { message, createdAt: Date.now() })
  // Sweep expired
  for (const [k, v] of NONCES) {
    if (Date.now() - v.createdAt > NONCE_TTL_MS) NONCES.delete(k)
  }
  return { nonce, message, expiresAt }
}

/** Returns the message that was issued for this nonce, or null if invalid/expired. Single-use. */
export function consumeNonce(nonce: string): string | null {
  const n = NONCES.get(nonce)
  if (!n) return null
  if (Date.now() - n.createdAt > NONCE_TTL_MS) {
    NONCES.delete(nonce)
    return null
  }
  NONCES.delete(nonce)
  return n.message
}

// --- api keys ---

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

export function mintApiKey(pubkey: string, label?: string): string {
  // Enforce per-pubkey cap: evict oldest keys for this pubkey if at the limit.
  const ownedHashes = Object.entries(store.keys)
    .filter(([, rec]) => rec.pubkey === pubkey)
    .sort((a, b) => a[1].createdAt - b[1].createdAt) // oldest first
  let evictedCount = 0
  while (ownedHashes.length >= MAX_KEYS_PER_PUBKEY) {
    const [oldestHash, oldestRec] = ownedHashes.shift()!
    delete store.keys[oldestHash]
    evictedCount++
    audit({
      kind: "api_key_evicted",
      wallet: pubkey,
      extra: {
        reason: "lru_cap",
        cap: MAX_KEYS_PER_PUBKEY,
        evictedCreatedAt: oldestRec.createdAt,
        evictedLabel: oldestRec.label,
      },
    })
  }
  void evictedCount
  // 32 bytes -> 64 hex chars. Prefix with "ak_" for visual identification.
  const apiKey = "ak_" + randomBytes(32).toString("hex")
  const hash = sha256Hex(apiKey)
  store.keys[hash] = {
    pubkey,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    label,
  }
  flushToDisk()
  return apiKey
}

/** Revoke a single api key by its plaintext value. Returns true if it existed. */
export function revokeApiKey(apiKey: string): boolean {
  const hash = sha256Hex(apiKey)
  if (!(hash in store.keys)) return false
  delete store.keys[hash]
  flushToDisk()
  return true
}

/** Revoke all keys belonging to a pubkey. Returns the count revoked. */
export function revokeAllForPubkey(pubkey: string): number {
  let count = 0
  for (const [hash, rec] of Object.entries(store.keys)) {
    if (rec.pubkey === pubkey) {
      delete store.keys[hash]
      count++
    }
  }
  if (count > 0) flushToDisk()
  return count
}

/** How fresh `lastUsedAt` is allowed to be before we bother writing it.
 *  Was: every request touched the disk (via 50ms coalesced flushToDisk).
 *  Under load (100 RPS) that's a sustained write storm for a field that's
 *  only used for "when did this key last work?" — minute-level resolution
 *  is plenty.
 */
const LAST_USED_WRITE_THROTTLE_MS = 60_000

/** Look up the pubkey associated with an api key, or null if invalid. */
export function lookupApiKey(apiKey: string): string | null {
  if (!apiKey) return null
  const hash = sha256Hex(apiKey)
  const rec = store.keys[hash]
  if (!rec) return null
  const now = Date.now()
  // In-memory bump is free; the persistence is what's expensive.
  if (now - (rec.lastUsedAt ?? 0) > LAST_USED_WRITE_THROTTLE_MS) {
    rec.lastUsedAt = now
    flushToDisk()
  } else {
    rec.lastUsedAt = now
  }
  return rec.pubkey
}

/** Count active keys for a pubkey (useful for UI listing / future revocation). */
export function listKeysForPubkey(pubkey: string): ApiKeyRecord[] {
  return Object.values(store.keys).filter((r) => r.pubkey === pubkey)
}
