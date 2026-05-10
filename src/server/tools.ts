// V1 tool surface — Solana RWA + yield service.
// All tools are stateless: we pass `wallet` as an arg, the user signs in their
// own wallet. No multi-tenant store, no EVM dependencies, no custody.

import { z } from "zod"
import { findXStock, SOL_USDC, XSTOCKS } from "../sol/tokens.js"
import { jupiterQuote, jupiterSwapTx } from "../sol/jupiter.js"
import { compareYields } from "../sol/yields.js"
import { getLiveTokenMeta } from "../sol/jupiter-meta.js"
import { stashSignableTx, getSignBaseUrl } from "../sol/sign-store.js"
import { audit } from "./audit.js"
import { getPortfolio } from "../sol/portfolio.js"
import { YIELD_TOKENS, findYieldToken } from "../sol/yield-tokens.js"
import { solConn } from "../sol/connection.js"

// JSON.stringify support for the BigInts that Solana tx fields contain.
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

function text(s: string, isError = false) {
  return { content: [{ type: "text" as const, text: s }], isError }
}

const TOOLS = [
  // ---------------- READ tools (no signing, public data) ----------------
  {
    name: "compare_yields",
    description:
      "Rank current USDC lending and tokenized-treasury yields across major chains (Solana, Ethereum, Base, Arbitrum) using DefiLlama. Solana protocols (Kamino, MarginFi, Drift, JLP) are tagged executable=true; other chains are read-only in V1.",
    inputSchema: {
      type: "object",
      properties: {
        minTvlUsd: { type: "number", description: "Minimum pool TVL filter (default 100000)" },
        amountUsdc: { type: "number", description: "Optional intended deposit size for impact estimation" },
      },
    },
  },
  {
    name: "list_yield_tokens",
    description:
      "List supported tokenized treasury / yield-bearing tokens (USDY by Ondo Finance, more coming). These are SEC-registered securities under non-US prospectus, NOT stablecoins — unaffected by GENIUS/CLARITY Acts that ban stablecoin-issuer interest. Each share appreciates as interest accrues.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_xstocks",
    description:
      "List supported tokenized US equities (Backed xStocks). 16 tickers across mega-cap-tech (NVDA/AAPL/TSLA/MSFT/GOOGL/AMZN/META), crypto-equity (COIN/MSTR/HOOD/CRCL), broad-market-etf (SPY/QQQ), commodity-etf (GLD), consumer (MCD), ai-defense (PLTR). Includes live Jupiter liquidity + USD price. For non-US holders only.",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [
            "mega-cap-tech",
            "crypto-equity",
            "broad-market-etf",
            "commodity-etf",
            "consumer",
            "ai-defense",
          ],
          description: "Optional category filter; omit to return all 16",
        },
      },
    },
  },
  {
    name: "quote_tokenized_stock",
    description:
      "Live Jupiter quote for buying a Backed xStock with USDC on Solana. Returns expected output, price impact, route. READ ONLY — no on-chain action.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "US ticker like NVDA, AAPL, TSLA, SPY" },
        amountUsdc: { type: "string", description: "USDC to spend, e.g. '5'" },
        slippageBps: { type: "number", description: "Slippage tolerance in bps (default 50)" },
      },
      required: ["ticker", "amountUsdc"],
    },
  },
  {
    name: "get_portfolio",
    description:
      "Snapshot a Solana wallet: SOL, USDC, every held xStock or yield token priced via Jupiter. Returns total USD value. Read-only.",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string", description: "Solana wallet pubkey (base58)" } },
      required: ["wallet"],
    },
  },
  {
    name: "track_tx",
    description:
      "Check a Solana transaction's on-chain status. Returns confirmation, success/fail, Solscan URL.",
    inputSchema: {
      type: "object",
      properties: { signature: { type: "string", description: "Solana tx signature (base58)" } },
      required: ["signature"],
    },
  },

  // ---------------- BUILD tools (return unsigned tx + sign URL) ----------------
  {
    name: "build_deposit_yield_tx",
    description:
      "Build (do NOT send) an unsigned Solana transaction that swaps USDC for a yield-bearing tokenized treasury (USDY for non-US users). Returns base64 versioned tx + a one-click sign URL. SERVICE only — user signs in their wallet.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "User's Solana wallet pubkey (base58)" },
        asset: { type: "string", enum: ["usdy"], description: "Yield token slug" },
        amountUsdc: { type: "string", description: "USDC amount to deposit" },
        slippageBps: { type: "number", description: "Slippage in bps (default 50)" },
      },
      required: ["wallet", "asset", "amountUsdc"],
    },
  },
  {
    name: "build_buy_xstock_tx",
    description:
      "Build (do NOT send) an unsigned Solana transaction that swaps USDC for a Backed xStock via Jupiter. Returns base64 versioned tx + sign URL. SERVICE only — user signs in their wallet.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "User's Solana wallet pubkey (base58)" },
        ticker: { type: "string", description: "US ticker e.g. NVDA, AAPL, TSLA, SPY" },
        amountUsdc: { type: "string", description: "USDC to spend" },
        slippageBps: { type: "number", description: "Slippage in bps (default 50)" },
      },
      required: ["wallet", "ticker", "amountUsdc"],
    },
  },
  {
    name: "build_sell_xstock_tx",
    description:
      "Build (do NOT send) an unsigned Solana transaction that sells a Backed xStock back to USDC via Jupiter. Returns base64 versioned tx + sign URL. SERVICE only.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "User's Solana wallet pubkey" },
        ticker: { type: "string", description: "Stock ticker to sell, e.g. NVDA" },
        amountShares: { type: "string", description: "Number of xStock shares to sell, e.g. '0.02'" },
        slippageBps: { type: "number", description: "Slippage in bps (default 50)" },
      },
      required: ["wallet", "ticker", "amountShares"],
    },
  },
  {
    name: "build_withdraw_yield_tx",
    description:
      "Build (do NOT send) an unsigned Solana transaction that swaps a yield-bearing token (e.g. USDY) back to USDC via Jupiter. Returns base64 versioned tx + sign URL.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "User's Solana wallet pubkey" },
        asset: { type: "string", enum: ["usdy"], description: "Yield token slug" },
        amount: { type: "string", description: "Amount of the yield token to redeem (in token units, e.g. '8.5' USDY)" },
        slippageBps: { type: "number", description: "Slippage in bps (default 50)" },
      },
      required: ["wallet", "asset", "amount"],
    },
  },
] as const

