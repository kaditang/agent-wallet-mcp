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
import { PublicKey, Transaction } from "@solana/web3.js"
import { SOL_USDC, XSTOCKS } from "../sol/tokens.js"

const app = express()

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
    const stashedRaw = Buffer.from(stashed.unsignedTxBase64, "base64")

    // VersionedTransaction format: [signatures...][message bytes].
    // Signatures section length = num_signatures (compact-u16) + 64 * num_signatures.
    // We compare the message bytes only — those must equal what we built.
    const msgFromSigned = extractVersionedMessage(raw)
    const msgFromStashed = extractVersionedMessage(stashedRaw)
    if (
      !msgFromSigned ||
      !msgFromStashed ||
      !msgFromSigned.equals(msgFromStashed)
    ) {
      res.status(400).json({
        error: "signed tx message does not match the stashed unsigned tx",
      })
      return
    }

    // Lock per id — second submission for the same id immediately rejects.
    const sig = await withBroadcastLock(id, async () =>
      withRpcFallback((c) =>
        c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 }),
      ),
    )
    recordSignature(id, sig)
    res.json({ signature: sig, solscanUrl: `https://solscan.io/tx/${sig}` })
  } catch (e) {
    const raw = (e as Error).message ?? ""
    if (/already broadcast|already in flight/i.test(raw)) {
      // 409 errors are user-facing logic, safe to expose verbatim
      res.status(409).json({ error: raw })
    } else {
      reply500(res, e)
    }
  }
})

// Decode the compact-u16 num_signatures prefix and skip past signatures to
// reach the message bytes. Returns null if the buffer is malformed.
function extractVersionedMessage(buf: Buffer): Buffer | null {
  if (buf.length < 1) return null
  // compact-u16 decode
  let offset = 0
  let len = 0
  let shift = 0
  while (offset < buf.length) {
    const b = buf[offset]
    offset++
    len |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 14) return null
  }
  // Skip num_signatures × 64 bytes
  const sigsLen = len * 64
  const msgStart = offset + sigsLen
  if (msgStart > buf.length) return null
  return buf.subarray(msgStart)
}

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
