import "dotenv/config"
import { initSentry, flushSentry } from "./sentry.js"
// Sentry must be initialized before any other module that might throw at
// import time (and before Express is constructed).
initSentry()
import express from "express"
import cors from "cors"
import rateLimit from "express-rate-limit"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { requireAuth, reply500 } from "./auth.js"
import {
  consumeNonce,
  issueNonce,
  lookupApiKey,
  mintApiKey,
  revokeAllForPubkey,
  revokeApiKey,
} from "./auth-store.js"
import { audit, flushAuditSync } from "./audit.js"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { clampSlippage, dispatch as toolDispatch, getToolList } from "./tools.js"
import { preflightSignedTx, PREFLIGHT_ENFORCE } from "../sol/preflight.js"
import { captureMessage } from "./sentry.js"
import { getBalances } from "../sol/balances.js"
import {
  BroadcastLockError,
  getSignableTx,
  RebuildCapError,
  reserveRebuild,
  updateRebuiltTx,
  withBroadcastLock,
} from "../sol/sign-store.js"
import { randomUUID } from "node:crypto"
import { withRpcFallback } from "../sol/connection.js"
import { VersionedTransaction } from "@solana/web3.js"

export const app = express()

// Trust the first proxy (Fly's edge). Without this, express-rate-limit
// refuses to use X-Forwarded-For and all requests appear to come from one
// internal IP, breaking per-IP rate limiting.
app.set("trust proxy", 1)

// CORS — open by default but restrictable. Production should set
// ALLOWED_ORIGINS to a comma-separated list (e.g. "https://autoyield.org").
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
app.use(
  cors({
    origin: allowedOrigins.length > 0 ? allowedOrigins : true,
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
)
app.use(express.json({ limit: "256kb" }))

// Rate limits — defense against simple flooding. Tune as we observe traffic.
const readLimiter = rateLimit({
  windowMs: 60_000, // 1 min
  limit: 60, // 60 reads/min/IP
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate limited (60 req/min). Slow down." },
})
const buildLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20, // 20 unsigned-tx builds per min — Jupiter quote calls are paid by us
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate limited (20 builds/min). Slow down." },
})
const broadcastLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10, // 10 broadcasts per min — protects RPC quota
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "rate limited (10 broadcasts/min)." },
})
// /healthz is unauthenticated and makes a live RPC call. A loose limiter +
// short-lived slot cache keep it from being used to amplify load onto our
// RPC quota. 30 hits / 10s is generous for real uptime monitors.
const healthLimiter = rateLimit({
  windowMs: 10_000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { ok: false, error: "rate limited" },
})

// Health check — used by uptime monitors. Confirms server is up and at least
// one Solana RPC endpoint responds. Unauthenticated, so: loose rate limit +
// a 5s slot cache so a flood can't amplify onto our RPC quota.
const SLOT_CACHE_TTL_MS = 5_000
let slotCache: { value: number; expiresAt: number } | null = null
app.get("/healthz", healthLimiter, async (_req, res) => {
  const start = Date.now()
  const detailed = process.env.NODE_ENV !== "production"
  try {
    let slot: number
    let cached = false
    if (slotCache && Date.now() < slotCache.expiresAt) {
      slot = slotCache.value
      cached = true
    } else {
      slot = await withRpcFallback((c) => c.getSlot())
      slotCache = { value: slot, expiresAt: Date.now() + SLOT_CACHE_TTL_MS }
    }
    res.json(
      detailed
        ? {
            ok: true,
            slot,
            slotCached: cached,
            rpcLatencyMs: Date.now() - start,
            uptimeSec: Math.floor(process.uptime()),
          }
        : { ok: true },
    )
  } catch (e) {
    res.status(503).json({ ok: false, error: "no Solana RPC reachable" })
  }
})

