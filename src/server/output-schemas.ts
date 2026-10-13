// MCP output schemas (spec 2025-06-18 `outputSchema` + `structuredContent`).
// Every tool already answers with one JSON object as text; declaring its shape
// lets clients and agents read fields directly instead of re-parsing text.
//
// Deliberately loose: no `required`, extra properties allowed. Some successful
// results are "soft" negatives ({ ok: false, … } or { available: false, … })
// and fields grow over time; the SDK client validates structuredContent against
// this schema, so a strict schema would turn a new field into a client error.
// Only the top-level, stable fields are described.

type Schema = { type: "object"; properties: Record<string, unknown>; additionalProperties: true }

const obj = (properties: Record<string, unknown>): Schema => ({ type: "object", properties, additionalProperties: true })
const s = (description: string) => ({ type: "string", description })
const n = (description: string) => ({ type: "number", description })
const b = (description: string) => ({ type: "boolean", description })
const arr = (description: string) => ({ type: "array", description, items: { type: "object" } })
const o = (description: string) => ({ type: "object", description })

const BUILD_TX = obj({
  ok: b("false when the transaction could not be prepared (see error)"),
  error: s("Why the transaction could not be prepared"),
  signUrl: { type: ["string", "null"], description: "Page where the user reviews and signs in their own wallet (null in local stdio mode)" },
  signId: s("Id of the prepared, unsigned transaction"),
  unsignedTransaction: o("Base64 versioned Solana transaction plus lastValidBlockHeight"),
  serviceDisclaimer: s("Non-custodial notice"),
})

export const OUTPUT_SCHEMAS: Record<string, Schema> = {
  compare_yields: obj({
    asOf: s("ISO timestamp"),
    results: arr("Pools ranked by risk-adjusted APY (protocol, chain, apy, riskAdjustedApy, riskScore, riskNotes, executable)"),
    topExecutable: o("Best risk-adjusted pool autoyield can prepare deposits for"),
    topByRiskAdjustedOverall: o("Best risk-adjusted pool across all chains"),
    rankedBy: s("Ranking key (riskAdjustedApy)"),
  }),
  list_yield_tokens: obj({ tokens: arr("Supported tokenized-treasury tokens") }),
  list_xstocks: obj({
    totalAvailable: n("Number of tokenized stocks supported"),
    returned: n("Number returned in this response"),
    xstocks: arr("Tokenized stocks (ticker, symbol, mint, name)"),
  }),
  quote_tokenized_stock: obj({
    available: b("false when the ticker is not supported or no route exists"),
    ticker: s("Underlying US ticker"),
    symbol: s("Token symbol, e.g. SPYx"),
    mint: s("Token mint address"),
    issuer: s("Token issuer"),
    quote: o("Expected output, price per share, price impact and route"),
    liquiditySnapshotUsd: n("Pool depth snapshot in USD"),
    sizeCost: o("Extra cost of this order size versus a $100 reference order"),
    timing: o("Entry-timing signal: on-chain premium versus the real stock against its own history"),
  }),
  check_xstock_safety: obj({
    ok: b("true when the token passed the safety gate"),
    decision: s("Gate decision"),
    verified: b("Whether the mint matches the issuer's registry"),
    issuer: s("Issuer the token was checked against"),
    reason: s("Why the decision was reached"),
  }),
  get_portfolio: obj({
    wallet: s("Wallet address"),
    asOf: s("ISO timestamp"),
    sol: n("SOL balance"),
    usdc: n("USDC balance"),
    xstocks: arr("Tokenized-stock holdings with shares and USD value"),
    yieldTokens: arr("Yield-token holdings"),
    totalValueUsdc: n("Total value in USDC"),
  }),
  portfolio_health: obj({
    asOf: s("ISO timestamp"),
    portfolio: o("Holdings summary"),
    bestExecutableYield: o("Best risk-adjusted yield available for idle USDC"),
    xstockTiming: arr("Timing signal per held tokenized stock"),
    notes: { type: "array", items: { type: "string" }, description: "Observations (idle cash, premiums, concentration)" },
  }),
  suggest_rebalance: obj({
    asOf: s("ISO timestamp"),
    wallet: s("Wallet address"),
    totalUsd: n("Portfolio value in USD"),
    targetsSumPct: n("Sum of the requested target percentages"),
    driftThresholdPct: n("Drift below which no action is suggested"),
    actions: arr("Suggested buys/sells/deposits to reach the targets"),
    notes: { type: "array", items: { type: "string" }, description: "Caveats" },
    disclaimer: s("Not investment advice"),
  }),
  export_history: obj({
    wallet: s("Wallet address"),
    tradeCount: n("Number of trades found"),
    trades: arr("Trades (time, signature, side, asset, amounts)"),
    csv: s("The same trades as CSV"),
    disclaimer: s("Record-keeping notice"),
  }),
  track_tx: obj({
    signature: s("Transaction signature"),
    found: b("Whether the transaction was found"),
    confirmationStatus: s("processed | confirmed | finalized"),
    ok: { type: ["boolean", "null"], description: "true if it succeeded, false if it failed, null if not yet known" },
    solscanUrl: s("Explorer link"),
  }),
  build_buy_xstock_tx: BUILD_TX,
  build_sell_xstock_tx: BUILD_TX,
  build_deposit_yield_tx: BUILD_TX,
  build_withdraw_yield_tx: BUILD_TX,
}

/** structuredContent for a successful text result, when it is one JSON object. */
export function structuredFromText(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string") return undefined
  try {
    const v = JSON.parse(text)
    return v && typeof v === "object" && !Array.isArray(v) ? v : undefined
  } catch {
    return undefined
  }
}
