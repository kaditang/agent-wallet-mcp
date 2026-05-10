import "dotenv/config"
import express from "express"
import cors from "cors"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { privateKeyToAccount } from "viem/accounts"
import type { Hex } from "viem"
import { requireAuth } from "./auth.js"
import { getUser, putUser } from "../store/users.js"
import { dispatch as toolDispatch, getToolList } from "./tools.js"
import { x402 } from "../x402/middleware.js"
import { runPreflight } from "../risk/aggregate.js"
import { buildEquityBrief } from "../equity/brief.js"
import { chain } from "../config.js"
import { getBalances } from "../sol/balances.js"
import { getSignableTx, recordSignature } from "../sol/sign-store.js"
import { SOL_AGENT_PUBKEY } from "../sol/agent.js"
import {
  buildCreateMultisigIxs,
  freshCreateKey,
  getProgramConfigPda,
  getMultisigPda,
  getVaultPda,
  Period,
} from "../sol/squads.js"
import { PublicKey, Transaction } from "@solana/web3.js"
import { SOL_USDC, XSTOCKS } from "../sol/tokens.js"
import { solConn } from "../sol/connection.js"

const app = express()
app.use(
  cors({
    origin: true,
    credentials: false,
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
)
app.use(express.json({ limit: "1mb" }))

// Solana agent identity — frontend asks "who's the agent I should add?"
app.get("/sol/agent", (_req, res) => {
  if (!SOL_AGENT_PUBKEY) {
    res.status(500).json({ error: "SOL_AGENT_PUBKEY not configured" })
    return
  }
  res.json({ agent: SOL_AGENT_PUBKEY.toBase58() })
})

// Build the unsigned create-multisig transaction. The frontend asks for it,
// has the user sign with Phantom, and sends it. Server returns the PDAs the
// agent will need to track later.
app.post("/sol/grant-plan", requireAuth, async (req, res) => {
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
    const programConfigInfo = await solConn.getAccountInfo(programConfigPda)
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
    const { blockhash } = await solConn.getLatestBlockhash()
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
    res.status(500).json({ error: (e as Error).message })
  }
})

// Frontend confirms after the user signed + the multisig tx confirmed.
// Server stores the PDAs so future agent ops know where the vault is.
const grantConfirmSchema = z.object({
  owner: z.string().min(32).max(44),
  multisigPda: z.string().min(32).max(44),
  vaultPda: z.string().min(32).max(44),
  createKey: z.string().min(32).max(44),
  spendingLimitCreateKey: z.string().min(32).max(44).optional(),
  txSignature: z.string().min(32),
})

app.post("/sol/grant-confirm", requireAuth, async (req, res) => {
  const parsed = grantConfirmSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }
  const existing = await getUser(req.userId!)
  await putUser({
    userId: req.userId!,
    ...(existing ?? {}),
    solana: {
      owner: parsed.data.owner,
      multisigPda: parsed.data.multisigPda,
      vaultPda: parsed.data.vaultPda,
      createKey: parsed.data.createKey,
      spendingLimitCreateKey: parsed.data.spendingLimitCreateKey,
      txSignature: parsed.data.txSignature,
    },
    createdAt: existing?.createdAt ?? Date.now(),
  })
  res.json({ ok: true })
})

// Public sign-page endpoints.
// /sign/tx/:id  → returns the stashed tx for the sign page to load
// /sign/confirm → sign page POSTs back the signature once Phantom signed+sent
app.get("/sign/tx/:id", (req, res) => {
  const tx = getSignableTx(req.params.id)
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

app.post("/sign/confirm", (req, res) => {
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

// Public read-only Solana balance lookup. No auth — anyone can query any address.
app.get("/sol/balances", async (req, res) => {
  const addr = (req.query.address ?? "").toString()
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr)) {
    res.status(400).json({ error: "invalid base58 address" })
    return
  }
  try {
    const r = await getBalances(addr)
    res.json(r)
  } catch (e) {
    res.status(500).json({ error: (e as Error).message })
  }
})

const sessionPk = process.env.AGENT_SESSION_PK as Hex
const sessionPubkey = sessionPk ? privateKeyToAccount(sessionPk).address : ""

// The frontend asks "what session pubkey should I authorize?" — we expose it
// so the user's wallet signs an enable for THIS pubkey.
app.get("/session-pubkey", requireAuth, (_req, res) => {
  res.json({ sessionPubkey })
})

// Frontend posts the signed approval back here once the user grants in their wallet.
const grantSchema = z.object({
  accountAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  approval: z.string().min(1),
  sessionPubkey: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
})

app.post("/grant", requireAuth, async (req, res) => {
  const parsed = grantSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() })
    return
  }
  if (parsed.data.sessionPubkey.toLowerCase() !== sessionPubkey.toLowerCase()) {
    res.status(400).json({ error: "session pubkey mismatch" })
    return
  }
  await putUser({
    userId: req.userId!,
    accountAddress: parsed.data.accountAddress as Hex,
    approval: parsed.data.approval,
    sessionPubkey: parsed.data.sessionPubkey as Hex,
    createdAt: Date.now(),
  })
  res.json({ ok: true })
})