// --- OAuth 2.1 metadata stubs for MCP HTTP clients (mcp-remote etc.) ----
// The MCP HTTP transport spec (post 2025-06-18) requires servers to expose
// RFC 9728 / 8414 / 7591 OAuth discovery so clients can negotiate auth.
// Our actual auth model is "user signs in with Phantom at /account.html and
// pastes the resulting `ak_<hex>` key into the MCP client config as a Bearer
// header" — i.e. a pre-issued static token, no dynamic OAuth dance. But
// mcp-remote refuses to start if these well-known endpoints 404.
//
// Strategy: respond with valid metadata that points the client at
// autoyield.org/account.html as the "authorization_endpoint" (where users go
// to sign in with Phantom and copy the key). Dynamic client registration
// returns a no-op success so the client proceeds to use the static Bearer.
if (process.env.NODE_ENV === "production" && !process.env.PUBLIC_ORIGIN) {
  console.warn(
    "[startup] PUBLIC_ORIGIN env not set; falling back to hardcoded https://autoyield-api.fly.dev. " +
      "Set PUBLIC_ORIGIN to the actual public URL if it differs.",
  )
}
const ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://autoyield-api.fly.dev"
const ACCOUNT_PAGE = process.env.WEB_BASE_URL
  ? `${process.env.WEB_BASE_URL.replace(/\/$/, "")}/account.html`
  : "https://autoyield.org/account.html"

// Auth advertisement strategy:
//   - We tell clients "this resource takes a static Bearer token in the
//     Authorization header" (RFC 9728).
//   - We DELIBERATELY do NOT advertise authorization_servers, because some
//     MCP gateways (notably Smithery) then insist on running a full OAuth
//     2.1 authorization-code dance and get stuck even with a working bridge.
//     Static-Bearer-only matches our actual model: users mint a key once
//     at autoyield.org/account.html and paste it into the MCP client.
//   - oauth-authorization-server returns 404. mcp-remote tested OK without
//     it (it falls through to /register stub for client info).
//   - /register and /auth/token stubs stay in case a strict OAuth client
//     does drive past discovery — they DO produce a usable token.
// Both well-known endpoints return 404. Smithery interprets the mere
// presence of /.well-known/oauth-protected-resource as "this resource
// requires OAuth dance" and refuses to use a static apiKey path even
// when one is provided. mcp-remote tested OK without these endpoints —
// it falls back to using the configured --header.
//
// The actual auth contract is signaled by:
//   - 401 responses include `WWW-Authenticate: Bearer realm="autoyield"`
//     (RFC 6750) — this is the standard way to say "send a Bearer token".
//   - /register and /auth/token stubs remain for any strict OAuth client
//     that pushes past discovery.
app.get("/.well-known/oauth-protected-resource", readLimiter, (_req, res) => {
  res.status(404).json({ error: "not_found" })
})

app.get("/.well-known/oauth-authorization-server", readLimiter, (_req, res) => {
  res.status(404).json({ error: "not_found" })
})

