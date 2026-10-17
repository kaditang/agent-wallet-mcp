// Purpose binding for wallet-signature challenges (external report 2026-10-17).
//
// Before: /auth/verify, /auth/revoke mode=all and /oauth/approve all drew from one untyped nonce
// pool and the signed text said only "Sign in to autoyield.org". One signature phished on a
// lookalike site could be spent on either branch: mint an API key for the victim's wallet, or
// revoke ALL of the victim's keys. Now each nonce is issued for one purpose (and, when the client
// names it, one wallet / one OAuth request) and can only be spent there.
// (Split across two files: the /auth/* routes allow 20 requests/min per IP and each file gets its own app.)
import "./setup.js"
import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { app } from "../index.js"
import { _resetOAuthState } from "../oauth.js"

const sign = (message: string, kp: nacl.SignKeyPair) =>
  Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)).toString("base64")
const pk = (kp: nacl.SignKeyPair) => bs58.encode(kp.publicKey)

async function challenge(body: object = {}) {
  const r = await request(app).post("/auth/challenge").send(body)
  expect(r.status).toBe(200)
  return r.body as { nonce: string; message: string }
}

async function login(kp: nacl.SignKeyPair) {
  const ch = await challenge({ pubkey: pk(kp) })
  const r = await request(app)
    .post("/auth/verify")
    .send({ pubkey: pk(kp), nonce: ch.nonce, signatureBase64: sign(ch.message, kp) })
  expect(r.status).toBe(200)
  return r.body.apiKey as string
}

const keyWorks = async (apiKey: string) =>
  (await request(app).post("/mcp").set("Authorization", `Bearer ${apiKey}`).send({ jsonrpc: "2.0", id: 1, method: "tools/list" }))
    .status !== 401

describe("challenge message", () => {
  it("uses the SIWS layout: domain first, wallet, purpose statement, URI, expiry", async () => {
    const kp = nacl.sign.keyPair()
    const { nonce, message } = await challenge({ pubkey: pk(kp) })
    const lines = message.split("\n")
    expect(lines[0]).toBe("autoyield.org wants you to sign in with your Solana account:")
    expect(lines[1]).toBe(pk(kp))
    expect(message).toMatch(/does not move funds/)
    expect(message).toContain("\nURI: https://autoyield.org\n")
    expect(message).toContain(`\nNonce: ${nonce}\n`)
    expect(message).toMatch(/\nExpiration Time: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
    expect(nonce).toMatch(/^[0-9a-f]{32}$/)
  })

  it("revoke_all says so, and requires the wallet", async () => {
    const kp = nacl.sign.keyPair()
    expect((await request(app).post("/auth/challenge").send({ purpose: "revoke_all" })).status).toBe(400)
    const { message } = await challenge({ purpose: "revoke_all", pubkey: pk(kp) })
    expect(message).toContain("Revoke ALL autoyield API keys")
  })

  it("rejects unknown purposes and malformed wallets", async () => {
    expect((await request(app).post("/auth/challenge").send({ purpose: "oauth" })).status).toBe(400)
    expect((await request(app).post("/auth/challenge").send({ pubkey: "not-a-key" })).status).toBe(400)
    expect((await request(app).post("/auth/challenge").send({ pubkey: 42 })).status).toBe(400)
  })

  it("still works for an older page that sends no body", async () => {
    const kp = nacl.sign.keyPair()
    const ch = (await request(app).post("/auth/challenge")).body
    expect(ch.message.split("\n")[1]).toBe("") // no wallet line
    const r = await request(app)
      .post("/auth/verify")
      .send({ pubkey: pk(kp), nonce: ch.nonce, signatureBase64: sign(ch.message, kp) })
    expect(r.status).toBe(200)
  })
})

describe("OAuth consent nonces", () => {
  beforeEach(() => _resetOAuthState())

  async function authzId() {
    const reg = await request(app)
      .post("/register")
      .send({ client_name: 'Evil\nRequest ID: x\nApp', redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] })
    const a = await request(app).get("/oauth/authorize").query({
      response_type: "code",
      client_id: reg.body.client_id,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      state: "s",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
    })
    return new URL(a.headers.location).searchParams.get("authz")!
  }

  it("cannot be spent on /auth/verify", async () => {
    const kp = nacl.sign.keyPair()
    const ch = (await request(app).post("/oauth/challenge").send({ authz: await authzId(), pubkey: pk(kp) })).body
    const r = await request(app)
      .post("/auth/verify")
      .send({ pubkey: pk(kp), nonce: ch.nonce, signatureBase64: sign(ch.message, kp) })
    expect(r.status).toBe(400)
  })

  it("names the wallet, keeps the app name on one line, and binds the request", async () => {
    const kp = nacl.sign.keyPair()
    const id = await authzId()
    const ch = (await request(app).post("/oauth/challenge").send({ authz: id, pubkey: pk(kp) })).body
    const lines = ch.message.split("\n")
    expect(lines[1]).toBe(pk(kp))
    expect(lines.filter((l: string) => l.startsWith("Request ID:"))).toEqual([`Request ID: ${id}`])
    // Signed by another wallet than the one the challenge named → refused.
    const other = nacl.sign.keyPair()
    const ap = await request(app)
      .post("/oauth/approve")
      .send({ authz: id, pubkey: pk(other), nonce: ch.nonce, signatureBase64: sign(ch.message, other) })
    expect(ap.status).toBe(400)
  })

  it("rejects a malformed wallet", async () => {
    const r = await request(app).post("/oauth/challenge").send({ authz: await authzId(), pubkey: "nope" })
    expect(r.status).toBe(400)
  })
})
