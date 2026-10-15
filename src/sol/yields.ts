// Yield aggregator — pulls USDC lending rates across chains via DefiLlama,
// then enriches Solana entries with our own protocol-specific metadata.
//
// Free tier: https://yields.llama.fi/pools (no auth, ~10s response, public)

import { scoreYield, type RiskFactors } from "./yield-score.js"

export type YieldEntry = {
  protocol: string
  chain: string
  asset: string
  apy: number // %
  apyBase?: number
  apyReward?: number
  tvlUsd: number
  poolId: string
  /** True if our V1 can build a deposit tx for this pool. */
  executable: boolean
  note?: string
  riskLabel?: "low" | "medium" | "high"
  /** APY discounted by the risk-factor product — the number to actually rank on. */
  riskAdjustedApy: number
  /** 0-100, how safe the yield stream is (APY-magnitude-free). */
  riskScore: number
  riskFactors: RiskFactors
  riskNotes: string[]
  /** "speculative" = riskScore below SPECULATIVE_BELOW; ranked after every "core" pool. */
  tier: "core" | "speculative"
}

/**
 * riskAdjustedApy discounts the YIELD, but a very weak pool's real risk is
 * the principal. Multiplying a 63.7% headline by a 0.08 composite still gave
 * 5.4% — ranking a thin $0.2M pool (risk score 8) above Compound v3 (86) and
 * Aave (77). Pools scoring below this floor are tiered "speculative" and
 * ranked after every pool that clears it, with a note saying why.
 */
export const SPECULATIVE_BELOW = 25

const LLAMA = "https://yields.llama.fi/pools"

// Pools we natively support: protocol slug -> our internal name
const NATIVE_SOLANA_USDC: Record<string, { slug: string; risk: "low" | "medium" | "high" }> = {
  "kamino-lend": { slug: "kamino-usdc", risk: "low" },
  marginfi: { slug: "marginfi-usdc", risk: "low" },
  drift: { slug: "drift-usdc", risk: "medium" },
  jupiter: { slug: "jlp", risk: "high" }, // JLP is leveraged perps LP — not pure lending
}

const TOKENIZED_TREASURY_PROJECTS = new Set([
  "ondo",
  "ondo-finance",
  "mountain-protocol",
  "blackrock",
  "franklin-templeton",
  "hashnote",
  "superstate",
])

// Reputable non-native protocols (DefiLlama project slug -> risk label).
// Without this every off-Solana pool defaulted to protocolRisk=undefined →
// the scorer's 0.7 "unknown" penalty, which unfairly lumped battle-tested
// blue-chips (Aave, Compound, Maple, Morpho, Fluid, Sky) with random forks.
// These aren't executable in V1 (read-only ranking), but the risk score
// should still reflect that Aave on $3B TVL is not a 0.7-unknown risk.
// Conservative: only protocols with long track records + large TVL get "low";
// newer-but-credible get "medium"; everything unlisted stays unknown (0.7).
const REPUTABLE_PROTOCOLS: Record<string, "low" | "medium" | "high"> = {
  "aave-v3": "low",
  "aave-v2": "low",
  aave: "low",
  "compound-v3": "low",
  compound: "low",
  "morpho-blue": "low",
  morpho: "low",
  "sky-lending": "low",
  makerdao: "low",
  spark: "low",
  "fluid-lending": "low",
  fluid: "low",
  "maple-finance": "medium", // institutional lending — credit risk
  maple: "medium",
  "fluid-lite": "medium",
  goldfinch: "medium", // real-world credit — default risk
  "yearn-finance": "medium", // vault-of-vaults, strategy risk
}

// DefiLlama's /pools is a multi-megabyte list that changes slowly (APYs are
// refreshed roughly hourly). It was downloaded and parsed on EVERY call —
// 1-2.4s per compare_yields / portfolio_health. Cache it for 5 minutes and
// share one in-flight request between concurrent callers. On a failed refresh,
// a stale copy (< 1h) is better than an error.
const LLAMA_TTL_MS = 5 * 60_000
const LLAMA_STALE_OK_MS = 60 * 60_000
let llamaCache: { data: any[]; at: number } | null = null
let llamaInflight: Promise<any[]> | null = null

/** PURE: could compareYields use this pool (before the TVL/APY filters)? */
export function isCandidatePool(p: any): boolean {
  return (
    (p?.symbol || "").toUpperCase() === "USDC" ||
    TOKENIZED_TREASURY_PROJECTS.has((p?.project || "").toLowerCase()) ||
    isStablePendlePt(p)
  )
}

// Pendle principal tokens (PT) on dollar stablecoins: a FIXED rate to maturity, the one thing the
// floating pools above cannot offer. Listed separately (never ranked against lending: different
// product, EVM-only, autoyield cannot prepare it). DefiLlama names them by poolMeta
// "For buying PT-<asset>-<DDMONYYYY>"; the LP rows of the same markets are excluded.
const STABLE_RX = /USD|DAI|GHO|FRAX/
const PT_META_RX = /^For buying (PT-[A-Za-z0-9.+_-]+?-(\d{1,2})([A-Z]{3})(\d{4}))$/
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
const PT_MIN_TVL = 5_000_000

