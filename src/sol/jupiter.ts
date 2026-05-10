// Jupiter Aggregator v6 — quote + swap construction.
// Docs: https://station.jup.ag/docs/swap-api
// We only use HTTP for now (no on-chain submission yet).

const JUP_BASE = "https://lite-api.jup.ag/swap/v1"

export type JupRoutePlanStep = {
  label?: string
  ammKey?: string
  inAmount: string
  outAmount: string
  feeAmount?: string
  feeMint?: string
}

export type JupQuote = {
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  swapMode: string
  slippageBps: number
  priceImpactPct: string
  routePlan: { swapInfo: JupRoutePlanStep; percent: number }[]
}

export async function jupiterQuote(opts: {
  inputMint: string
  outputMint: string
  amountAtomic: bigint
  slippageBps?: number
}): Promise<JupQuote> {
  const url = new URL(`${JUP_BASE}/quote`)
  url.searchParams.set("inputMint", opts.inputMint)
  url.searchParams.set("outputMint", opts.outputMint)
  url.searchParams.set("amount", opts.amountAtomic.toString())
  url.searchParams.set("slippageBps", String(opts.slippageBps ?? 50))
  const r = await fetch(url)
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${await r.text()}`)
  return (await r.json()) as JupQuote
}

export type JupSwapResult = {
  swapTransactionBase64: string
  lastValidBlockHeight: number
  prioritizationFeeLamports?: number
}

/**
 * Ask Jupiter to construct an unsigned versioned transaction for `quote`,
 * with `userPublicKey` as the wallet that will sign + own the output.
 * Returns base64-encoded VersionedTransaction; caller hands to Phantom.
 */
export async function jupiterSwapTx(opts: {
  quote: JupQuote
  userPublicKey: string
  /** Whether to wrap/unwrap SOL automatically (default true). */
  wrapAndUnwrapSol?: boolean
  /** Auto-create destination ATA if missing (default true). */
  asLegacyTransaction?: boolean
}): Promise<JupSwapResult> {
  const r = await fetch(`${JUP_BASE}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: opts.quote,
      userPublicKey: opts.userPublicKey,
      wrapAndUnwrapSol: opts.wrapAndUnwrapSol ?? true,
      asLegacyTransaction: opts.asLegacyTransaction ?? false,
      dynamicComputeUnitLimit: true,
      // "auto" priority fee was too low in practice (txs failed to land).
      // 0.0005 SOL ≈ $0.075 — small but reliably gets included on Solana
      // even under moderate congestion.
      prioritizationFeeLamports: 500000,
    }),
  })
  if (!r.ok) throw new Error(`jupiter swap ${r.status}: ${await r.text()}`)
  const j = (await r.json()) as {
    swapTransaction: string
    lastValidBlockHeight: number
    prioritizationFeeLamports?: number
  }
  return {
    swapTransactionBase64: j.swapTransaction,
    lastValidBlockHeight: j.lastValidBlockHeight,
    prioritizationFeeLamports: j.prioritizationFeeLamports,
  }
}