// Dynamic client registration stub. Returns a random client_id; mcp-remote
// proceeds to use the static Bearer header from --header anyway.
app.post("/register", readLimiter, (req, res) => {
  audit({ kind: "client_register", ip: req.ip })
  res.json({
    client_id: `mcp-client-${randomUUID()}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    redirect_uris: [],
  })
})

// OAuth 2.1 token endpoint. The "code" the client receives from the
// authorization endpoint (autoyield.org/account.html callback) IS the api
// key — minted server-side after the user signed a Phantom challenge. So
// this endpoint just unwraps it as the access_token; there's no separate
// token to mint, no refresh token (the api key has its own server-side
// lifecycle), and PKCE verifier is accepted but not validated (a stolen
// auth code that's a stolen api key is already game-over for that user).
app.post("/auth/token", readLimiter, express.urlencoded({ extended: true }), (req, res) => {
  // Body can be x-www-form-urlencoded (per RFC 6749) or JSON.
  const body = req.body ?? {}
  const grant = String(body.grant_type ?? "")
  const code = String(body.code ?? "")
  if (grant !== "authorization_code") {
    res.status(400).json({
      error: "unsupported_grant_type",
      error_description: "Only authorization_code is supported.",
    })
    return
  }
  if (!code.startsWith("ak_")) {
    res.status(400).json({
      error: "invalid_grant",
      error_description: "Code is not a valid autoyield api key.",
    })
    return
  }
  // Validate that the code resolves to a real (non-revoked) api key. Without
  // this check the endpoint cheerfully echoed any `ak_*`-shaped string back
  // as an access_token — strict OAuth clients would treat that as success
  // and surface a green "authenticated" UI even though requireAuth would
  // later 401 every actual request. P1 audit finding.
  if (!lookupApiKey(code)) {
    res.status(400).json({
      error: "invalid_grant",
      error_description: "Code does not match an active api key.",
    })
    return
  }
  // The code IS the access token. Return as Bearer with a long-ish ttl
  // (api keys don't expire on their own; we revoke server-side if needed).
  res.json({
    access_token: code,
    token_type: "Bearer",
    expires_in: 60 * 60 * 24 * 365, // 1 year nominal; real lifecycle is server-side
    scope: "mcp",
  })
})

// --- Phantom-based "Sign In with Solana" -> API key ---------------------
// 1) Frontend POSTs /auth/challenge -> { nonce, message, expiresAt }.
// 2) User signs `message` in Phantom (`signMessage`).
// 3) Frontend POSTs /auth/verify { pubkey, nonce, signatureBase64 } and
//    receives { apiKey, pubkey } once. The api key is shown to the user
//    once and used as Bearer in subsequent /mcp + build_*_tx calls.
app.post("/auth/challenge", buildLimiter, (_req, res) => {
  const c = issueNonce()
  res.json(c)
})

app.post("/auth/verify", buildLimiter, (req, res) => {
  const { pubkey, nonce, signatureBase64, label } = req.body ?? {}
  if (
    typeof pubkey !== "string" ||
    typeof nonce !== "string" ||
    typeof signatureBase64 !== "string"
  ) {
    res.status(400).json({ error: "pubkey, nonce, signatureBase64 required" })
    return
  }
  // Validate pubkey is a 32-byte ed25519 public key (base58, 32-44 chars).
  let pubkeyBytes: Uint8Array
  try {
    pubkeyBytes = bs58.decode(pubkey)
  } catch {
    res.status(400).json({ error: "pubkey must be base58" })
    return
  }
  if (pubkeyBytes.length !== 32) {
    res.status(400).json({ error: "pubkey must decode to 32 bytes" })
    return
  }
  const message = consumeNonce(nonce)
  if (!message) {
    res.status(400).json({ error: "nonce invalid or expired" })
    return
  }
  const sigBytes = Buffer.from(signatureBase64, "base64")
  if (sigBytes.length !== 64) {
    res.status(400).json({ error: "signature must decode to 64 bytes" })
    return
  }
  const ok = nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    sigBytes,
    pubkeyBytes,
  )
  if (!ok) {
    audit({ kind: "auth_fail", ip: req.ip, wallet: pubkey, error: "sig_verify" })
    res.status(401).json({ error: "signature does not verify" })
    return
  }
  const apiKey = mintApiKey(pubkey, typeof label === "string" ? label : undefined)
  audit({ kind: "api_key_minted", wallet: pubkey, ip: req.ip })
  res.json({ apiKey, pubkey })
})

// Revoke an api key. Two modes:
//   1. Authenticated by the key itself (Bearer ak_xxx) → revokes that one key
//   2. Authenticated by Phantom signature (proves wallet ownership) →
//      can revoke ALL keys for that pubkey, useful when a key leaks and the
//      user no longer has it but does have the wallet.
app.post("/auth/revoke", buildLimiter, (req, res) => {
  const { mode, apiKey, pubkey, nonce, signatureBase64 } = req.body ?? {}

  if (mode === "self") {
    // Self-revoke: prove possession of the key by passing it.
    if (typeof apiKey !== "string" || !apiKey.startsWith("ak_")) {
      res.status(400).json({ error: "apiKey required for self mode" })
      return
    }
    const ok = revokeApiKey(apiKey)
    if (!ok) {
      res.status(404).json({ error: "key not found (already revoked?)" })
      return
    }
    audit({ kind: "api_key_revoked", ip: req.ip, extra: { mode: "self" } })
    res.json({ revoked: 1 })
    return
  }

  if (mode === "all") {
    // Revoke-all-for-wallet: prove ownership by signing a fresh nonce. Same
    // ed25519 verify path as /auth/verify.
    if (
      typeof pubkey !== "string" ||
      typeof nonce !== "string" ||
      typeof signatureBase64 !== "string"
    ) {
      res
        .status(400)
        .json({ error: "pubkey, nonce, signatureBase64 required for all mode" })
      return
    }
    let pubkeyBytes: Uint8Array
    try {
      pubkeyBytes = bs58.decode(pubkey)
    } catch {
      res.status(400).json({ error: "pubkey must be base58" })
      return
    }
    if (pubkeyBytes.length !== 32) {
      res.status(400).json({ error: "pubkey must decode to 32 bytes" })
      return
    }
    const message = consumeNonce(nonce)
    if (!message) {
      res.status(400).json({ error: "nonce invalid or expired" })
      return
    }
    const sigBytes = Buffer.from(signatureBase64, "base64")
    if (sigBytes.length !== 64) {
      res.status(400).json({ error: "signature must decode to 64 bytes" })
      return
    }
    const ok = nacl.sign.detached.verify(
      new TextEncoder().encode(message),
      sigBytes,
      pubkeyBytes,
    )
    if (!ok) {
      audit({ kind: "auth_fail", ip: req.ip, wallet: pubkey, error: "sig_verify_revoke" })
      res.status(401).json({ error: "signature does not verify" })
      return
    }
    const count = revokeAllForPubkey(pubkey)
    audit({ kind: "api_key_revoked", ip: req.ip, wallet: pubkey, extra: { mode: "all", count } })
    res.json({ revoked: count })
    return
  }

  res.status(400).json({ error: "mode must be 'self' or 'all'" })
})

// (Removed: /sol/agent + /sol/grant-plan — V1.5 Squads autonomous-mode
// endpoints. autoyield V1d is service-only (non-custodial advisory + tx
// builder); we don't need an agent identity or a multisig grant flow.
// Removing them lets us drop @sqds/multisig from deps, which transitively
// pulled in 4 high-severity npm vulns via @solana/spl-token →
// @solana/buffer-layout-utils → bigint-buffer. When V1.5 implements
// autonomous mode, reintroduce a clean Squads integration in a separate
// module without the broken old SDK chain.)

// Public sign-page endpoints.
// /sign/tx/:id  → returns the stashed tx for the sign page to load
// /sign/confirm → sign page POSTs back the signature once Phantom signed+sent
app.get("/sign/tx/:id", readLimiter, (req, res) => {
  const tx = getSignableTx(String(req.params.id))
  if (!tx) {
    res.status(404).json({ error: "tx not found or expired" })
    return
  }
  res.json({
    id: tx.id,
    kind: tx.kind,
    wallet: tx.wallet,
    ticker: tx.ticker,
    symbol: tx.symbol,
    amountUsdc: tx.amountUsdc,
    expectedOut: tx.expectedOut,
    inputAmount: tx.inputAmount,
    inputSymbol: tx.inputSymbol,
    valueUsdEstimate: tx.valueUsdEstimate,
    protocol: tx.protocol,
    unsignedTxBase64: tx.unsignedTxBase64,
    lastValidBlockHeight: tx.lastValidBlockHeight,
    signature: tx.signature,
  })
})

// Rebuild a fresh swap tx for an existing sign id — used when the stashed tx
// has aged out (blockhash expired). Same recipe, fresh quote + new blockhash.
//
// Per-id rebuild cap (REBUILD_CAP_PER_ID) reserves a slot BEFORE the Jupiter
// call so a leaked sign id can't be milked indefinitely as a free quote oracle.
app.post("/sign/rebuild/:id", buildLimiter, async (req, res) => {
  const tx = getSignableTx(String(req.params.id))
  if (!tx) {
    res.status(404).json({ error: "tx not found or expired" })
    return
  }
  if (!tx.rebuildRecipe) {
    res.status(400).json({ error: "no rebuild recipe for this tx" })
    return
  }
  // Reserve a rebuild slot up front; throws if cap reached.
  try {
    reserveRebuild(tx.id)
  } catch (e) {
    if (e instanceof RebuildCapError) {
      audit({
        kind: "rate_limit",
        ip: req.ip,
        signId: tx.id,
        error: "rebuild-cap",
      })
      res.status(429).json({ error: e.message })
      return
    }
    throw e
  }
  try {
    const { jupiterQuote, jupiterSwapTx } = await import("../sol/jupiter.js")
    const r = tx.rebuildRecipe
    const humanAmount = Number(r.amountInHuman)
    if (!isFinite(humanAmount) || humanAmount <= 0) {
      throw new Error(
        `invalid amountInHuman in rebuild recipe: "${r.amountInHuman}"`,
      )
    }
    const amountAtomic = BigInt(Math.round(humanAmount * 10 ** r.inputDecimals))
    // Re-clamp the recipe's slippage on rebuild. Defense-in-depth: if the
    // stash was ever written with a wider slippage (data tampering, future
    // bug, or a code path that bypasses tools.ts), rebuild still respects
    // MAX_SLIPPAGE_BPS_HARD_CAP. Audit P1.
    const quote = await jupiterQuote({
      inputMint: r.inputMint,
      outputMint: r.outputMint,
      amountAtomic,
      slippageBps: clampSlippage(r.slippageBps),
    })
    const expectedOut = Number(quote.outAmount) / 10 ** r.outputDecimals

    // PRICE FLOOR: refuse to hand the user a rebuilt tx that's materially
    // worse than the worst case they accepted at first build. If the fresh
    // quote's expected output is below the originally-stashed minOut, the
    // market moved beyond the user's original tolerance (or the stash was
    // tampered). Don't silently sign a worse deal — make them build fresh.
    if (tx.minOut != null && expectedOut < tx.minOut) {
      audit({
        kind: "rebuild_tx",
        ip: req.ip,
        signId: tx.id,
        error: "below-floor",
        extra: { expectedOut, floor: tx.minOut },
      })
      res.status(409).json({
        error: "price moved beyond your original tolerance",
        detail: `Re-quote (${expectedOut}) is below the minimum you accepted at build (${tx.minOut}). Build a fresh transaction to trade at current prices.`,
      })
      return
    }

    const fresh = await jupiterSwapTx({ quote, userPublicKey: tx.wallet })
    updateRebuiltTx(tx.id, {
      unsignedTxBase64: fresh.swapTransactionBase64,
      lastValidBlockHeight: fresh.lastValidBlockHeight,
      expectedOut,
    })
    // Echo back id/wallet/kind so the sign page can verify the rebuild
    // didn't morph into an unrelated tx. Audit P1: prevents a
    // compromised/buggy rebuild from substituting wallet-draining bytes
    // after the user already approved the rendered details.
    res.json({
      id: tx.id,
      wallet: tx.wallet,
      kind: tx.kind,
      unsignedTxBase64: fresh.swapTransactionBase64,
      lastValidBlockHeight: fresh.lastValidBlockHeight,
      expectedOut,
    })
  } catch (e) {
    reply500(res, e, { route: "/sign/rebuild" })
  }
})

// (Removed: /sign/confirm — was an unauthenticated UX update path that let any
// caller with the signId mark a tx "Already signed" with an arbitrary string.
// The real signature is recorded server-side after a successful /sign/broadcast,
// so the frontend ping was redundant. Removed audit-pass-2 2026-05-10.)

// Broadcast a CLIENT-SIGNED tx via our backend's reliable RPC. Used when
// Phantom's `signAndSendTransaction` broadcast is unreliable; the sign page
// instead uses `signTransaction` (sign only) and POSTs the signed bytes here.
//
// SECURITY — what this endpoint DOES and DOES NOT verify (be honest):
//   DOES: require a known sign-store id; require the signed tx's fee-payer
//   (staticAccountKeys[0]) to equal the wallet we stashed; require a present,
//   non-zero signature. This stops arbitrary 3rd-party txs from being
//   broadcast through our RPC quota and stops broadcasting an unsigned tx.
//   DOES NOT: decode the instructions and prove the output mint / recipient /
//   amounts equal what the user reviewed. Phantom legitimately mutates the
//   message (compute-budget ixs), so naive byte-equality was dropped and not
//   replaced with instruction-level equivalence. Therefore this endpoint is
//   NOT the WYSIWYS backstop.
//   Two WYSIWYS backstops now exist: (1) PHANTOM'S OWN SIGNING PROMPT, which
//   simulates the tx and shows the user the real token deltas; and (2) the
//   pre-broadcast preflight below (preflightSignedTx) — when
//   PREFLIGHT_ENFORCE=true it simulates the signed tx server-side and BLOCKS
//   gross divergence (output redirected/wrong-mint/over-spend) before
//   broadcasting. Validated on real mainnet txs (SPL + Token-2022). See
//   SECURITY.md. (Still not byte-exact instruction equivalence — the
//   simulated-delta-bounds check is the pragmatic equivalent.)
app.post("/sign/broadcast", broadcastLimiter, async (req, res) => {
  const { id, signedTxBase64 } = req.body ?? {}
  if (typeof id !== "string" || typeof signedTxBase64 !== "string") {
    res.status(400).json({ error: "id and signedTxBase64 required" })
    return
  }
  const stashed = getSignableTx(id)
  if (!stashed) {
    res.status(404).json({ error: "tx id not found or expired" })
    return
  }
  try {
    const raw = Buffer.from(signedTxBase64, "base64")

    // Verify the signed tx is FROM the wallet we built for. Phantom legitimately
    // mutates the message bytes before signing (adds SetComputeUnitPrice /
    // SetComputeUnitLimit ixs to improve landing odds), so byte-equality vs
    // the stashed unsigned tx fails. The real anchor is the fee payer:
    // staticAccountKeys[0] must equal the wallet we stashed. Phantom can't
    // change that — it's the public key whose private key signs.
    let signedVtx: VersionedTransaction
    try {
      signedVtx = VersionedTransaction.deserialize(raw)
    } catch {
      res.status(400).json({ error: "could not deserialize signed tx" })
      return
    }
    const feePayer = signedVtx.message.staticAccountKeys[0]?.toBase58()
    if (!feePayer || feePayer !== stashed.wallet) {
      res.status(400).json({
        error: "signed tx fee payer does not match the stashed wallet",
      })
      return
    }
    if (
      signedVtx.signatures.length === 0 ||
      signedVtx.signatures.every((s) => s.every((b) => b === 0))
    ) {
      res.status(400).json({ error: "signed tx is missing signatures" })
      return
    }

    audit({
      kind: "broadcast_attempt",
      ip: req.ip,
      signId: id,
      wallet: stashed.wallet,
      txKind: stashed.kind,
      amount: stashed.amountUsdc,
      symbol: stashed.symbol,
    })

    // WYSIWYS backstop — simulate the signed tx and verify the wallet's token
    // deltas match the stashed deal. SHADOW MODE: we log the verdict but only
    // block when PREFLIGHT_ENFORCE=true, so we can confirm the delta math is
    // right on real txs before it can false-reject a legit trade. Fails OPEN
    // on any sim/derive ambiguity. Needs the rebuildRecipe (mints/decimals).
    if (stashed.rebuildRecipe && stashed.minOut != null) {
      try {
        const r = stashed.rebuildRecipe
        const verdict = await withRpcFallback((c) =>
          preflightSignedTx(c, signedTxBase64, {
            wallet: stashed.wallet,
            inputMint: r.inputMint,
            outputMint: r.outputMint,
            inputDecimals: r.inputDecimals,
            outputDecimals: r.outputDecimals,
            inputAmount: Number(r.amountInHuman),
            minOut: stashed.minOut!,
          }),
        )
        // Shadow observability: log EVERY verdict (incl. pass) so we can
        // confirm the delta math on real txs in flyctl logs before flipping
        // PREFLIGHT_ENFORCE. Without this a "pass" was silent and shadow mode
        // gave us nothing to validate against.
        console.log(
          `[preflight] verdict=${verdict.verdict} signId=${id} kind=${stashed.kind} ` +
            `spent=${verdict.spent ?? "?"} received=${verdict.received ?? "?"} ` +
            `minOut=${stashed.minOut} enforce=${PREFLIGHT_ENFORCE} reason="${verdict.reason}"`,
        )
        if (verdict.verdict !== "pass") {
          audit({
            kind: "broadcast_failure",
            ip: req.ip,
            signId: id,
            error: `preflight ${verdict.verdict}: ${verdict.reason}`,
            extra: { spent: verdict.spent, received: verdict.received, enforce: PREFLIGHT_ENFORCE },
          })
        }
        if (verdict.verdict === "violation") {
          captureMessage(`preflight violation: ${verdict.reason}`, "error", {
            tags: { signId: id, enforce: String(PREFLIGHT_ENFORCE) },
          })
          if (PREFLIGHT_ENFORCE) {
            res.status(400).json({
              error: "transaction failed safety preflight",
              detail: verdict.reason,
            })
            return
          }
        }
      } catch (e) {
        // Preflight must never block a legit tx on its own failure.
        console.warn(`[preflight] errored (proceeding): ${(e as Error).message?.slice(0, 120)}`)
      }
    }

    // Guard: if the stashed tx has a known lastValidBlockHeight, verify the
    // blockhash is still live BEFORE trying to broadcast. A stale blockhash
    // makes sendRawTransaction throw "Blockhash not found" — better to surface
    // a clear 409 here so the client knows to rebuild + re-sign rather than
    // let an unhandled RPC error bubble up through reply500.
    if (stashed.lastValidBlockHeight != null) {
      const currentHeight = await withRpcFallback((c) => c.getBlockHeight())
      if (currentHeight > stashed.lastValidBlockHeight) {
        audit({
          kind: "broadcast_failure",
          ip: req.ip,
          signId: id,
          error: "blockhash_expired",
          extra: { currentHeight, lastValidBlockHeight: stashed.lastValidBlockHeight },
        })
        res.status(409).json({
          error: "blockhash expired",
          detail:
            "The transaction's blockhash has expired (Solana blockhashes are only valid for ~60 s). " +
            "Please use the 'Rebuild' button on the sign page to get a fresh transaction and sign again.",
        })
        return
      }
    }

    // Lock per id — second submission for the same id immediately rejects.
    // Signature is recorded INSIDE the lock; no separate recordSignature call.
    const sig = await withBroadcastLock(id, async () =>
      withRpcFallback((c) =>
        c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 }),
      ),
    )
    audit({
      kind: "broadcast_success",
      ip: req.ip,
      signId: id,
      wallet: stashed.wallet,
      signature: sig,
    })
    res.json({ signature: sig, solscanUrl: `https://solscan.io/tx/${sig}` })
  } catch (e) {
    const raw = (e as Error).message ?? ""
    audit({
      kind: "broadcast_failure",
      ip: req.ip,
      signId: id,
      error: raw.slice(0, 200),
    })
    if (e instanceof BroadcastLockError) {
      // 409 errors are user-facing logic, safe to expose verbatim
      res.status(409).json({ error: e.message, reason: e.reason })
    } else {
      // Tag broadcast failures specifically — they're the highest-signal
      // alert (real money path failed) so they should be triaged separately
      // from generic 500s.
      reply500(res, e, {
        route: "/sign/broadcast",
        tags: { critical: "true" },
        extra: { signId: id },
      })
    }
  }
})

// Public read-only Solana balance lookup. No auth — anyone can query any address.
app.get("/sol/balances", readLimiter, async (req, res) => {
  const addr = (req.query.address ?? "").toString()
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    res.status(400).json({ error: "invalid base58 address" })
    return
  }
  try {
    const r = await getBalances(addr)
    res.json(r)
  } catch (e) {
    reply500(res, e)
  }
})