/** PURE */
export function isStablePendlePt(p: any): boolean {
  return (
    (p?.project || "").toLowerCase() === "pendle-v2" &&
    PT_META_RX.test(p?.poolMeta || "") &&
    STABLE_RX.test((p?.symbol || "").toUpperCase())
  )
}

export type FixedRateEntry = {
  protocol: "pendle-v2"
  chain: string
  asset: string
  pt: string
  maturity: string // YYYY-MM-DD
  daysToMaturity: number
  fixedApy: number // %, locked at purchase if held to maturity
  tvlUsd: number
  poolId: string
  executable: false
}

// Measured by the autoyield/StockWaves team 2026-10-15: every expired Pendle market on 13 chains
// with median TVL >= $1M (480), implied APY vs the mean underlying APY from that day to expiry.
export const PENDLE_FIXED_EVIDENCE =
  "Measured over 480 expired Pendle markets (TVL >= $1M, 2024-2026): the fixed rate a PT locked in beat the floating yield actually paid in about 9 of 10, by a median 3.7 APY points 30 days before expiry, shrinking from ~10 points (2024) to ~2-3 (2026). The gap is mostly what floating-side (YT) buyers pay for points/airdrops."

/** PURE: stablecoin Pendle PTs worth showing, largest first. */
export function fixedRateFromPools(pools: any[], now = Date.now(), limit = 5): FixedRateEntry[] {
  const out: FixedRateEntry[] = []
  for (const p of pools) {
    if (!isStablePendlePt(p)) continue
    const tvl = Number(p.tvlUsd ?? 0)
    const apy = Number(p.apy ?? 0)
    if (tvl < PT_MIN_TVL || !(apy > 0 && apy <= 100)) continue
    const m = PT_META_RX.exec(p.poolMeta)!
    const mon = MONTHS.indexOf(m[3])
    if (mon < 0) continue
    const maturity = Date.UTC(Number(m[4]), mon, Number(m[2]))
    const days = Math.floor((maturity - now) / 86_400_000)
    if (days < 7) continue // under a week left: too little to lock to be worth listing
    out.push({
      protocol: "pendle-v2",
      chain: String(p.chain).toLowerCase(),
      asset: String(p.symbol).toUpperCase(),
      pt: m[1],
      maturity: new Date(maturity).toISOString().slice(0, 10),
      daysToMaturity: days,
      fixedApy: Math.round(apy * 100) / 100,
      tvlUsd: Math.round(tvl),
      poolId: p.pool,
      executable: false,
    })
  }
  return out.sort((a, b) => b.tvlUsd - a.tvlUsd).slice(0, limit)
}

async function llamaPools(): Promise<any[]> {
  if (llamaCache && Date.now() - llamaCache.at < LLAMA_TTL_MS) return llamaCache.data
  llamaInflight ??= (async () => {
    try {
      // 8s timeout — DefiLlama is usually <1s but has occasional 30s+ stalls;
      // we'd rather fail fast than pin an Express slot.
      const r = await fetch(LLAMA, { signal: AbortSignal.timeout(8000) })
      if (!r.ok) throw new Error(`defillama ${r.status}`)
      const j = (await r.json()) as { data: any[] }
      // Keep only pools compareYields can ever use: ~500 of ~17k. The full
      // list held ~40MB of heap on a 512MB machine for the cache's lifetime.
      const data = j.data.filter(isCandidatePool)
      llamaCache = { data, at: Date.now() }
      return data
    } catch (e) {
      if (llamaCache && Date.now() - llamaCache.at < LLAMA_STALE_OK_MS) return llamaCache.data
      throw e
    } finally {
      llamaInflight = null
    }
  })()
  return llamaInflight
}

/** Test hook. */
export function _clearYieldsCache() {
  llamaCache = null
  llamaInflight = null
}

