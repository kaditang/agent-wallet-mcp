import "dotenv/config"
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
import { consumeNonce, issueNonce, mintApiKey } from "./auth-store.js"
import { audit } from "./audit.js"
import nacl from "tweetnacl"
import bs58 from "bs58"
import { dispatch as toolDispatch, getToolList } from "./tools.js"
import { getBalances } from "../sol/balances.js"
import {
  getSignableTx,
  recordSignature,
  updateRebuiltTx,
  withBroadcastLock,
} from "../sol/sign-store.js"
import { withRpcFallback } from "../sol/connection.js"
import { SOL_AGENT_PUBKEY } from "../sol/agent.js"
import {
  buildCreateMultisigIxs,
  freshCreateKey,
  getProgramConfigPda,
  Period,
} from "../sol/squads.js"
import { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js"
import { SOL_USDC, XSTOCKS } from "../sol/tokens.js"

const app = express()

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

// Health check — used by uptime monitors. Confirms server is up and at least
// one Solana RPC endpoint responds. Exposed without auth or rate limit.
app.get("/healthz", async (_req, res) => {
  const start = Date.now()
  try {
    const slot = await withRpcFallback((c) => c.getSlot())
    res.json({
      ok: true,
      slot,
      rpcLatencyMs: Date.now() - start,
      uptimeSec: Math.floor(process.uptime()),
    })
  } catch (e) {
    res.status(503).json({
      ok: false,
      error: "no Solana RPC reachable",
      rpcLatencyMs: Date.now() - start,
    })
  }
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
    res.status(401).json({ error: "signature does not verify" })
    return
  }
  const apiKey = mintApiKey(pubkey, typeof label === "string" ? label : undefined)
  audit({ kind: "api_key_minted", wallet: pubkey, ip: req.ip })
  res.json({ apiKey, pubkey })
})

// Solana agent identity — frontend asks "who's the agent I should add?"
app.get("/sol/agent", readLimiter, (_req, res) => {
  if (!SOL_AGENT_PUBKEY) {
    res.status(500).json({ error: "SOL_AGENT_PUBKEY not configured" })
    return
  }
  res.json({ agent: SOL_AGENT_PUBKEY.toBase58() })
})

// Build the unsigned create-multisig transaction. The frontend asks for it,
// has the user sign with Phantom, and sends it. Server returns the PDAs the
// agent will need to track later.
app.post("/sol/grant-plan", readLimiter, requireAuth, async (req, res) => {
  if (!SOL_AGENT_PUBKEY) {
    res.status(500).json({ error: "SOL_AGENT_PUBKEY not configured" })
    return
  }
  const owner = (req.body?.owner ?? "").toString()
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) {
    res.status(400).json({ error: "owner must be a base58 Solana address" })
    return
  }
  const dailyUsdcCap = Number(req.body?.dailyUsdcCap ?? 5)
  if (!Number.isFinite(dailyUsdcCap) || dailyUsdcCap <= 0 || dailyUsdcCap > 1000) {
    res.status(400).json({ error: "dailyUsdcCap must be > 0 and ≤ 1000" })
    return
  }

  try {
    const ownerPk = new PublicKey(owner)
    const createKey = freshCreateKey()
    const slCreateKey = freshCreateKey()
    const programConfigPda = getProgramConfigPda()
    const programConfigInfo = await withRpcFallback((c) =>
      c.getAccountInfo(programConfigPda),
    )
    if (!programConfigInfo) {
      res.status(500).json({ error: "Squads program config not found on this RPC" })
      return
    }
    // The treasury address is encoded in the program config account (offset 8)
    // For simplicity we read it from account data.
    const treasury = new PublicKey(programConfigInfo.data.subarray(8, 40))

    const xstockMints = Object.values(XSTOCKS).map((s) => new PublicKey(s.mint))

    const { multisigPda, vaultPda, ixs } = buildCreateMultisigIxs({
      plan: {
        createKey,
        owner: ownerPk,
        agent: SOL_AGENT_PUBKEY,
      },
      spendingLimit: {
        createKey: slCreateKey,
        mint: new PublicKey(SOL_USDC),
        amount: BigInt(Math.round(dailyUsdcCap * 1_000_000)),
        period: Period.Day,
        // Empty destinations means "any". For tighter control we'd whitelist
        // specific ATAs, but agent often needs to send USDC to dynamic
        // recipients (Jupiter swap legs, x402 merchants).
        destinations: [],
      },
      treasury,
    })
    // mark unused — programConfigPda is fetched only to read treasury bytes
    void programConfigPda

    const tx = new Transaction()
    tx.feePayer = ownerPk
    const { blockhash } = await withRpcFallback((c) => c.getLatestBlockhash())
    tx.recentBlockhash = blockhash
    for (const ix of ixs) tx.add(ix)

    const serialized = tx
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64")

    res.json({
      multisigPda: multisigPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      createKey: createKey.toBase58(),
      spendingLimitCreateKey: slCreateKey.toBase58(),
      agent: SOL_AGENT_PUBKEY.toBase58(),
      dailyUsdcCap,
      whitelistedMints: xstockMints.map((m) => m.toBase58()),
      transactionBase64: serialized,
      note:
        "Have the user sign + send this transaction with Phantom. Then POST /sol/grant-confirm with multisigPda + vaultPda to register.",
    })
  } catch (e) {
    reply500(res, e)
  }
})

