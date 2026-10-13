import "./setup.js"
import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { createHash, randomBytes } from "node:crypto"
import { app } from "../index.js"
import { _resetOAuthState } from "../oauth.js"

const REDIRECT = "https://claude.ai/api/mcp/auth_callback"
const verifier = () => randomBytes(32).toString("base64url") // 43 chars
const challengeOf = (v: string) => createHash("sha256").update(v).digest("base64url")

async function register(redirect_uris = [REDIRECT]) {
  const r = await request(app).post("/register").send({ client_name: "Claude", redirect_uris })
  return r
}

async function authorize(clientId: string, opts: { verifier: string; redirect?: string; state?: string }) {
  return request(app)
    .get("/oauth/authorize")
    .query({
      response_type: "code",
      client_id: clientId,
      redirect_uri: opts.redirect ?? REDIRECT,
      state: opts.state ?? "st-123",
      code_challenge: challengeOf(opts.verifier),
      code_challenge_method: "S256",
    })
}

/** Drive the consent page's part with a real ed25519 wallet. */
async function approve(authz: string, kp = nacl.sign.keyPair()) {
  const ch = await request(app).post("/oauth/challenge").send({ authz })
  const sig = nacl.sign.detached(new TextEncoder().encode(ch.body.message), kp.secretKey)
  return request(app)
    .post("/oauth/approve")
    .send({
      authz,
      pubkey: bs58.encode(kp.publicKey),
      nonce: ch.body.nonce,
      signatureBase64: Buffer.from(sig).toString("base64"),
    })
}

async function fullFlowUntilCode(state = "st-123") {
  const v = verifier()
  const reg = await register()
  const clientId = reg.body.client_id
  const a = await authorize(clientId, { verifier: v, state })
  const authz = new URL(a.headers.location).searchParams.get("authz")!
  const ap = await approve(authz)
  const cb = new URL(ap.body.redirect)
  return { v, clientId, code: cb.searchParams.get("code")!, cb, authz }
}

