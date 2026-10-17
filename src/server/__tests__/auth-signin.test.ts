// Phantom-native signIn (SIWS): the wallet builds the text from our fields, checks the domain
// against the requesting site, signs, and returns the bytes it signed. The server must accept
// those bytes only when they say exactly what it issued for that nonce.
import "./setup.js"
import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { app } from "../index.js"
import { _resetOAuthState } from "../oauth.js"
import { parseSiws, siwsMatches } from "../siws.js"

// Independent copy of the Solana wallet-standard createSignInMessageText — what a wallet does.
function walletText(i: Record<string, string | undefined>): string {
  let m = `${i.domain} wants you to sign in with your Solana account:\n${i.address}`
  if (i.statement) m += `\n\n${i.statement}`
  const f: string[] = []
  if (i.uri) f.push(`URI: ${i.uri}`)
  if (i.version) f.push(`Version: ${i.version}`)
  if (i.chainId) f.push(`Chain ID: ${i.chainId}`)
  if (i.nonce) f.push(`Nonce: ${i.nonce}`)
  if (i.issuedAt) f.push(`Issued At: ${i.issuedAt}`)
  if (i.expirationTime) f.push(`Expiration Time: ${i.expirationTime}`)
  if (i.notBefore) f.push(`Not Before: ${i.notBefore}`)
  if (i.requestId) f.push(`Request ID: ${i.requestId}`)
  if (f.length) m += `\n\n${f.join("\n")}`
  return m
}

const pk = (kp: nacl.SignKeyPair) => bs58.encode(kp.publicKey)
function walletSignIn(kp: nacl.SignKeyPair, input: Record<string, string | undefined>, tweak = (t: string) => t) {
  const text = tweak(walletText({ ...input, address: pk(kp) }))
  const bytes = new TextEncoder().encode(text)
  return {
    signedMessageBase64: Buffer.from(bytes).toString("base64"),
    signatureBase64: Buffer.from(nacl.sign.detached(bytes, kp.secretKey)).toString("base64"),
  }
}

describe("siws parsing and matching", () => {
  const kp = nacl.sign.keyPair()
  const input = {
    domain: "autoyield.org", address: pk(kp), statement: "Sign in.", uri: "https://autoyield.org", version: "1",
    chainId: "mainnet", nonce: "abc12345", issuedAt: "2026-10-17T05:00:00Z", expirationTime: "2026-10-17T05:05:00Z",
  }
  const stored = walletText(input)

  it("parses the wallet layout", () => {
    const p = parseSiws(stored)!
    expect(p.domain).toBe("autoyield.org")
    expect(p.address).toBe(pk(kp))
    expect(p.statement).toBe("Sign in.")
    expect(p.fields.get("Nonce")).toBe("abc12345")
  })

  it("accepts the same fields with re-formatted timestamps", () => {
    expect(siwsMatches(stored, walletText({ ...input, issuedAt: "2026-10-17T05:00:00.000Z" }), pk(kp))).toBe(true)
  })

  it.each([
    ["another domain (lookalike site)", { domain: "autoyie1d.org" }],
    ["another nonce", { nonce: "zzz99999" }],
    ["another statement (purpose)", { statement: "Revoke ALL keys." }],
    ["a later expiry", { expirationTime: "2026-10-17T06:00:00Z" }],
    ["an extra Not Before", { notBefore: "2026-10-17T05:00:00Z" }],
    ["an extra Request ID", { requestId: "x" }],
  ])("refuses %s", (_name, change) => {
    expect(siwsMatches(stored, walletText({ ...input, ...change }), pk(kp))).toBe(false)
  })

  it("refuses another wallet and junk", () => {
    expect(siwsMatches(stored, walletText({ ...input, address: pk(nacl.sign.keyPair()) }), pk(kp))).toBe(false)
    expect(siwsMatches(stored, stored + "\nResources:\n- https://evil", pk(kp))).toBe(false)
    expect(siwsMatches(stored, "hello", pk(kp))).toBe(false)
  })
})

describe("routes accept signIn output", () => {
  beforeEach(() => _resetOAuthState())

  it("login: challenge carries signIn fields; the wallet-built bytes mint a key", async () => {
    const kp = nacl.sign.keyPair()
    const ch = (await request(app).post("/auth/challenge").send({ purpose: "login", pubkey: pk(kp) })).body
    expect(ch.signIn).toMatchObject({ domain: "autoyield.org", address: pk(kp), nonce: ch.nonce, uri: "https://autoyield.org" })
    const r = await request(app).post("/auth/verify").send({ pubkey: pk(kp), nonce: ch.nonce, ...walletSignIn(kp, ch.signIn) })
    expect(r.status).toBe(200)
    expect(r.body.apiKey).toMatch(/^ak_/)
  })

  it("login: wallet bytes for another domain are refused even with a valid signature", async () => {
    const kp = nacl.sign.keyPair()
    const ch = (await request(app).post("/auth/challenge").send({ pubkey: pk(kp) })).body
    const r = await request(app)
      .post("/auth/verify")
      .send({ pubkey: pk(kp), nonce: ch.nonce, ...walletSignIn(kp, { ...ch.signIn, domain: "autoyield.org.evil.example" }) })
    expect(r.status).toBe(400)
  })

  it("revoke_all: signIn output for the revoke challenge works, a login one does not", async () => {
    const kp = nacl.sign.keyPair()
    const login = (await request(app).post("/auth/challenge").send({ pubkey: pk(kp) })).body
    const bad = await request(app)
      .post("/auth/revoke")
      .send({ mode: "all", pubkey: pk(kp), nonce: login.nonce, ...walletSignIn(kp, login.signIn) })
    expect(bad.status).toBe(400)
    const ch = (await request(app).post("/auth/challenge").send({ purpose: "revoke_all", pubkey: pk(kp) })).body
    const ok = await request(app)
      .post("/auth/revoke")
      .send({ mode: "all", pubkey: pk(kp), nonce: ch.nonce, ...walletSignIn(kp, ch.signIn) })
    expect(ok.status).toBe(200)
  })

  it("oauth: /oauth/challenge returns signIn with the request id; approve accepts the wallet bytes", async () => {
    const REDIRECT = "https://claude.ai/api/mcp/auth_callback"
    const reg = await request(app).post("/register").send({ client_name: "Claude", redirect_uris: [REDIRECT] })
    const a = await request(app).get("/oauth/authorize").query({
      response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", code_challenge_method: "S256",
    })
    const authz = new URL(a.headers.location).searchParams.get("authz")!
    const kp = nacl.sign.keyPair()
    const ch = (await request(app).post("/oauth/challenge").send({ authz, pubkey: pk(kp) })).body
    expect(ch.signIn.requestId).toBe(authz)
    const ap = await request(app).post("/oauth/approve").send({ authz, pubkey: pk(kp), nonce: ch.nonce, ...walletSignIn(kp, ch.signIn) })
    expect(ap.status).toBe(200)
    expect(ap.body.redirect).toMatch(/^https:\/\/claude\.ai\//)
  })

  it("an oversized or non-UTF-8 signedMessage is refused", async () => {
    const kp = nacl.sign.keyPair()
    const ch = (await request(app).post("/auth/challenge").send({ pubkey: pk(kp) })).body
    const sig = Buffer.from(new Uint8Array(64)).toString("base64")
    const r = await request(app)
      .post("/auth/verify")
      .send({ pubkey: pk(kp), nonce: ch.nonce, signatureBase64: sig, signedMessageBase64: Buffer.from([0xff, 0xfe]).toString("base64") })
    expect(r.status).toBe(400)
  })
})
