// OAuth 2.1 authorization server for the hosted MCP endpoint, so it works as a
// remote connector (Claude.ai web/mobile "Add custom connector", ChatGPT, …)
// without the user touching a terminal or an API key.
//
// Flow (MCP authorization spec: RFC 9728 + 8414 + 7591 + 7636):
//   1. client hits /mcp → 401 with WWW-Authenticate resource_metadata=…
//   2. client reads /.well-known/oauth-protected-resource → this server
//   3. client reads /.well-known/oauth-authorization-server, registers via
//      POST /register (dynamic client registration)
//   4. browser → GET /oauth/authorize (PKCE S256 required) → 302 to
//      autoyield.org/account.html?authz=<id>
//   5. the page shows WHO is asking (client name + redirect host), the user
//      signs an authorization message in Phantom that NAMES that app
//      → POST /oauth/approve → server mints an api key, stores it behind a
//      random one-time code, and returns redirect_uri?code=…&state=…
//   6. client POSTs /oauth/token with code + code_verifier → access_token
//      (= the api key; requireAuth already accepts it).
//
// Replaces the old "code = the api key itself" bridge: the key never appears
// in a URL, codes are single-use + short-lived + bound to client, redirect_uri
// and PKCE challenge, and redirect_uris must be pre-registered.
//
// Persistence: registered clients go to OAUTH_CLIENTS_PATH (Fly: /data — set
// in the Dockerfile, or a redeploy forgets every client_id). Pending requests
// and codes are in-memory on purpose: they live minutes; a restart just makes
// the user click Connect again.

import fs from "node:fs"
import path from "node:path"
import { createHash, randomBytes } from "node:crypto"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { consumeNonce, issueNonce, mintApiKey } from "./auth-store.js"

export const OAUTH_ORIGIN = process.env.PUBLIC_ORIGIN ?? "https://autoyield-api.fly.dev"
export const MCP_RESOURCE = `${OAUTH_ORIGIN}/mcp`
const CLIENTS_PATH = process.env.OAUTH_CLIENTS_PATH ?? "data/oauth-clients.json"

const AUTHZ_TTL_MS = 10 * 60_000
const CODE_TTL_MS = 5 * 60_000
const MAX_CLIENTS = 5_000
const MAX_PENDING = 2_000

/** Redirect hosts we recognise (consent page shows them without a warning). */
export const KNOWN_REDIRECT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "chat.openai.com", "localhost", "127.0.0.1"]

// --- metadata ---------------------------------------------------------------

export function protectedResourceMetadata() {
  return {
    resource: MCP_RESOURCE,
    authorization_servers: [OAUTH_ORIGIN],
    bearer_methods_supported: ["header"],
    resource_name: "autoyield",
  }
}