// MCP transport. Stateless: V1 service tools take wallet as an arg, no per-user state.
app.post("/mcp", requireAuth, async (req, res) => {
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

// --- Demo paid endpoint guarded by x402 -------------------------------------
// Any request to /paid-tool/echo MUST first transfer 0.1 USDC to PAY_TO.
// In production, payTo would be the merchant's address. For demo, the user
// sets PAY_TO in .env (e.g. their owner wallet).
const PAY_TO = (process.env.PAY_TO ?? "") as Hex

if (PAY_TO) {
  app.post(
    "/paid-tool/echo",
    x402({ amountUsdc: "0.1", payTo: PAY_TO, description: "echo what you sent" }),
    (req, res) => {
      res.json({
        echoed: req.body,
        receivedAt: new Date().toISOString(),
        paidTxHash: req.header("x-payment-tx"),
      })
    },
  )

  // ===== Pre-flight Risk Gate — the flagship paid product =====
  // Aggregates Tenderly + GoPlus + Blockaid + OFAC + calldata decoding into a
  // single verdict. Any agent should call this before sending a userOp.
  // Free for callers who post X-Payment-Tx; charges 0.02 USDC otherwise.
  const preflightSchema = z.object({
    from: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
    chainId: z.number().int().optional(),
    calls: z
      .array(
        z.object({
          to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
          data: z.string().regex(/^0x[a-fA-F0-9]*$/),
          value: z.string().optional(),
        }),
      )
      .min(1)
      .max(10),
  })

  // ===== Paid equity research brief =====
  // 0.10 USDC per call. Aggregates Yahoo Finance fundamentals, latest SEC
  // filings, and known tokenized counterparts. The downstream LLM uses this
  // to write its bull/bear thesis before placing a trade.
  app.post(
    "/paid/equity-brief",
    x402({
      amountUsdc: "0.10",
      payTo: PAY_TO,
      description: "structured equity research brief: Yahoo fundamentals + SEC filings + tokenized listings",
    }),
    async (req, res) => {
      const ticker = (req.body?.ticker ?? "").toString().trim()
      if (!/^[A-Za-z.\-]{1,8}$/.test(ticker)) {
        res.status(400).json({ error: "ticker must be 1-8 letters" })
        return
      }
      try {
        const brief = await buildEquityBrief(ticker)
        res.json(brief)
      } catch (e) {
        res.status(500).json({ error: (e as Error).message })
      }
    },
  )

  app.post(
    "/risk/preflight",
    x402({
      amountUsdc: "0.02",
      payTo: PAY_TO,
      description: "pre-flight risk gate: aggregates Tenderly + GoPlus + Blockaid + OFAC + calldata decoding into one verdict",
    }),
    async (req, res) => {
      const parsed = preflightSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() })
        return
      }
      try {
        const result = await runPreflight({
          from: parsed.data.from as Hex,
          chainId: parsed.data.chainId ?? chain.id,
          calls: parsed.data.calls.map((c) => ({
            to: c.to as Hex,
            data: c.data as Hex,
            value: c.value ? BigInt(c.value) : 0n,
          })),
        })
        res.json(result)
      } catch (e) {
        res.status(500).json({ error: (e as Error).message })
      }
    },
  )
}

const port = Number(process.env.PORT ?? 3030)
app.listen(port, () => {
  console.log(`http mcp listening on :${port}`)
  console.log(`session pubkey: ${sessionPubkey}`)
  if (PAY_TO) console.log(`paid demo: POST /paid-tool/echo, payTo=${PAY_TO}`)
  else console.log(`(set PAY_TO=0x... in .env to enable /paid-tool/echo)`)
})