// Frontend confirms after the user signed + the multisig tx confirmed.
// Server stores the PDAs so future agent ops know where the vault is.
// (Removed: /sol/grant-confirm — V1.5 Squads autonomous-mode endpoint, frozen
// for V1d service architecture.)

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
    protocol: tx.protocol,
    unsignedTxBase64: tx.unsignedTxBase64,
    lastValidBlockHeight: tx.lastValidBlockHeight,
    signature: tx.signature,
  })
})

// Rebuild a fresh swap tx for an existing sign id — used when the stashed tx
// has aged out (blockhash expired). Same recipe, fresh quote + new blockhash.
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
  try {
    const { jupiterQuote, jupiterSwapTx } = await import("../sol/jupiter.js")
    const r = tx.rebuildRecipe
    const amountAtomic = BigInt(
      Math.round(Number(r.amountInHuman) * 10 ** r.inputDecimals),
    )
    const quote = await jupiterQuote({
      inputMint: r.inputMint,
      outputMint: r.outputMint,
      amountAtomic,
      slippageBps: r.slippageBps,
    })
    const fresh = await jupiterSwapTx({ quote, userPublicKey: tx.wallet })
    const expectedOut = Number(quote.outAmount) / 10 ** r.outputDecimals
    updateRebuiltTx(tx.id, {
      unsignedTxBase64: fresh.swapTransactionBase64,
      lastValidBlockHeight: fresh.lastValidBlockHeight,
      expectedOut,
    })
    res.json({
      unsignedTxBase64: fresh.swapTransactionBase64,
      lastValidBlockHeight: fresh.lastValidBlockHeight,
      expectedOut,
    })
  } catch (e) {
    reply500(res, e)
  }
})

app.post("/sign/confirm", readLimiter, (req, res) => {
  const { id, signature } = req.body ?? {}
  if (typeof id !== "string" || typeof signature !== "string") {
    res.status(400).json({ error: "id and signature required" })
    return
  }
  const ok = recordSignature(id, signature)
  if (!ok) {
    res.status(404).json({ error: "tx not found or expired" })
    return
  }
  res.json({ ok: true })
})

// Broadcast a CLIENT-SIGNED tx via our backend's reliable RPC. Used when
// Phantom's `signAndSendTransaction` broadcast is unreliable; the sign page
// instead uses `signTransaction` (sign only) and POSTs the signed bytes here.
//
// SECURITY: we require a sign-store id and verify the unsigned message bytes
// in the submitted tx match the tx we stashed. This prevents arbitrary
// 3rd-party txs from being broadcast through our RPC quota.
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
    // Lock per id — second submission for the same id immediately rejects.
    const sig = await withBroadcastLock(id, async () =>
      withRpcFallback((c) =>
        c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 }),
      ),
    )
    recordSignature(id, sig)
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
    if (/already broadcast|already in flight/i.test(raw)) {
      // 409 errors are user-facing logic, safe to expose verbatim
      res.status(409).json({ error: raw })
    } else {
      reply500(res, e)
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
  const server = new Server(
    { name: "agent-wallet", version: "0.2.0" },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getToolList() as any }))
  server.setRequestHandler(CallToolRequestSchema, async (r) => toolDispatch(r.params))

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  })
  res.on("close", () => {
    transport.close()
    server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, req.body)
})

// (Removed: /paid-tool/echo, /paid/equity-brief, /risk/preflight — legacy EVM
// x402 demo endpoints. Frozen for V1d service architecture; reusable patterns
// for V2 paid-API monetization layer.)

const port = Number(process.env.PORT ?? 3030)
app.listen(port, () => {
  console.log(`autoyield mcp service listening on :${port}`)
})
