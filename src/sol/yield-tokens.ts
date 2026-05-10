// Yield-bearing tokenized assets — separate from xStocks because they're
// stables/treasury exposures, not equities. All swap-routable via Jupiter.

export type YieldToken = {
  /** External-friendly slug used in MCP tool args. */
  slug: "usdy" | "usdm"
  symbol: string
  name: string
  mint: string
  decimals: number
  /** Issuer / kind for the AI to explain in plain language. */
  issuer: string
  kind: "tokenized-treasury" | "yield-bearing-stable"
  /** Approximate APY at time of last registry edit. Real-time TBD. */
  approxApy?: number
  /** Notes the AI can surface to the user. */
  notes?: string
  forUsPersons: boolean
}

export const YIELD_TOKENS: Record<string, YieldToken> = {
  usdy: {
    slug: "usdy",
    symbol: "USDY",
    name: "Ondo US Dollar Yield",
    mint: "A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6",
    decimals: 6,
    issuer: "Ondo Finance",
    kind: "tokenized-treasury",
    approxApy: 4.6,
    forUsPersons: false,
    notes:
      "Backed by short-term US Treasuries. Each token grows in value over time as interest accrues — price > $1, not a 1:1 stable. Open to non-US investors. Held by you in your own wallet, no KYC for the token itself.",
  },
}

export function findYieldToken(slug: string): YieldToken | undefined {
  return YIELD_TOKENS[slug.toLowerCase() as keyof typeof YIELD_TOKENS]
}
