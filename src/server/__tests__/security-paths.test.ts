// Security-critical paths the global audit flagged as untested:
//   1. /sign/broadcast fee-payer match check (rejects mismatched / malformed
//      / unsigned txs) — the line of code that prevents a 3rd-party signed
//      tx from being broadcast through our RPC quota.
//   2. /sign/rebuild rebuild-cap routing — 21st call returns 429.
//   3. /auth/verify end-to-end: real ed25519 keypair signs the nonce, mints
//      an api key, and the key authenticates /mcp.
//
// These tests close the audit-flagged coverage gap for the real-money path.

import "./setup.js"
import { describe, expect, it } from "vitest"
import request from "supertest"
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { app } from "../index.js"
import {
  REBUILD_CAP_PER_ID,
  reserveRebuild,
  stashSignableTx,
} from "../../sol/sign-store.js"

/** Build a minimal versioned tx with the given fee-payer and sign it.
 *  No-op-style memo program isn't used — we don't need a real instruction;
 *  we only need a fee-payer + valid signature so the /sign/broadcast checks
 *  can verify the fee-payer-match path. */
function buildAndSignTx(keypair: Keypair): string {
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    // Any 32-byte buffer is a valid blockhash format (the RPC will reject the
    // tx on the network for being stale, but our endpoint doesn't care — it
    // only verifies the fee-payer and the signature presence).
    recentBlockhash: bs58.encode(Buffer.alloc(32, 1)),
    instructions: [],
  }).compileToV0Message()
  const vtx = new VersionedTransaction(message)
  vtx.sign([keypair])
  return Buffer.from(vtx.serialize()).toString("base64")
}

describe("/sign/broadcast fee-payer + signature security", () => {
  it("400 when signed tx's fee-payer does not match the stashed wallet", async () => {
    // Stash claims wallet A; signed tx is built for wallet B → reject.
    const walletA = Keypair.generate()
    const walletB = Keypair.generate()
    const id = stashSignableTx({
      kind: "buy_xstock",
      wallet: walletA.publicKey.toBase58(),
      inputAmount: 1,
      inputSymbol: "USDC",
      unsignedTxBase64: "AAAAAA==", // ignored on broadcast path
    })

    const signedTxBase64 = buildAndSignTx(walletB) // wrong wallet
    const r = await request(app)
      .post("/sign/broadcast")
      .send({ id, signedTxBase64 })

    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/fee payer does not match/i)
  })

  it("400 when posted bytes are not a deserializable VersionedTransaction", async () => {
    const wallet = Keypair.generate()
    const id = stashSignableTx({
      kind: "buy_xstock",
      wallet: wallet.publicKey.toBase58(),
      inputAmount: 1,
      inputSymbol: "USDC",
      unsignedTxBase64: "AAAAAA==",
    })
    // Random garbage bytes — should hit the deserialize catch.
    const r = await request(app)
      .post("/sign/broadcast")
      .send({ id, signedTxBase64: Buffer.from("garbage-not-a-tx").toString("base64") })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/deserialize/i)
  })

  it("400 when the signed tx has zero-filled (missing) signatures", async () => {
    const wallet = Keypair.generate()
    const id = stashSignableTx({
      kind: "buy_xstock",
      wallet: wallet.publicKey.toBase58(),
      inputAmount: 1,
      inputSymbol: "USDC",
      unsignedTxBase64: "AAAAAA==",
    })

    // Build the tx but DON'T sign it — signatures slot stays all-zero.
    const message = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: bs58.encode(Buffer.alloc(32, 1)),
      instructions: [],
    }).compileToV0Message()
    const vtx = new VersionedTransaction(message)
    // (no vtx.sign(...) call)
    const signedTxBase64 = Buffer.from(vtx.serialize()).toString("base64")

    const r = await request(app)
      .post("/sign/broadcast")
      .send({ id, signedTxBase64 })
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/missing signatures/i)
  })
})

describe("/sign/rebuild cap routing", () => {
  it("returns 429 once the per-id rebuild cap is exhausted", async () => {
    // Stash a tx WITH a recipe so the route passes the 400 "no rebuild
    // recipe" check and reaches reserveRebuild.
    const id = stashSignableTx({
      kind: "buy_xstock",
      wallet: new PublicKey(Buffer.alloc(32, 7)).toBase58(),
      inputAmount: 1,
      inputSymbol: "USDC",
      unsignedTxBase64: "AAAAAA==",
      rebuildRecipe: {
        inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inputDecimals: 6,
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        outputDecimals: 6,
        outputSymbol: "USDC",
        amountInHuman: "1",
        slippageBps: 50,
      },
    })
    // Exhaust the cap directly via the store (avoids 20 real Jupiter calls).
    for (let i = 0; i < REBUILD_CAP_PER_ID; i++) reserveRebuild(id)

    // 21st rebuild attempt must hit the cap branch — 429 before Jupiter
    // is even touched. This is what defends a leaked sign id from being
    // milked as a free quote oracle.
    const r = await request(app).post(`/sign/rebuild/${id}`)
    expect(r.status).toBe(429)
    expect(r.body.error).toMatch(/rebuild cap/i)
  })
})

describe("/auth/verify e2e: real ed25519 signature → ak_ key → authenticates /mcp", () => {
  it("mints an api key and the key works on /mcp", async () => {
    // 1. Generate a real ed25519 keypair the way Phantom would.
    const kp = nacl.sign.keyPair()
    const pubkey = bs58.encode(kp.publicKey)

    // 2. Get a challenge.
    const chal = await request(app).post("/auth/challenge").send({})
    expect(chal.status).toBe(200)
    expect(chal.body.nonce).toBeTruthy()
    expect(chal.body.message).toBeTruthy()

    // 3. Sign the EXACT message bytes (must use stored message, not rebuilt).
    const messageBytes = new TextEncoder().encode(chal.body.message)
    const sig = nacl.sign.detached(messageBytes, kp.secretKey)
    const signatureBase64 = Buffer.from(sig).toString("base64")

    // 4. Verify → mint api key.
    const verify = await request(app).post("/auth/verify").send({
      pubkey,
      nonce: chal.body.nonce,
      signatureBase64,
      label: "vitest",
    })
    expect(verify.status).toBe(200)
    expect(verify.body.apiKey).toMatch(/^ak_[0-9a-f]{64}$/)
    expect(verify.body.pubkey).toBe(pubkey)

    // 5. Use the key on /mcp — should NOT be 401. (Payload errors are
    // downstream; we only assert we got past requireAuth.)
    const mcp = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${verify.body.apiKey}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(mcp.status).not.toBe(401)
  })

  it("rejects a key after self-revoke (401 on /mcp)", async () => {
    // Mint a key, then revoke it via /auth/revoke mode=self, then verify
    // requireAuth correctly stops accepting it.
    const kp = nacl.sign.keyPair()
    const pubkey = bs58.encode(kp.publicKey)
    const chal = await request(app).post("/auth/challenge").send({})
    const messageBytes = new TextEncoder().encode(chal.body.message)
    const sig = nacl.sign.detached(messageBytes, kp.secretKey)
    const verify = await request(app).post("/auth/verify").send({
      pubkey,
      nonce: chal.body.nonce,
      signatureBase64: Buffer.from(sig).toString("base64"),
    })
    const apiKey = verify.body.apiKey

    const rev = await request(app)
      .post("/auth/revoke")
      .send({ mode: "self", apiKey })
    expect(rev.status).toBe(200)
    expect(rev.body.revoked).toBe(1)

    const mcp = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${apiKey}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    expect(mcp.status).toBe(401)
  })
})
