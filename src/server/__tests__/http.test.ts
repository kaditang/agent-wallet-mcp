import "./setup.js"
import { describe, expect, it } from "vitest"
import request from "supertest"
import { app } from "../index.js"

describe("HTTP surface", () => {
  describe("/mcp auth gate", () => {
    it("rejects missing Authorization with 401 + WWW-Authenticate", async () => {
      const r = await request(app).post("/mcp").send({})
      expect(r.status).toBe(401)
      // RFC 6750: clients use this header to learn the auth scheme.
      // mcp-remote and Smithery's gateway both rely on it.
      expect(r.headers["www-authenticate"]).toMatch(/^Bearer\s+realm=/)
    })

    it("rejects unknown Bearer token with 401", async () => {
      const r = await request(app)
        .post("/mcp")
        .set("Authorization", "Bearer not-a-real-key")
        .send({})
      expect(r.status).toBe(401)
    })

    it("accepts DEMO_TOKENS Bearer (auth passes; payload errors are downstream)", async () => {
      // testtok:testuser was set in setup.ts. We don't care what the body
      // does — just that we get past requireAuth (i.e. NOT 401).
      const r = await request(app)
        .post("/mcp")
        .set("Authorization", "Bearer testtok")
        .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      expect(r.status).not.toBe(401)
    })
  })

  describe("/sign/tx/:id", () => {
    it("returns 404 for unknown sign id", async () => {
      const r = await request(app).get("/sign/tx/does-not-exist")
      expect(r.status).toBe(404)
      expect(r.body.error).toMatch(/not found/i)
    })
  })

  describe("/sign/broadcast input validation", () => {
    it("400 when id or signedTxBase64 is missing", async () => {
      const r = await request(app).post("/sign/broadcast").send({ id: "x" })
      expect(r.status).toBe(400)
    })

    it("404 when sign id is unknown", async () => {
      const r = await request(app)
        .post("/sign/broadcast")
        .send({ id: "no-such-id", signedTxBase64: "AA==" })
      expect(r.status).toBe(404)
    })
  })

  describe("/auth/verify", () => {
    it("400 when fields are missing", async () => {
      const r = await request(app).post("/auth/verify").send({})
      expect(r.status).toBe(400)
    })

    it("400 when pubkey is not valid base58", async () => {
      const r = await request(app).post("/auth/verify").send({
        pubkey: "!!! not base58 !!!",
        nonce: "abc",
        signatureBase64: "AA==",
      })
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/base58/)
    })

    it("400 when pubkey decodes to wrong length", async () => {
      // bs58("3yA") is 2 bytes — well short of the 32 ed25519 needs.
      const r = await request(app).post("/auth/verify").send({
        pubkey: "3yA",
        nonce: "abc",
        signatureBase64: "AA==",
      })
      expect(r.status).toBe(400)
      expect(r.body.error).toMatch(/32 bytes/)
    })
  })

  describe("/healthz", () => {
    it("returns ok when at least one RPC responds", async () => {
      const r = await request(app).get("/healthz")
      // We don't actually want to hit a real RPC in CI. Either:
      //   - real RPC reachable → 200 { ok: true, ... }
      //   - real RPC blocked → 503
      // Both are acceptable outcomes; just ensure the JSON shape is right.
      expect([200, 503]).toContain(r.status)
      if (r.status === 200) expect(r.body.ok).toBe(true)
      else expect(r.body.ok).toBe(false)
    })
  })

  describe("/.well-known oauth stubs", () => {
    it("oauth-protected-resource returns 404 (deliberately, for Smithery compat)", async () => {
      const r = await request(app).get("/.well-known/oauth-protected-resource")
      expect(r.status).toBe(404)
    })

    it("oauth-authorization-server returns 404", async () => {
      const r = await request(app).get("/.well-known/oauth-authorization-server")
      expect(r.status).toBe(404)
    })
  })
})