export function authorizationServerMetadata() {
  return {
    issuer: OAUTH_ORIGIN,
    authorization_endpoint: `${OAUTH_ORIGIN}/oauth/authorize`,
    token_endpoint: `${OAUTH_ORIGIN}/oauth/token`,
    registration_endpoint: `${OAUTH_ORIGIN}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
  }
}

// --- client registry (RFC 7591) -------------------------------------------

type Client = { client_id: string; client_name: string; redirect_uris: string[]; created_at: number }
let clients: Record<string, Client> = {}

function loadClients() {
  try {
    if (fs.existsSync(CLIENTS_PATH)) clients = JSON.parse(fs.readFileSync(CLIENTS_PATH, "utf8")) ?? {}
  } catch (e) {
    console.warn(`[oauth] could not load clients: ${(e as Error).message}`)
  }
}
let writeQueued = false
function saveClients() {
  if (writeQueued) return
  writeQueued = true
  setTimeout(() => {
    writeQueued = false
    try {
      const dir = path.dirname(CLIENTS_PATH)
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(CLIENTS_PATH + ".tmp", JSON.stringify(clients))
      fs.renameSync(CLIENTS_PATH + ".tmp", CLIENTS_PATH)
    } catch (e) {
      console.warn(`[oauth] could not save clients: ${(e as Error).message}`)
    }
  }, 50)
}
loadClients()

/** PURE: is this an acceptable redirect URI? https anywhere, http only on loopback. */
export function isValidRedirectUri(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.length > 512) return false
  try {
    const u = new URL(uri)
    if (u.hash) return false
    if (u.protocol === "https:") return true
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
  } catch {
    return false
  }
}

export class OAuthError extends Error {
  constructor(public code: string, description: string, public status = 400) {
    super(description)
  }
}

export function registerClient(body: any): Client {
  const uris = body?.redirect_uris
  if (!Array.isArray(uris) || uris.length < 1 || uris.length > 10 || !uris.every(isValidRedirectUri)) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be 1-10 https URLs (http only for localhost)")
  }
  const method = body?.token_endpoint_auth_method ?? "none"
  if (method !== "none") {
    throw new OAuthError("invalid_client_metadata", "only public clients (token_endpoint_auth_method none) are supported")
  }
  const name = String(body?.client_name ?? "MCP client").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80) || "MCP client"
  if (Object.keys(clients).length >= MAX_CLIENTS) {
    const oldest = Object.values(clients).sort((a, b) => a.created_at - b.created_at)[0]
    if (oldest) delete clients[oldest.client_id]
  }
  const client: Client = {
    client_id: `c_${randomBytes(16).toString("hex")}`,
    client_name: name,
    redirect_uris: uris,
    created_at: Date.now(),
  }
  clients[client.client_id] = client
  saveClients()
  return client
}

export function getClient(id: unknown): Client | undefined {
  return typeof id === "string" ? clients[id] : undefined
}

// --- authorization requests -------------------------------------------------

type AuthzRequest = {
  client_id: string
  redirect_uri: string
  code_challenge: string
  state: string
  resource?: string
  expiresAt: number
}
const pending = new Map<string, AuthzRequest>()

type CodeGrant = {
  apiKey: string
  client_id: string
  redirect_uri: string
  code_challenge: string
  resource?: string
  expiresAt: number
}
const codes = new Map<string, CodeGrant>()

function sweep() {
  const now = Date.now()
  for (const [k, v] of pending) if (v.expiresAt < now) pending.delete(k)
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k)
}

/**
 * Validate an /oauth/authorize query. Client / redirect_uri problems THROW
 * (the caller must answer with a plain 400 — never redirect to an unvalidated
 * URI). Problems after redirect_uri is trusted return {redirectError}.
 */
export function startAuthorization(
  q: Record<string, unknown>,
): { authzId: string } | { redirectError: string } {
  const client = getClient(q.client_id)
  if (!client) throw new OAuthError("invalid_client", "unknown client_id — register via /register first")
  const redirect = typeof q.redirect_uri === "string" ? q.redirect_uri : ""
  if (!client.redirect_uris.includes(redirect)) {
    throw new OAuthError("invalid_request", "redirect_uri does not match a registered redirect URI")
  }
  const state = typeof q.state === "string" ? q.state.slice(0, 512) : ""
  const err = (e: string, d: string) => {
    const u = new URL(redirect)
    u.searchParams.set("error", e)
    u.searchParams.set("error_description", d)
    if (state) u.searchParams.set("state", state)
    return { redirectError: u.toString() }
  }
  if (q.response_type !== "code") return err("unsupported_response_type", "response_type must be code")
  const challenge = typeof q.code_challenge === "string" ? q.code_challenge : ""
  if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) {
    return err("invalid_request", "PKCE required: code_challenge_method=S256 with a valid code_challenge")
  }
  const resource = typeof q.resource === "string" ? q.resource : undefined
  if (resource && resource !== MCP_RESOURCE) return err("invalid_target", `resource must be ${MCP_RESOURCE}`)

  sweep()
  if (pending.size >= MAX_PENDING) return err("temporarily_unavailable", "too many pending authorizations, retry shortly")
  const authzId = randomBytes(18).toString("base64url")
  pending.set(authzId, {
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    state,
    resource,
    expiresAt: Date.now() + AUTHZ_TTL_MS,
  })
  return { authzId }
}

/** What the consent page shows. */
export function describeAuthorization(authzId: string) {
  const req = pending.get(authzId)
  if (!req || req.expiresAt < Date.now()) return null
  const client = getClient(req.client_id)
  const host = new URL(req.redirect_uri).hostname
  return {
    client_name: client?.client_name ?? "MCP client",
    redirect_host: host,
    known_host: KNOWN_REDIRECT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)),
  }
}

/** Issue the message the user signs — it names the app and binds this request. */
export function authorizationChallenge(authzId: string) {
  const d = describeAuthorization(authzId)
  if (!d) throw new OAuthError("invalid_request", "authorization request expired or unknown — start again from your app")
  return issueNonce(
    `Authorize "${d.client_name}" (${d.redirect_host}) to use autoyield as an MCP connector.\n` +
      `It can read public wallet data and prepare transactions. Nothing moves unless you sign each transaction yourself.\n` +
      `Request: ${authzId}`,
  )
}

/** Verify the signed authorization and return where to send the browser. */
export function approveAuthorization(body: any): { redirect: string } {
  const { authz, pubkey, nonce, signatureBase64 } = body ?? {}
  if (typeof authz !== "string" || typeof pubkey !== "string" || typeof nonce !== "string" || typeof signatureBase64 !== "string") {
    throw new OAuthError("invalid_request", "authz, pubkey, nonce, signatureBase64 required")
  }
  const req = pending.get(authz)
  if (!req || req.expiresAt < Date.now()) throw new OAuthError("invalid_request", "authorization request expired or unknown")
  let pk: Uint8Array
  try {
    pk = bs58.decode(pubkey)
  } catch {
    throw new OAuthError("invalid_request", "pubkey must be base58")
  }
  if (pk.length !== 32) throw new OAuthError("invalid_request", "pubkey must decode to 32 bytes")
  const message = consumeNonce(nonce)
  // The nonce must have been issued for THIS request (a plain sign-in nonce,
  // or one for another app, can't approve it).
  if (!message || !message.includes(`\nRequest: ${authz}\n`)) {
    throw new OAuthError("invalid_request", "nonce invalid, expired, or not issued for this authorization")
  }
  const sig = Buffer.from(signatureBase64, "base64")
  if (sig.length !== 64 || !nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pk)) {
    throw new OAuthError("access_denied", "signature does not verify", 401)
  }
  pending.delete(authz) // single-use
  const client = getClient(req.client_id)
  const apiKey = mintApiKey(pubkey, `oauth:${client?.client_name ?? "client"}`)
  const code = randomBytes(32).toString("base64url")
  codes.set(code, {
    apiKey,
    client_id: req.client_id,
    redirect_uri: req.redirect_uri,
    code_challenge: req.code_challenge,
    resource: req.resource,
    expiresAt: Date.now() + CODE_TTL_MS,
  })
  const u = new URL(req.redirect_uri)
  u.searchParams.set("code", code)
  if (req.state) u.searchParams.set("state", req.state)
  return { redirect: u.toString() }
}

/** PURE: RFC 7636 S256. */
export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url")
}

export function exchangeCode(body: any) {
  if (body?.grant_type !== "authorization_code") {
    throw new OAuthError("unsupported_grant_type", "only authorization_code is supported")
  }
  const code = typeof body.code === "string" ? body.code : ""
  const grant = codes.get(code)
  // Single-use: burn the code on ANY attempt, so a wrong verifier can't be retried.
  codes.delete(code)
  if (!grant || grant.expiresAt < Date.now()) throw new OAuthError("invalid_grant", "code invalid, expired, or already used")
  if (body.client_id !== grant.client_id) throw new OAuthError("invalid_grant", "client_id mismatch")
  if (body.redirect_uri !== grant.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri mismatch")
  const verifier = typeof body.code_verifier === "string" ? body.code_verifier : ""
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || pkceS256(verifier) !== grant.code_challenge) {
    throw new OAuthError("invalid_grant", "PKCE verification failed")
  }
  if (body.resource && body.resource !== (grant.resource ?? MCP_RESOURCE)) {
    throw new OAuthError("invalid_target", "resource mismatch")
  }
  return {
    access_token: grant.apiKey,
    token_type: "Bearer",
    expires_in: 60 * 60 * 24 * 365, // nominal; the api key's real lifecycle is server-side (revocable)
    scope: "mcp",
  }
}

/** Test hook. */
export function _resetOAuthState() {
  clients = {}
  pending.clear()
  codes.clear()
}