// (Removed: /session-pubkey, /grant — legacy EVM ZeroDev grant endpoints,
// not used by V1d service architecture.)

// MCP transport. Stateless: V1 service tools take wallet as an arg, no per-user state.
app.post("/mcp", buildLimiter, requireAuth, async (req, res) => {
  try {
    const server = new Server(
      { name: "agent-wallet", version: "0.2.0" },
      { capabilities: { tools: {} } },
    )
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolList() as any }))
    server.setRequestHandler(CallToolRequestSchema, async (r) =>
      toolDispatch(r.params, { userId: req.userId }),
    )

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    res.on("close", () => {
      transport.close()
      server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (e) {
    // transport may have already flushed headers; only send if we still can.
    if (!res.headersSent) reply500(res, e, { route: "/mcp" })
  }
})

// (Removed: /paid-tool/echo, /paid/equity-brief, /risk/preflight — legacy EVM
// x402 demo endpoints. Frozen for V1d service architecture; reusable patterns
// for V2 paid-API monetization layer.)

// Global error middleware — last resort for anything a route handler throws
// or calls next(err) with. Must be 4-arg and registered after all routes.
app.use(
  (
    err: unknown,
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) return next(err)
    reply500(res, err, { route: "express-error-middleware" })
  },
)

// Process-level backstops. A leaked rejection/exception should be logged and
// reported, not silently swallowed. We do NOT exit on unhandledRejection
// (too aggressive for a single bad request); uncaughtException is genuinely
// unsafe to continue from, so we flush + exit and let Fly restart us.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason)
  captureMessage(`unhandledRejection: ${String(reason)}`, "error")
})
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err)
  captureMessage(`uncaughtException: ${String(err)}`, "error")
  // Drain the audit queue synchronously before we go down — otherwise the
  // ~200ms-coalesced events (which may include a broadcast record) are lost.
  flushAuditSync()
  void flushSentry(2000).finally(() => process.exit(1))
})

// Don't call listen() when imported by tests — vitest imports `app` to
// drive supertest and doesn't need a bound port.
if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT ?? 3030)
  const server = app.listen(port, () => {
    console.log(`autoyield mcp service listening on :${port}`)
  })

  // Graceful shutdown — flush Sentry + audit log before Fly kills us.
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] ${signal} received, flushing...`)
    flushAuditSync()
    await flushSentry(2000)
    server.close(() => process.exit(0))
    // Hard exit if close() hangs past 5s (existing connections, etc.)
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on("SIGTERM", () => void shutdown("SIGTERM"))
  process.on("SIGINT", () => void shutdown("SIGINT"))
}