export async function dispatch(
  {
    name,
    arguments: args,
  }: {
    name: string
    arguments?: any
  },
  ctx?: { userId?: string },
) {
  // --- READ ---
  if (name === "compare_yields") {
    const { minTvlUsd, amountUsdc } = z
      .object({
        minTvlUsd: z.number().positive().optional(),
        amountUsdc: z.number().positive().optional(),
      })
      .parse(args ?? {})
    const result = await compareYields({ minTvlUsd, amountUsdc })
    return text(JSON.stringify(result, null, 2))
  }

  if (name === "list_yield_tokens") {
    return text(JSON.stringify({ tokens: Object.values(YIELD_TOKENS) }, null, 2))
  }

  if (name === "list_xstocks") {
    const { category } = z
      .object({ category: z.string().optional() })
      .parse(args ?? {})
    // Enrich each entry with live Jupiter liquidity + price (cached 5 min).
    const stocks = Object.values(XSTOCKS).filter(
      (s) => !category || s.category === category,
    )
    const live = await Promise.all(
      stocks.map((s) => getLiveTokenMeta(s.mint).catch(() => null)),
    )
    const enriched = stocks.map((s, i) => ({
      ...s,
      liveLiquidityUsd: live[i]?.liquidityUsd ?? null,
      livePriceUsd: live[i]?.usdPrice ?? null,
      isVerified: live[i]?.isVerified ?? null,
    }))
    return text(
      JSON.stringify(
        {
          totalAvailable: Object.keys(XSTOCKS).length,
          returned: enriched.length,
          ...(category ? { filteredBy: category } : {}),
          xstocks: enriched,
        },
        null,
        2,
      ),
    )
  }

  if (name === "quote_tokenized_stock") {
    const { ticker, amountUsdc, slippageBps } = z
      .object({
        ticker: z.string().min(1).max(8),
        amountUsdc: z.string(),
        slippageBps: z.number().int().min(1).max(10000).optional(),
      })
      .parse(args)

    const stock = findXStock(ticker)
    if (!stock) {
      return text(
        JSON.stringify({ available: false, reason: `${ticker} not in xStocks registry` }, null, 2),
        true,
      )
    }

    const amountAtomic = BigInt(Math.round(Number(amountUsdc) * 1_000_000))
    const q = await jupiterQuote({
      inputMint: SOL_USDC,
      outputMint: stock.mint,
      amountAtomic,
      slippageBps,
    })
    const inUsdc = Number(q.inAmount) / 1e6
    const outShares = Number(q.outAmount) / 10 ** stock.decimals
    const minOutShares = Number(q.otherAmountThreshold) / 10 ** stock.decimals
    const impliedPrice = outShares > 0 ? inUsdc / outShares : 0

    return text(
      JSON.stringify(
        {
          available: true,
          ticker,
          symbol: stock.symbol,
          mint: stock.mint,
          chain: "solana",
          issuer: "Backed (xStocks)",
          quote: {
            inUsdc,
            expectedOut: outShares,
            minOut: minOutShares,
            impliedPricePerShareUsdc: impliedPrice,
            priceImpactPct: q.priceImpactPct,
            routes: q.routePlan.map((r) => ({ amm: r.swapInfo.label, percent: r.percent })),
          },
          liquiditySnapshotUsd: stock.liquidityUsd,
        },
        null,
        2,
      ),
    )
  }

  if (name === "get_portfolio") {
    const { wallet } = z.object({ wallet: z.string().min(32).max(44) }).parse(args)
    const result = await getPortfolio(wallet)
    return text(JSON.stringify(result, null, 2))
  }

  if (name === "track_tx") {
    const { signature } = z.object({ signature: z.string().min(32) }).parse(args)
    try {
      const status = await solConn.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      })
      const v = status.value
      return text(
        JSON.stringify(
          {
            signature,
            found: !!v,
            confirmationStatus: v?.confirmationStatus ?? "not-found",
            slot: v?.slot,
            err: v?.err,
            ok: v ? !v.err : null,
            solscanUrl: `https://solscan.io/tx/${signature}`,
          },
          null,
          2,
        ),
      )
    } catch (e) {
      return text(
        JSON.stringify({ signature, error: (e as Error).message }, null, 2),
        true,
      )
    }
  }

  // --- BUILD ---
  if (name === "build_deposit_yield_tx") {
    const { wallet, asset, amountUsdc, slippageBps } = z
      .object({
        wallet: z.string().min(32).max(44),
        asset: z.string(),
        amountUsdc: z.string(),
        slippageBps: z.number().int().min(1).max(10000).optional(),
      })
      .parse(args)
    const token = findYieldToken(asset)
    if (!token) {
      return text(
        JSON.stringify({
          ok: false,
          reason: `unknown yield asset '${asset}'. Available: ${Object.keys(YIELD_TOKENS).join(", ")}`,
        }),
        true,
      )
    }
    return buildSwapAndStash({
      wallet,
      userId: ctx?.userId,
      inputMint: SOL_USDC,
      inputDecimals: 6,
      inputSymbol: "USDC",
      outputMint: token.mint,
      outputDecimals: token.decimals,
      outputSymbol: token.symbol,
      amountInHuman: amountUsdc,
      slippageBps,
      kind: "deposit_yield",
      protocol: token.slug,
      labelExtra: { issuer: token.issuer, approxApy: token.approxApy, kind: token.kind },
    })
  }

  if (name === "build_buy_xstock_tx") {
    const { wallet, ticker, amountUsdc, slippageBps } = z
      .object({
        wallet: z.string().min(32).max(44),
        ticker: z.string().min(1).max(8),
        amountUsdc: z.string(),
        slippageBps: z.number().int().min(1).max(10000).optional(),
      })
      .parse(args)
    const stock = findXStock(ticker)
    if (!stock) {
      return text(JSON.stringify({ ok: false, reason: `${ticker} not in xStocks registry` }), true)
    }
    return buildSwapAndStash({
      wallet,
      userId: ctx?.userId,
      inputMint: SOL_USDC,
      inputDecimals: 6,
      inputSymbol: "USDC",
      outputMint: stock.mint,
      outputDecimals: stock.decimals,
      outputSymbol: stock.symbol,
      amountInHuman: amountUsdc,
      slippageBps,
      kind: "buy_xstock",
      ticker,
      labelExtra: { issuer: "Backed (xStocks)" },
    })
  }

  if (name === "build_sell_xstock_tx") {
    const { wallet, ticker, amountShares, slippageBps } = z
      .object({
        wallet: z.string().min(32).max(44),
        ticker: z.string().min(1).max(8),
        amountShares: z.string(),
        slippageBps: z.number().int().min(1).max(10000).optional(),
      })
      .parse(args)
    const stock = findXStock(ticker)
    if (!stock) {
      return text(JSON.stringify({ ok: false, reason: `${ticker} not in xStocks registry` }), true)
    }
    return buildSwapAndStash({
      wallet,
      userId: ctx?.userId,
      inputMint: stock.mint,
      inputDecimals: stock.decimals,
      inputSymbol: stock.symbol,
      outputMint: SOL_USDC,
      outputDecimals: 6,
      outputSymbol: "USDC",
      amountInHuman: amountShares,
      slippageBps,
      kind: "sell_xstock",
      ticker,
      symbol: stock.symbol,
      labelExtra: { issuer: "Backed (xStocks)" },
    })
  }

  if (name === "build_withdraw_yield_tx") {
    const { wallet, asset, amount, slippageBps } = z
      .object({
        wallet: z.string().min(32).max(44),
        asset: z.string(),
        amount: z.string(),
        slippageBps: z.number().int().min(1).max(10000).optional(),
      })
      .parse(args)
    const token = findYieldToken(asset)
    if (!token) {
      return text(JSON.stringify({ ok: false, reason: `unknown yield asset '${asset}'` }), true)
    }
    return buildSwapAndStash({
      wallet,
      userId: ctx?.userId,
      inputMint: token.mint,
      inputDecimals: token.decimals,
      inputSymbol: token.symbol,
      outputMint: SOL_USDC,
      outputDecimals: 6,
      outputSymbol: "USDC",
      amountInHuman: amount,
      slippageBps,
      kind: "withdraw_yield",
      protocol: token.slug,
      symbol: token.symbol,
      labelExtra: { issuer: token.issuer },
    })
  }

  return text(`unknown tool: ${name}`, true)
}

