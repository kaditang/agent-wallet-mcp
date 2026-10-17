// Purpose binding for wallet-signature challenges (external report 2026-10-17).
//
// Before: /auth/verify, /auth/revoke mode=all and /oauth/approve all drew from one untyped nonce
// pool and the signed text said only "Sign in to autoyield.org". One signature phished on a
// lookalike site could be spent on either branch: mint an API key for the victim's wallet, or
// revoke ALL of the victim's keys. Now each nonce is issued for one purpose (and, when the client
// names it, one wallet / one OAuth request) and can only be spent there.
// (Split across two files: the /auth/* routes allow 20 requests/min per IP and each file gets its own app.)
import "./setup.js"
import { describe, expect, it } from "vitest"
import request from "supertest"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { app } from "../index.js"

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

describe("a signature is only good for what it was issued for", () => {
  it("a phished LOGIN signature cannot revoke the victim's keys", async () => {
    const victim = nacl.sign.keyPair()
    const existing = await login(victim)
    // Attacker fetches a login challenge, relays it to the victim on a lookalike page.
    const ch = await challenge({ pubkey: pk(victim) })
    const r = await request(app)
      .post("/auth/revoke")
      .send({ mode: "all", pubkey: pk(victim), nonce: ch.nonce, signatureBase64: sign(ch.message, victim) })
    expect(r.status).toBe(400)
    expect(await keyWorks(existing)).toBe(true)
  })

  it("a REVOKE signature cannot mint a key", async () => {
    const kp = nacl.sign.keyPair()
    const ch = await challenge({ purpose: "revoke_all", pubkey: pk(kp) })
    const r = await request(app)
      .post("/auth/verify")
      .send({ pubkey: pk(kp), nonce: ch.nonce, signatureBase64: sign(ch.message, kp) })
    expect(r.status).toBe(400)
  })

  it("a nonce issued for wallet A cannot be spent by wallet B", async () => {
    const a = nacl.sign.keyPair()
    const b = nacl.sign.keyPair()
    const ch = await challenge({ pubkey: pk(a) })
    const r = await request(app)
      .post("/auth/verify")
      .send({ pubkey: pk(b), nonce: ch.nonce, signatureBase64: sign(ch.message, b) })
    expect(r.status).toBe(400)
  })

  it("a burned nonce stays burned after a wrong-purpose attempt", async () => {
    const kp = nacl.sign.keyPair()
    const ch = await challenge({ pubkey: pk(kp) })
    const sig = sign(ch.message, kp)
    await request(app).post("/auth/revoke").send({ mode: "all", pubkey: pk(kp), nonce: ch.nonce, signatureBase64: sig })
    const r = await request(app).post("/auth/verify").send({ pubkey: pk(kp), nonce: ch.nonce, signatureBase64: sig })
    expect(r.status).toBe(400)
  })

  it("revoke_all with its own nonce revokes every key of the wallet", async () => {
    const kp = nacl.sign.keyPair()
    const k1 = await login(kp)
    const k2 = await login(kp)
    const ch = await challenge({ purpose: "revoke_all", pubkey: pk(kp) })
    const r = await request(app)
      .post("/auth/revoke")
      .send({ mode: "all", pubkey: pk(kp), nonce: ch.nonce, signatureBase64: sign(ch.message, kp) })
    expect(r.status).toBe(200)
    expect(r.body.revoked).toBe(2)
    expect(await keyWorks(k1)).toBe(false)
    expect(await keyWorks(k2)).toBe(false)
  })
})

