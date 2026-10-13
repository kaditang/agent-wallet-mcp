// Jupiter Aggregator v6 — quote + swap construction.
// Docs: https://station.jup.ag/docs/swap-api
// We only use HTTP for now (no on-chain submission yet).

// Host failover. lite-api.jup.ag's quote endpoint started failing whole
// collector runs with nginx 503s (2026-10-11 ×2, 2026-10-13 — every quote
// null) while api.jup.ag served the same request fine; both hosts build swap
// txs. Try api.jup.ag first (optional JUP_API_KEY → x-api-key, for when it
// stops serving keyless traffic), then lite-api. Fail over only on errors a
// different host could fix (network/timeout, 5xx, 429, 401/403) — a 400 means
// the request itself is bad and would fail everywhere.
const JUP_HOSTS = ["https://api.jup.ag", "https://lite-api.jup.ag"]

function jupHeaders(host: string, extra?: Record<string, string>): Record<string, string> {
  const key = process.env.JUP_API_KEY
  return { ...(extra ?? {}), ...(key && host === "https://api.jup.ag" ? { "x-api-key": key } : {}) }
}

/** PURE: should a different Jupiter host be tried after this HTTP status? */
export function isJupFailoverStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 401 || status === 403
}

/** PURE: short, HTML-free error text (an nginx 503 page used to reach the AI verbatim). */
export function jupErrorText(status: number, body: string): string {
  const plain = body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  return `${status}${plain ? ` ${plain.slice(0, 160)}` : ""}`
}

/**
 * Run `path` against each host in order. Exported for the token-search client.
 * Throws the LAST error if every host fails.
 */
export async function jupFetch(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
  label = "jupiter",
): Promise<Response> {
  let lastErr: Error = new Error(`${label}: no hosts`)
  for (const host of JUP_HOSTS) {
    try {
      const r = await fetch(`${host}${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        headers: jupHeaders(host, init.headers),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (r.ok) return r
      const err = new Error(`${label} ${jupErrorText(r.status, await r.text())}`)
      if (!isJupFailoverStatus(r.status)) throw Object.assign(err, { final: true })
      lastErr = err
    } catch (e) {
      if ((e as { final?: boolean }).final) throw e
      lastErr = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw lastErr
}

// All external HTTP calls must time out — a stuck Jupiter connection would
// otherwise pin an Express request slot and snowball at peak load.
// 8s leaves room for a slow Jupiter response while still being well under
// any reasonable client timeout.
const FETCH_TIMEOUT_MS = 8000

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

/**
 * Jupiter's `priceImpactPct` is a FRACTION despite its name ("0.0109" = 1.09%).
 * Verified empirically 2026-10-05: MCDx $100 vs $50k buy quotes differ by 0.94%
 * in realized price while Jupiter reported 0.00157 → 0.01088. Passing the raw
 * string through under a "Pct" label understated impact 100× to the AI/user.
 * Returns a real percentage (4 dp), or null if unparseable.
 */
export function jupImpactToPercent(raw: string | number | undefined | null): number | null {
  const n = Number(raw)
  return raw != null && raw !== "" && Number.isFinite(n) ? Number((n * 100).toFixed(4)) : null
}

export async function jupiterQuote(opts: {
  inputMint: string
  outputMint: string
  amountAtomic: bigint
  slippageBps?: number
}): Promise<JupQuote> {
  const qs = new URLSearchParams({
    inputMint: opts.inputMint,
    outputMint: opts.outputMint,
    amount: opts.amountAtomic.toString(),
    slippageBps: String(opts.slippageBps ?? 50),
  })
  const r = await jupFetch(`/swap/v1/quote?${qs}`, {}, "jupiter quote")
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
  const r = await jupFetch("/swap/v1/swap", {
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
  }, "jupiter swap")
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
