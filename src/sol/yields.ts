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
}

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

export async function compareYields(opts?: {
  minTvlUsd?: number
  amountUsdc?: number
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
}> {
  const minTvl = opts?.minTvlUsd ?? 100_000

  // 8s timeout — DefiLlama is usually <1s but has occasional 30s+ stalls;
  // we'd rather fail fast than pin an Express slot.
  const r = await fetch(LLAMA, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`defillama ${r.status}`)
  const j = (await r.json()) as { data: any[] }

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
        ? `Read-only in V1 — execution arrives in V1.5 for ${chain}.`
        : undefined,
      riskAdjustedApy: scored.riskAdjustedApy,
      riskScore: scored.riskScore,
      riskFactors: scored.riskFactors,
      riskNotes: scored.riskNotes,
    })
  }

  // Rank by risk-adjusted APY, not headline APY. This is the whole point:
  // a 12% reward-farm on a thin unaudited pool sorts BELOW a 6% pure-lending
  // base rate on deep, battle-tested Kamino.
  results.sort((a, b) => b.riskAdjustedApy - a.riskAdjustedApy)
  // results[0] is the global best risk-adjusted pool (may be read-only in V1);
  // topExecutable is the best one the user can actually act on today.
  const topByRiskAdjustedOverall = results[0]
  const topExecutable = results.find((r) => r.executable)

  return {
    asOf: new Date().toISOString(),
    results: results.slice(0, 20),
    topExecutable,
    topByRiskAdjustedOverall,
    topByRiskAdjusted: topExecutable, // deprecated back-compat alias
    rankedBy: "riskAdjustedApy",
  }
}