describe("OAuth 2.1 remote-connector flow", () => {
  beforeEach(() => _resetOAuthState())

  it("advertises discovery metadata and points 401s at it", async () => {
    const prm = await request(app).get("/.well-known/oauth-protected-resource")
    expect(prm.body.resource).toMatch(/\/mcp$/)
    expect(prm.body.authorization_servers).toHaveLength(1)
    const as = await request(app).get("/.well-known/oauth-authorization-server")
    expect(as.body).toMatchObject({ code_challenge_methods_supported: ["S256"], grant_types_supported: ["authorization_code"] })
    const unauth = await request(app).post("/mcp").send({})
    expect(unauth.status).toBe(401)
    expect(unauth.headers["www-authenticate"]).toMatch(/resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/)
  })

  it("end to end: register → authorize → consent+sign → code → token → authenticated MCP call", async () => {
    const { v, clientId, code, cb, authz } = await fullFlowUntilCode("xyz")
    expect(cb.origin + cb.pathname).toBe(REDIRECT)
    expect(cb.searchParams.get("state")).toBe("xyz")
    expect(code).not.toMatch(/^ak_/) // the api key must never travel in a URL
    expect(authz).toBeTruthy()

    const tok = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v })
    expect(tok.status).toBe(200)
    expect(tok.headers["cache-control"]).toBe("no-store")
    expect(tok.body.token_type).toBe("Bearer")

    const mcp = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${tok.body.access_token}`)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(mcp.status).toBe(200)
  })

  it("consent page sees the app name and redirect host", async () => {
    const reg = await register()
    const a = await authorize(reg.body.client_id, { verifier: verifier() })
    const authz = new URL(a.headers.location).searchParams.get("authz")!
    const d = await request(app).get(`/oauth/request/${authz}`)
    expect(d.body).toEqual({ client_name: "Claude", redirect_host: "claude.ai", known_host: true })
    const ch = await request(app).post("/oauth/challenge").send({ authz })
    expect(ch.body.message).toContain('Authorize "Claude" (claude.ai)')
  })

  describe("rejects", () => {
    it("non-https redirect URIs at registration (http only on loopback)", async () => {
      expect((await register(["http://evil.example/cb"])).status).toBe(400)
      expect((await register(["javascript:alert(1)"])).status).toBe(400)
      expect((await register(["http://localhost:6274/cb"])).status).toBe(201)
    })

    it("unregistered redirect_uri at authorize — 400, NOT a redirect", async () => {
      const reg = await register()
      const a = await authorize(reg.body.client_id, { verifier: verifier(), redirect: "https://attacker.example/cb" })
      expect(a.status).toBe(400)
      expect(a.headers.location).toBeUndefined()
    })

    it("missing PKCE — error redirected to the (registered) client", async () => {
      const reg = await register()
      const a = await request(app)
        .get("/oauth/authorize")
        .query({ response_type: "code", client_id: reg.body.client_id, redirect_uri: REDIRECT, state: "s" })
      expect(a.status).toBe(302)
      const u = new URL(a.headers.location)
      expect(u.origin + u.pathname).toBe(REDIRECT)
      expect(u.searchParams.get("error")).toBe("invalid_request")
    })

    it("a plain sign-in nonce cannot approve an authorization", async () => {
      const reg = await register()
      const a = await authorize(reg.body.client_id, { verifier: verifier() })
      const authz = new URL(a.headers.location).searchParams.get("authz")!
      const kp = nacl.sign.keyPair()
      const ch = await request(app).post("/auth/challenge") // generic login nonce
      const sig = nacl.sign.detached(new TextEncoder().encode(ch.body.message), kp.secretKey)
      const ap = await request(app).post("/oauth/approve").send({
        authz,
        pubkey: bs58.encode(kp.publicKey),
        nonce: ch.body.nonce,
        signatureBase64: Buffer.from(sig).toString("base64"),
      })
      expect(ap.status).toBe(400)
    })

    it("a bad signature", async () => {
      const reg = await register()
      const a = await authorize(reg.body.client_id, { verifier: verifier() })
      const authz = new URL(a.headers.location).searchParams.get("authz")!
      const ch = await request(app).post("/oauth/challenge").send({ authz })
      const ap = await request(app).post("/oauth/approve").send({
        authz,
        pubkey: bs58.encode(nacl.sign.keyPair().publicKey),
        nonce: ch.body.nonce,
        signatureBase64: Buffer.from(new Uint8Array(64)).toString("base64"),
      })
      expect(ap.status).toBe(401)
    })

    it("wrong PKCE verifier — and the code is burned (no retry)", async () => {
      const { v, clientId, code } = await fullFlowUntilCode()
      const bad = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier(),
      })
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe("invalid_grant")
      const retry = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v,
      })
      expect(retry.status).toBe(400)
    })

    it("code reuse, and client_id / redirect_uri mismatch", async () => {
      const { v, clientId, code } = await fullFlowUntilCode()
      const ok = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v,
      })
      expect(ok.status).toBe(200)
      const again = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: v,
      })
      expect(again.status).toBe(400)

      const f2 = await fullFlowUntilCode()
      const wrongClient = await request(app).post("/oauth/token").send({
        grant_type: "authorization_code", code: f2.code, client_id: "c_other", redirect_uri: REDIRECT, code_verifier: f2.v,
      })
      expect(wrongClient.status).toBe(400)
    })

    it("an authorization request can be approved only once", async () => {
      const reg = await register()
      const a = await authorize(reg.body.client_id, { verifier: verifier() })
      const authz = new URL(a.headers.location).searchParams.get("authz")!
      expect((await approve(authz)).status).toBe(200)
      expect((await request(app).post("/oauth/challenge").send({ authz })).status).toBe(400)
    })
  })
})
