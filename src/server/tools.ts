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
import { withRpcFallback } from "../sol/connection.js"
import { getTimingSignalForXStock } from "../sol/timing-signal.js"
import { computeRebalance, type RebalanceTarget } from "../sol/rebalance.js"

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
      "Rank USDC lending + tokenized-treasury yields across major chains (Solana, Ethereum, Base, Arbitrum) via DefiLlama, RISK-ADJUSTED. Results are ranked by riskAdjustedApy (not headline APY): each pool's APY is discounted by volatility (sigma), TVL depth, protocol risk, DefiLlama's stability prediction, reward-emission dependence, and IL exposure. Each entry includes riskScore (0-100), riskFactors breakdown, and riskNotes explaining the discount — surface these so the user understands WHY a lower headline APY may be the better pick. Solana protocols (Kamino, MarginFi, Drift, JLP) are executable=true; other chains read-only in V1. topByRiskAdjusted is the one to recommend.",
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
    name: "portfolio_health",
    description:
      "Stateless 'should I do anything?' check for a wallet — the periodic re-engagement tool. Returns holdings (via get_portfolio), compares held yield to the best RISK-ADJUSTED executable yield available right now, and for each held xStock computes its live premium/discount vs the underlying + an entry/exit timing signal (from accumulated microstructure data). Emits actionable `notes` the AI should surface conversationally: e.g. 'your USDY is still the best risk-adjusted option', 'Kamino now offers more', 'the NVDAx you hold is at a +2% premium — rich if you're thinking of selling', 'you have idle USDC earning nothing'. Read-only, no signing. Run it when a user checks in to give them a reason to act (or reassurance to hold).",
    inputSchema: {
      type: "object",
      properties: { wallet: { type: "string", description: "Solana wallet pubkey (base58)" } },
      required: ["wallet"],
    },
  },
  {
    name: "suggest_rebalance",
    description:
      "Discipline tool: given a TARGET allocation, compute the trades that move a wallet toward it. READ-ONLY — it suggests buy/sell USD amounts per asset; the user executes via build_buy_xstock_tx / build_sell_xstock_tx / build_deposit_yield_tx and signs in their own wallet. Allocation base = USDC + held xStocks + held yield tokens (SOL is excluded as gas reserve). Each asset gets current% / target% / drift / deltaUsd (+buy / −sell) / action. Holds assets already within the drift threshold (no churn on noise); flags held assets not in the target (sold to 0). Surface the actions conversationally so the user can approve each trade.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "Solana wallet pubkey (base58)" },
        targets: {
          type: "array",
          description:
            "Target allocation. Each item: { asset, percent }. asset is a ticker (NVDA, SPY), a yield-token symbol (USDY), or 'USDC' for cash. Percents should sum to ~100.",
          items: {
            type: "object",
            properties: {
              asset: { type: "string" },
              percent: { type: "number" },
            },
            required: ["asset", "percent"],
          },
        },
        driftThresholdPct: {
          type: "number",
          description: "Only suggest a trade if drift exceeds this (default 3%).",
        },
        minTradeUsd: {
          type: "number",
          description: "Suppress trades smaller than this USD amount (default 1).",
        },
      },
      required: ["wallet", "targets"],
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

    // Entry-timing signal: compare the live xStock premium vs underlying to
    // its own recent history. Best-effort — never block the quote on it.
    const timing =
      impliedPrice > 0
        ? await getTimingSignalForXStock(ticker, impliedPrice).catch(() => null)
        : null

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
          timing: timing
            ? {
                underlyingUsd: timing.underlyingUsd,
                premiumPct: timing.currentPremiumPct,
                signal: timing.signal,
                zScore: timing.zScore,
                note: timing.note,
              }
            : undefined,
        },
        null,
        2,
      ),
    )
  }

  if (name === "portfolio_health") {
    const { wallet } = z.object({ wallet: z.string().min(32).max(44) }).parse(args)
    const portfolio = await getPortfolio(wallet)

    // Best risk-adjusted executable yield right now (best-effort).
    const yields = await compareYields().catch(() => null)
    const best = yields?.topByRiskAdjusted

    const notes: string[] = []

    // Held yield-token health: compare to the best executable alternative.
    for (const yt of portfolio.yieldTokens) {
      const reg = Object.values(YIELD_TOKENS).find((t) => t.mint === yt.mint)
      const apy = reg?.approxApy
      if (apy != null) {
        notes.push(
          `You hold ${yt.amount.toFixed(4)} ${yt.symbol} (~${apy}% APY, ${reg?.issuer ?? "tokenized treasury"}).`,
        )
        if (best) {
          notes.push(
            `Best risk-adjusted executable USDC lending now: ${best.protocol} at ${best.riskAdjustedApy}% risk-adj (${best.apy}% headline, risk score ${best.riskScore}/100). Note ${yt.symbol} is a treasury-backed security — a different risk profile than DeFi lending, so this isn't apples-to-apples.`,
          )
        }
      }
    }

    // Held xStock timing: live premium/discount vs underlying + signal.
    // PARALLEL — each getTimingSignalForXStock does an external underlying-
    // price fetch (Stooq/Yahoo, 6s timeout). A wallet holding N xStocks must
    // not serialize N fetches (worst case N×6s). Promise.all bounds the whole
    // step at ~one fetch's latency. Audit fix.
    const xstockTiming = (
      await Promise.all(
        portfolio.xstocks.map(async (x) => {
          if (!x.ticker || !x.pricePerShareUsdc || x.pricePerShareUsdc <= 0) return null
          const sig = await getTimingSignalForXStock(
            x.ticker,
            x.pricePerShareUsdc,
          ).catch(() => null)
          return sig ? { symbol: x.symbol, ...sig } : null // sig carries `ticker`
        }),
      )
    ).filter((v): v is NonNullable<typeof v> => v !== null)

    for (const sig of xstockTiming) {
      if (sig.signal === "rich-wait") {
        notes.push(
          `${sig.symbol} you hold is at a +${sig.currentPremiumPct}% premium vs ${sig.ticker} (rich) — relatively expensive if you're considering selling, good if you'd be buying back later.`,
        )
      } else if (sig.signal === "good-entry") {
        notes.push(
          `${sig.symbol} is at ${sig.currentPremiumPct}% premium vs ${sig.ticker} (cheap) — relatively good level if you're adding.`,
        )
      }
    }

    // Idle USDC nudge.
    if (portfolio.usdc > 1 && best) {
      notes.push(
        `${portfolio.usdc.toFixed(2)} idle USDC earning nothing. Best risk-adjusted executable yield: ${best.protocol} ${best.riskAdjustedApy}% risk-adj.`,
      )
    }

    if (notes.length === 0) {
      notes.push("No holdings to report on. Fund the wallet with USDC to get started.")
    }

    return text(
      JSON.stringify(
        {
          asOf: new Date().toISOString(),
          portfolio,
          bestExecutableYield: best,
          xstockTiming,
          notes,
        },
        null,
        2,
      ),
    )
  }

  if (name === "suggest_rebalance") {
    const { wallet, targets, driftThresholdPct, minTradeUsd } = z
      .object({
        wallet: z.string().min(32).max(44),
        targets: z
          .array(
            z.object({
              asset: z.string().min(1).max(12),
              percent: z.number().min(0).max(100),
            }),
          )
          .min(1)
          .max(20),
        driftThresholdPct: z.number().min(0).max(100).optional(),
        minTradeUsd: z.number().min(0).optional(),
      })
      .parse(args)

    const portfolio = await getPortfolio(wallet)

    // Allocation base = USDC + xStocks + yield tokens. SOL excluded (gas).
    const positions = [
      { asset: "USDC", valueUsd: portfolio.usdc },
      ...portfolio.xstocks
        .filter((x) => x.valueUsdc != null)
        .map((x) => ({ asset: (x.ticker ?? x.symbol).toUpperCase(), valueUsd: x.valueUsdc! })),
      ...portfolio.yieldTokens
        .filter((y) => y.valueUsdc != null)
        .map((y) => ({ asset: y.symbol.toUpperCase(), valueUsd: y.valueUsdc! })),
    ]

    const plan = computeRebalance(positions, targets as RebalanceTarget[], {
      driftThresholdPct,
      minTradeUsd,
    })

    // Annotate each action with the tool the user would call to execute it,
    // so the AI can chain straight into building the tx.
    const YIELD_SYMBOLS = new Set(
      Object.values(YIELD_TOKENS).map((t) => t.symbol.toUpperCase()),
    )
    const actions = plan.actions.map((a) => {
      let executeWith: string | null = null
      if (a.action !== "hold" && a.asset !== "USDC") {
        const isYield = YIELD_SYMBOLS.has(a.asset)
        if (a.action === "buy") {
          executeWith = isYield ? "build_deposit_yield_tx" : "build_buy_xstock_tx"
        } else {
          executeWith = isYield ? "build_withdraw_yield_tx" : "build_sell_xstock_tx"
        }
      }
      return { ...a, executeWith }
    })

    return text(
      JSON.stringify(
        {
          asOf: new Date().toISOString(),
          wallet,
          totalUsd: plan.totalUsd,
          targetsSumPct: plan.targetsSumPct,
          driftThresholdPct: driftThresholdPct ?? 3,
          actions,
          notes: plan.notes,
          disclaimer:
            "Suggestion only — not advice. You execute each trade via the build_*_tx tools and sign in your own wallet. SOL excluded from the allocation base (gas reserve).",
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
      // Go through the RPC pool — if Helius (primary) hits a transient,
      // we want to fall through to the public endpoints instead of failing
      // the tx-status lookup. Was using raw solConn (primary only).
      const status = await withRpcFallback((c) =>
        c.getSignatureStatus(signature, { searchTransactionHistory: true }),
      )
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
export const DEFAULT_SLIPPAGE_BPS = 50 // 0.5%
export const MAX_SLIPPAGE_BPS_HARD_CAP = 100 // 1.0% — never accept a wider one

export function clampSlippage(requested: number | undefined): number {
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
