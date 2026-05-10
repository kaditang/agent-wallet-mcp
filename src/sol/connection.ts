import { Connection } from "@solana/web3.js"

// Multi-RPC connection with automatic fallback. We try the first endpoint;
// on transient failures (5xx, timeouts, "Too Many Requests") we fall through
// to the next. The list is built from env vars + sensible defaults.
//
// Configure in .env:
//   SOL_RPC=<primary>           e.g. Helius / Quicknode / Triton paid endpoint
//   SOL_RPC_FALLBACK_1=<...>    optional secondary
//   SOL_RPC_FALLBACK_2=<...>    optional tertiary

const ENDPOINTS = [
  process.env.SOL_RPC,
  process.env.SOL_RPC_FALLBACK_1,
  process.env.SOL_RPC_FALLBACK_2,
  // Free fallbacks — always at the end so paid endpoints get priority.
  // mainnet-beta is rate-limited; publicnode supports a subset of methods.
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
].filter((u): u is string => !!u && u.startsWith("http"))

// Deduplicate while preserving order
export const SOL_RPC_ENDPOINTS = Array.from(new Set(ENDPOINTS))

if (SOL_RPC_ENDPOINTS.length === 0) {
  throw new Error("no Solana RPC endpoints configured")
}

const TRANSIENT_PATTERNS = [
  /429/,
  /Too Many Requests/i,
  /rate limit/i,
  /timeout/i,
  /ECONNRESET/,
  /EAI_AGAIN/,
  /fetch failed/i,
  /5\d{2}/, // 500-599
]

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return TRANSIENT_PATTERNS.some((p) => p.test(msg))
}

// One Connection per endpoint. Reused across calls.
const pool = SOL_RPC_ENDPOINTS.map((url) => new Connection(url, "confirmed"))

/** The "primary" connection — exported for backward-compat code paths. */
export const solConn = pool[0]

/**
 * Run an RPC call with automatic fallback through the endpoint pool.
 * Each transient error advances to the next endpoint; permanent errors throw immediately.
 */
export async function withRpcFallback<T>(
  fn: (conn: Connection) => Promise<T>,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < pool.length; i++) {
    try {
      return await fn(pool[i])
    } catch (e) {
      lastErr = e
      if (!isTransient(e)) throw e
      // log + try next
      console.warn(
        `[rpc] ${SOL_RPC_ENDPOINTS[i]} transient failure, falling over: ${(e as Error).message?.slice(0, 120)}`,
      )
    }
  }
  throw lastErr ?? new Error("all RPC endpoints exhausted")
}
