// Yield aggregator — pulls USDC lending rates across chains via DefiLlama,
// then enriches Solana entries with our own protocol-specific metadata.
//
// Free tier: https://yields.llama.fi/pools (no auth, ~10s response, public)

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

export async function compareYields(opts?: {
  minTvlUsd?: number
  amountUsdc?: number
}): Promise<{
  asOf: string
  results: YieldEntry[]
  topExecutable?: YieldEntry
}> {
  const minTvl = opts?.minTvlUsd ?? 100_000

  const r = await fetch(LLAMA)
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

    results.push({
      protocol: native?.slug ?? `${project}-${symbol.toLowerCase()}`,
      chain: String(chain).toLowerCase(),
      asset: symbol,
      apy,
      apyBase: Number(p.apyBase ?? 0) || undefined,
      apyReward: Number(p.apyReward ?? 0) || undefined,
      tvlUsd: tvl,
      poolId: p.pool,
      executable: !!native,
      riskLabel: native?.risk,
      note: !native
        ? `Read-only in V1 — execution arrives in V1.5 for ${chain}.`
        : undefined,
    })
  }

  results.sort((a, b) => b.apy - a.apy)
  const topExecutable = results.find((r) => r.executable)

  return {
    asOf: new Date().toISOString(),
    results: results.slice(0, 20),
    topExecutable,
  }
}