// ---------------- shared helper ----------------

/**
 * Hard slippage ceiling — even if a tool caller passes a higher number, we
 * cap it. Default ceiling is 1% (100 bps). Caller can pass a tighter cap;
 * we never widen it beyond MAX_SLIPPAGE_BPS_HARD_CAP.
 */
const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%
const MAX_SLIPPAGE_BPS_HARD_CAP = 100 // 1.0% — never accept a wider one

function clampSlippage(requested: number | undefined): number {
  const eff = requested ?? DEFAULT_SLIPPAGE_BPS
  return Math.min(Math.max(eff, 1), MAX_SLIPPAGE_BPS_HARD_CAP)
}

/**
 * Detect cases where the Jupiter quote is so bad it implies a thin/manipulated
 * pool. We compute the "implied minOut price" vs the expected price; if the
 * gap is more than the slippage cap, we refuse to construct the tx.
 *
 * (This is a sanity net layered on top of Jupiter's own slippageBps.)
 */
function checkPriceImpactSane(
  expectedOut: number,
  minOut: number,
  slippageBps: number,
): { ok: true } | { ok: false; reason: string } {
  if (expectedOut <= 0) {
    return { ok: false, reason: "Jupiter returned zero expected output (no liquidity)" }
  }
  const dropPct = ((expectedOut - minOut) / expectedOut) * 10000 // bps
  if (dropPct > slippageBps + 5) {
    return {
      ok: false,
      reason: `quote min-out drop (${dropPct.toFixed(0)} bps) exceeds slippage cap (${slippageBps} bps) — pool likely too thin`,
    }
  }
  return { ok: true }
}

