// Identity + API key store. Replaces the static DEMO_TOKENS env table.
//
// Flow:
//   1. Frontend POST /auth/challenge { pubkey? } -> returns { nonce, message } (purpose-bound, SIWS layout)
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
import { loadJsonFile } from "./safe-json.js"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import { audit } from "./audit.js"
import bs58 from "bs58"

const STORE_PATH = process.env.AUTH_STORE_PATH ?? "data/api-keys.json"
const NONCE_TTL_MS = 5 * 60 * 1000
const MAX_NONCES = 20_000
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

type NonceRecord = {
  message: string
  createdAt: number
  purpose: NoncePurpose
  /** Wallet the challenge was issued for, when the client said (bound at consume). */
  address?: string
  /** OAuth authorization request id the challenge was issued for. */
  requestId?: string
}
const NONCES = new Map<string, NonceRecord>()
let store: Stored = { keys: {} }

function ensureDir() {
  const dir = path.dirname(STORE_PATH)
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function loadFromDisk() {
  try {
    const parsed = loadJsonFile<Stored>(STORE_PATH, "auth-store")
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
//
// Every challenge is issued for ONE purpose and can only be spent on it: a login signature cannot
// revoke keys, a revoke signature cannot mint one, and neither can approve an OAuth request (and
// the reverse). Until 2026-10-17 all three shared one untyped nonce pool, so one signature phished
// for "sign in" could also wipe every key of that wallet (external report, see SECURITY.md).
//
// Messages use the Sign-In-with-Solana (SIWS, EIP-4361-style) layout: the first line names the
// domain asking, so a wallet that parses SIWS can compare it with the site actually requesting the
// signature, and the statement tells the user what the signature is for. When the client sends the
// wallet address up front it is written into the message and the nonce is bound to it.

export type NoncePurpose = "login" | "revoke_all" | "oauth"
export const SIWS_DOMAIN = "autoyield.org"
const SIWS_URI = `https://${SIWS_DOMAIN}`

const STATEMENTS: Record<Exclude<NoncePurpose, "oauth">, string> = {
  login:
    "Sign in to autoyield to create an API key for this wallet. This signature does not move funds or approve any transaction.",
  revoke_all:
    "Revoke ALL autoyield API keys for this wallet. Every app or agent using one of them stops working.",
}

export function isSolanaPubkey(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 32 || v.length > 44) return false
  try {
    return bs58.decode(v).length === 32
  } catch {
    return false
  }
}

/** One line, no control characters: a statement must not be able to fake the fields below it. */
function oneLine(s: string, max = 300): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, max)
}

export function issueNonce(
  opts: { purpose: NoncePurpose; statement?: string; address?: string; requestId?: string } = { purpose: "login" },
): { nonce: string; message: string; expiresAt: number } {
  const { purpose, address, requestId } = opts
  const statement = oneLine(
    purpose === "oauth" ? (opts.statement ?? "Authorize an app to use autoyield.") : STATEMENTS[purpose],
  )
  // SIWS nonces are alphanumeric.
  const nonce = randomBytes(16).toString("hex")
  const now = Date.now()
  const expiresAt = now + NONCE_TTL_MS
  const iso = (t: number) => new Date(t).toISOString().slice(0, 19) + "Z"
  // Build the message ONCE at issue time and store it. /auth/verify must
  // verify the signature against these exact bytes — rebuilding the message
  // at verify time would race the timestamp and break ed25519 verification.
  const lines = [`${SIWS_DOMAIN} wants you to sign in with your Solana account:`]
  if (address) lines.push(address)
  lines.push(
    "",
    statement,
    "",
    `URI: ${SIWS_URI}`,
    "Version: 1",
    "Chain ID: mainnet",
    `Nonce: ${nonce}`,
    `Issued At: ${iso(now)}`,
    `Expiration Time: ${iso(expiresAt)}`,
  )
  if (requestId) lines.push(`Request ID: ${requestId}`)
  const message = lines.join("\n")
  // Sweep expired, then cap: the route is rate-limited per IP, but a spread of addresses must not
  // grow the map without bound (oldest in-flight challenge goes first; its user just retries).
  for (const [k, v] of NONCES) {
    if (now - v.createdAt > NONCE_TTL_MS) NONCES.delete(k)
  }
  while (NONCES.size >= MAX_NONCES) NONCES.delete(NONCES.keys().next().value!)
  NONCES.set(nonce, { message, createdAt: now, purpose, address, requestId })
  return { nonce, message, expiresAt }
}

/**
 * The message issued for this nonce, or null if it is unknown, expired, or was issued for a
 * different purpose / wallet / OAuth request. Single-use: the nonce is burned either way.
 */
export function consumeNonce(
  nonce: string,
  purpose: NoncePurpose,
  bind: { address?: string; requestId?: string } = {},
): string | null {
  const n = NONCES.get(nonce)
  if (!n) return null
  NONCES.delete(nonce)
  if (Date.now() - n.createdAt > NONCE_TTL_MS) return null
  if (n.purpose !== purpose) return null
  if (n.address !== undefined && n.address !== bind.address) return null
  if (n.requestId !== undefined && n.requestId !== bind.requestId) return null
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
