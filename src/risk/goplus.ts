const BASE = "https://api.gopluslabs.io/api/v1"

// GoPlus has no real data on testnets — it returns spurious "honeypot" flags.
// Only run on mainnets where the data is meaningful.
const MAINNET_CHAIN_IDS = new Set([1, 10, 56, 137, 8453, 42161, 43114, 250])

const RISK_FLAGS = [
  "honeypot_related_address",
  "phishing_activities",
  "blackmail_activities",
  "stealing_attack",
  "fake_kyc",
  "malicious_mining_activities",
  "darkweb_transactions",
  "money_laundering",
  "financial_crime",
  "blacklist_doubt",
] as const

export type AddressRisk = {
  ok: boolean
  hits: string[]
  source: "goplus"
  note?: string
}

export async function checkAddressRisk(chainId: number, address: string): Promise<AddressRisk> {
  if (!MAINNET_CHAIN_IDS.has(chainId)) {
    return { ok: true, hits: [], source: "goplus", note: "skipped on testnet" }
  }
  try {
    const r = await fetch(`${BASE}/address_security/${address}?chain_id=${chainId}`)
    if (!r.ok) return { ok: true, hits: [], source: "goplus", note: `lookup ${r.status}, soft-pass` }
    const j: any = await r.json()
    const result = j.result ?? {}
    const hits = RISK_FLAGS.filter((f) => result[f] === "1")
    return { ok: hits.length === 0, hits, source: "goplus" }
  } catch (e) {
    return { ok: true, hits: [], source: "goplus", note: `lookup failed, soft-pass: ${(e as Error).message}` }
  }
}