async function buildSwapAndStash(opts: {
  wallet: string
  /** Authenticated MCP user (the one whose api key built this tx). Stamped on
   *  the sign-store entry for audit traceability. */
  userId?: string
  inputMint: string
  inputDecimals: number
  /** Symbol shown in "Spending" row on the sign page. e.g. "USDC", "USDY", "NVDAx". */
  inputSymbol: string
  outputMint: string
  outputDecimals: number
  outputSymbol: string
  amountInHuman: string
  slippageBps?: number
  kind: "deposit_yield" | "withdraw_yield" | "buy_xstock" | "sell_xstock"
  ticker?: string
  symbol?: string
  protocol?: string
  labelExtra?: Record<string, unknown>
}) {
  // Validate input amount.
  const inHuman = Number(opts.amountInHuman)
  if (!Number.isFinite(inHuman) || inHuman <= 0) {
    return text(
      JSON.stringify({ ok: false, reason: `invalid amount: ${opts.amountInHuman}` }),
      true,
    )
  }
  // Hard upper bound. V1 doesn't need to support institutional sizes; an
  // accidental "amountUsdc": "1000000" should be rejected, not built.
  // Buys are USDC-denominated; sells are token-denominated. The cap is
  // intentionally generous on shares (could be 1000 NVDAx ~ $250k) but tight
  // on USDC. We pick "100000" units in either domain.
  const MAX_AMOUNT_PER_TX = 100_000
  if (inHuman > MAX_AMOUNT_PER_TX) {
    return text(
      JSON.stringify({
        ok: false,
        reason: `amount ${inHuman} exceeds V1 per-tx cap (${MAX_AMOUNT_PER_TX}). Split into smaller txs.`,
      }),
      true,
    )
  }

  // Hard-cap slippage so we never silently accept a wide minOut.
  const slippageBps = clampSlippage(opts.slippageBps)

  const amountAtomic = BigInt(
    Math.round(inHuman * 10 ** opts.inputDecimals),
  )
  const quote = await jupiterQuote({
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    amountAtomic,
    slippageBps,
  })
  const expectedOut = Number(quote.outAmount) / 10 ** opts.outputDecimals
  const minOut = Number(quote.otherAmountThreshold) / 10 ** opts.outputDecimals
  const impliedPrice = expectedOut > 0 ? inHuman / expectedOut : 0

  // Sanity check: refuse construction if Jupiter's minOut implies the pool is
  // too thin (drop bigger than slippage cap).
  const sane = checkPriceImpactSane(expectedOut, minOut, slippageBps)
  if (!sane.ok) {
    return text(
      JSON.stringify(
        {
          ok: false,
          reason: `liquidity check failed: ${sane.reason}`,
          quote: {
            expectedOut,
            minOut,
            slippageBps,
            priceImpactPct: quote.priceImpactPct,
          },
        },
        null,
        2,
      ),
      true,
    )
  }

  const tx = await jupiterSwapTx({ quote, userPublicKey: opts.wallet })

  // For sells/withdraws the input is the user's token (USDY/NVDAx) and the
  // output is USDC; for buys/deposits it's the reverse. Sign page wants to
  // show both legs no matter the direction. valueUsdEstimate is the USDC
  // amount on whichever side is USDC — used for the >$50 high-value confirm.
  const stashKind = opts.kind
  const valueUsdEstimate =
    stashKind === "deposit_yield" || stashKind === "buy_xstock"
      ? inHuman // user is spending USDC → input amount is the dollar value
      : expectedOut // user is receiving USDC → output amount is the dollar value
  const signId = stashSignableTx({
    kind: stashKind,
    wallet: opts.wallet,
    userId: opts.userId,
    ticker: opts.ticker,
    symbol: opts.symbol ?? opts.outputSymbol,
    amountUsdc:
      stashKind === "deposit_yield" || stashKind === "buy_xstock" ? inHuman : undefined,
    expectedOut,
    inputAmount: inHuman,
    inputSymbol: opts.inputSymbol,
    valueUsdEstimate,
    protocol: opts.protocol,
    unsignedTxBase64: tx.swapTransactionBase64,
    lastValidBlockHeight: tx.lastValidBlockHeight,
    // Recipe so sign page can request a fresh tx when blockhash expires.
    rebuildRecipe: {
      inputMint: opts.inputMint,
      inputDecimals: opts.inputDecimals,
      outputMint: opts.outputMint,
      outputDecimals: opts.outputDecimals,
      outputSymbol: opts.outputSymbol,
      amountInHuman: opts.amountInHuman,
      slippageBps, // already clamped
    },
  })
  audit({
    kind: "build_tx",
    signId,
    wallet: opts.wallet,
    txKind: opts.kind,
    amount: inHuman,
    symbol: opts.symbol ?? opts.outputSymbol,
    extra: { expectedOut, slippageBps, userId: opts.userId },
  })
  const signUrl = `${getSignBaseUrl()}/sign.html?id=${signId}`

  return text(
    JSON.stringify(
      {
        ok: true,
        kind: opts.kind,
        ...(opts.ticker ? { ticker: opts.ticker } : {}),
        ...(opts.symbol ? { symbol: opts.symbol } : {}),
        ...(opts.protocol ? { asset: opts.protocol } : {}),
        chain: "solana",
        wallet: opts.wallet,
        quote: {
          inAmount: inHuman,
          inputMint: opts.inputMint,
          expectedOut,
          minOut,
          outputMint: opts.outputMint,
          outputSymbol: opts.outputSymbol,
          impliedPricePerOutputUnit: impliedPrice,
          priceImpactPct: quote.priceImpactPct,
          routes: quote.routePlan.map((r) => ({
            amm: r.swapInfo.label,
            percent: r.percent,
          })),
          slippageBps: quote.slippageBps,
        },
        ...(opts.labelExtra ?? {}),
        signUrl,
        signId,
        unsignedTransaction: {
          encoding: "base64",
          format: "versioned",
          data: tx.swapTransactionBase64,
          lastValidBlockHeight: tx.lastValidBlockHeight,
        },
        serviceDisclaimer:
          "We do not sign or custody. You sign in your wallet. The output token lands at the wallet address you provided.",
      },
      null,
      2,
    ),
  )
}

export function getToolList() {
  return TOOLS
}