export async function compareYields(opts?: {
  minTvlUsd?: number
  amountUsdc?: number
  /** Max results returned (default 20). The research collector passes a large
   *  value to store the whole ranked universe for later backtesting. */
  limit?: number
}): Promise<{
  asOf: string
  results: YieldEntry[]
  /** Best risk-adjusted pool the user can ACT on today (Solana, executable). */
  topExecutable?: YieldEntry
  /** Best risk-adjusted pool ACROSS ALL CHAINS — may be read-only in V1 (e.g.
   *  an Ethereum pool). Surfaces the true market-best even when we can't yet
   *  execute it, so the user sees the full picture, not just the Solana subset. */
  topByRiskAdjustedOverall?: YieldEntry
  /** @deprecated alias of topExecutable, kept for back-compat. The historical
   *  name promised "the one to recommend" but always returned the best
   *  EXECUTABLE pool; callers should use topExecutable (actionable) or
   *  topByRiskAdjustedOverall (true global best) explicitly. */
  topByRiskAdjusted?: YieldEntry
  rankedBy: "riskAdjustedApy"
  /** Read-only: stablecoin Pendle PTs (fixed rate to maturity). Not ranked with
   *  the lending pools above and never executable by autoyield. */
  fixedRateAlternatives?: { note: string; evidence: string; pools: FixedRateEntry[] }
}> {
  const minTvl = opts?.minTvlUsd ?? 100_000

  const j = { data: await llamaPools() }

  const results: YieldEntry[] = []
  for (const p of j.data) {
    const symbol = (p.symbol || "").toUpperCase()
    const project = (p.project || "").toLowerCase()
    const chain = p.chain
    const apy = Number(p.apy ?? 0)
    const tvl = Number(p.tvlUsd ?? 0)

    if (tvl < minTvl) continue
    if (apy <= 0 || apy > 100) continue // filter junk

    // Pure USDC lending: symbol === "USDC"
    const isPureUsdc = symbol === "USDC"
    // Tokenized treasuries (USDM, USDY, BUIDL, OUSG, USDC by Mountain etc.)
    const isTokenizedTreasury = TOKENIZED_TREASURY_PROJECTS.has(project) && tvl >= 1_000_000

    if (!isPureUsdc && !isTokenizedTreasury) continue

    const native = chain === "Solana" ? NATIVE_SOLANA_USDC[project] : undefined
    const apyBase = Number(p.apyBase ?? 0) || undefined
    const apyReward = Number(p.apyReward ?? 0) || undefined

    // Risk-adjust using the signals DefiLlama already returns + our own
    // protocol-risk label. This is the differentiator vs a plain APY sort.
    const scored = scoreYield(
      {
        apy,
        apyBase,
        apyReward,
        tvlUsd: tvl,
        sigma: Number(p.sigma ?? NaN),
        predictedClass: p.predictions?.predictedClass,
        predictedProbability:
          p.predictions?.predictedProbability != null
            ? Number(p.predictions.predictedProbability) / 100
            : undefined,
        outlier: !!p.outlier,
        ilRisk: p.ilRisk,
        // Native Solana label first; else a reputable-protocol label; else
        // undefined → the scorer applies its 0.7 "unknown" penalty.
        protocolRisk: native?.risk ?? REPUTABLE_PROTOCOLS[project],
      },
      opts?.amountUsdc,
    )

    const tier = scored.riskScore < SPECULATIVE_BELOW ? "speculative" : "core"
    results.push({
      protocol: native?.slug ?? `${project}-${symbol.toLowerCase()}`,
      chain: String(chain).toLowerCase(),
      asset: symbol,
      apy,
      apyBase,
      apyReward,
      tvlUsd: tvl,
      poolId: p.pool,
      executable: !!native,
      riskLabel: native?.risk,
      note: !native
        ? `Informational: autoyield does not prepare deposits on ${chain}.`
        : undefined,
      riskAdjustedApy: scored.riskAdjustedApy,
      riskScore: scored.riskScore,
      riskFactors: scored.riskFactors,
      riskNotes:
        tier === "speculative"
          ? [...scored.riskNotes, `risk score ${scored.riskScore}/100 is below ${SPECULATIVE_BELOW} — speculative, ranked after every pool that clears it`]
          : scored.riskNotes,
      tier,
    })
  }

  // Rank by risk-adjusted APY, not headline APY. This is the whole point:
  // a 12% reward-farm on a thin unaudited pool sorts BELOW a 6% pure-lending
  // base rate on deep, battle-tested Kamino.
  // Core pools first, then speculative ones; risk-adjusted APY within each tier.
  results.sort((a, b) => (a.tier === b.tier ? b.riskAdjustedApy - a.riskAdjustedApy : a.tier === "core" ? -1 : 1))
  // results[0] is the global best risk-adjusted pool (may be read-only in V1);
  // topExecutable is the best one the user can actually act on today.
  const topByRiskAdjustedOverall = results[0]
  const topExecutable = results.find((r) => r.executable)
  const fixed = fixedRateFromPools(j.data)

  return {
    asOf: new Date().toISOString(),
    results: results.slice(0, opts?.limit ?? 20),
    topExecutable,
    topByRiskAdjustedOverall,
    topByRiskAdjusted: topExecutable, // deprecated back-compat alias
    rankedBy: "riskAdjustedApy",
    ...(fixed.length
      ? {
          fixedRateAlternatives: {
            note:
              "Read-only, not ranked with the pools above and not executable by autoyield (EVM, Pendle). fixedApy is locked only if held to maturity; before that the PT price moves with rates. It carries the underlying stablecoin's own risk (e.g. sUSDe depends on Ethena's funding-rate basis trade).",
            evidence: PENDLE_FIXED_EVIDENCE,
            pools: fixed,
          },
        }
      : {}),
  }
}
