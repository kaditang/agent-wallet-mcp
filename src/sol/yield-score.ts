// Risk-adjusted yield scoring.
//
// Headline APY is the wrong number to rank on — a 12% pool that's 90% reward
// emissions on a $200k unaudited fork is worse than a 6% pool that's pure
// lending base rate on $200M Kamino. This module turns the raw signals
// DefiLlama already gives us (which compare_yields was throwing away) plus
// our own protocol-risk labels into:
//   - riskAdjustedApy: APY discounted by a product of risk factors
//   - riskScore: 0-100 "how safe is this yield stream" (APY-magnitude-free)
//   - riskFactors + riskNotes: a transparent breakdown the AI can explain
//
// Every factor is a multiplier in (0,1], so they compose: a yield weak on
// several axes compounds the discount. Pure functions — unit-tested.

export type RiskFactors = {
  /** 1 = stable APY history, lower = volatile (from DefiLlama sigma). */
  volatility: number
  /** 1 = deep TVL, lower = thin pool (log-scaled). */
  liquidity: number
  /** 1 = battle-tested protocol, lower = riskier (our label / heuristic). */
  protocol: number
  /** 1 = DefiLlama predicts yield holds, lower = predicted to fall. */
  stability: number
  /** 1 = yield is base lending rate, lower = reward-emission-dependent. */
  sustainability: number
  /** 1 = no impermanent-loss exposure, lower = LP/IL risk. */
  ilSafety: number
}

export type ScoredYield = {
  riskAdjustedApy: number
  /** 0-100 composite of the factors (100 = safest). Independent of APY size. */
  riskScore: number
  riskFactors: RiskFactors
  riskNotes: string[]
}

export type RawPoolSignals = {
  apy: number
  apyBase?: number
  apyReward?: number
  tvlUsd: number
  /** DefiLlama APY standard deviation over the sample. */
  sigma?: number
  /** DefiLlama ML prediction class, e.g. "Stable/Up" | "Down". */
  predictedClass?: string
  /** Probability [0,1] attached to predictedClass. */
  predictedProbability?: number
  /** DefiLlama flag for statistically suspicious pools. */
  outlier?: boolean
  /** DefiLlama impermanent-loss flag: "yes" | "no". */
  ilRisk?: string
  /** Our own protocol risk label (from the native-pool registry). */
  protocolRisk?: "low" | "medium" | "high"
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi)
}

/** APY-volatility factor from DefiLlama sigma, relative to the APY itself. */
function volatilityFactor(apy: number, sigma?: number): number {
  if (sigma == null || !Number.isFinite(sigma)) return 0.85 // unknown → mild penalty
  const ratio = sigma / Math.max(apy, 1)
  return clamp(1 - ratio * 0.4, 0.3, 1)
}

/** TVL depth factor, log-scaled around $1M..$100M. */
function liquidityFactor(tvlUsd: number, amountUsdc?: number): number {
  if (!Number.isFinite(tvlUsd) || tvlUsd <= 0) return 0.2
  let f = clamp(0.4 + 0.3 * Math.log10(tvlUsd / 1e6), 0.2, 1)
  // If the user's deposit is a large slice of the pool, exit liquidity +
  // rate-impact concerns — extra discount.
  if (amountUsdc != null && amountUsdc > 0 && amountUsdc > tvlUsd * 0.05) {
    f *= 0.8
  }
  return clamp(f, 0.15, 1)
}

function protocolFactor(risk?: "low" | "medium" | "high"): number {
  switch (risk) {
    case "low":
      return 1
    case "medium":
      return 0.8
    case "high":
      return 0.6
    default:
      return 0.7 // unknown protocol → between medium and high
  }
}

/** DefiLlama ML stability prediction → factor. */
function stabilityFactor(predictedClass?: string, prob?: number): number {
  if (!predictedClass) return 0.9
  const p = clamp(prob ?? 0.5, 0, 1)
  if (/down/i.test(predictedClass)) return clamp(1 - 0.4 * p, 0.5, 1)
  return 1 // "Stable/Up" or anything non-down
}

/** Share of APY that's base lending rate (vs reward emissions). */
function sustainabilityFactor(apy: number, apyBase?: number): number {
  if (apy <= 0) return 0.5
  if (apyBase == null || !Number.isFinite(apyBase)) return 0.85 // unknown split
  const baseShare = clamp(apyBase / apy, 0, 1)
  return clamp(0.5 + 0.5 * baseShare, 0.5, 1)
}

function ilSafetyFactor(ilRisk?: string): number {
  return /yes/i.test(ilRisk ?? "") ? 0.7 : 1
}

export function scoreYield(s: RawPoolSignals, amountUsdc?: number): ScoredYield {
  const volatility = volatilityFactor(s.apy, s.sigma)
  const liquidity = liquidityFactor(s.tvlUsd, amountUsdc)
  const protocol = protocolFactor(s.protocolRisk)
  const stability = stabilityFactor(s.predictedClass, s.predictedProbability)
  const sustainability = sustainabilityFactor(s.apy, s.apyBase)
  const ilSafety = ilSafetyFactor(s.ilRisk)

  // Outlier pools are statistically suspicious — heavy across-the-board cut.
  const outlierMult = s.outlier ? 0.5 : 1

  const composite =
    volatility * liquidity * protocol * stability * sustainability * ilSafety * outlierMult

  const riskAdjustedApy = Number((s.apy * composite).toFixed(4))
  const riskScore = Math.round(composite * 100)

  const notes: string[] = []
  if (volatility < 0.7) notes.push("APY history is volatile (high sigma)")
  if (liquidity < 0.5) notes.push("thin TVL — exit liquidity + rate-impact risk")
  if (protocol < 0.8) notes.push("protocol carries elevated risk")
  if (stability < 0.9) notes.push("DefiLlama models predict the yield may fall")
  if (sustainability < 0.75)
    notes.push("yield is reward-emission-heavy — less sustainable than base rate")
  if (ilSafety < 1) notes.push("impermanent-loss exposure (LP position, not pure lending)")
  if (s.outlier) notes.push("flagged as a statistical outlier — treat with suspicion")

  return {
    riskAdjustedApy,
    riskScore,
    riskFactors: {
      volatility: Number(volatility.toFixed(3)),
      liquidity: Number(liquidity.toFixed(3)),
      protocol: Number(protocol.toFixed(3)),
      stability: Number(stability.toFixed(3)),
      sustainability: Number(sustainability.toFixed(3)),
      ilSafety: Number(ilSafety.toFixed(3)),
    },
    riskNotes: notes,
  }
}
