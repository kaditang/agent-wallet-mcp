// Two-rail micro-settlement for agent pay-per-call data feeds.
//
// README.md "Signals to act on" pairs this server with a pay-per-call quant
// signal (StockWaves) over the x402 protocol — an agent that consumes such a
// signal owes a small per-call fee, and an agent that also executes pays that
// fee from its own wallet. This example demonstrates the *settlement rail
// decision* for exactly that recurring micro-payment: the same instruction is
// quoted on two rails, and the cheaper one (for the amount) is picked.
//
//   - 'usdc-solana' — USDC on Solana: a processing fee plus network gas, so a
//     tiny per-call fee costs a floor that the fee itself can exceed.
//   - 'nano-xno'    — Nano (XNO): feeless per transfer, sub-second finality,
//     self-custodial (value is native to the account, so there is no
//     freezeable issuer and no per-transaction gas).
//
// This module is intentionally PURE and keyless: it returns a settlement
// *instruction* that the agent's own wallet signs and broadcasts. Nothing here
// moves funds, holds a key, or touches the network — it only decides and
// describes the rail. That keeps it a drop-in, reviewable example rather than
// a second money path inside the server.
//
// Stand-alone (zero extra dependencies), so it can be read next to the tool
// surface and extended by a maintainer without touching the swap path.

export type RailId = "usdc-solana" | "nano-xno"

export interface SettleQuote {
  rail: RailId
  /** The agent owes this much (USD) for one pay-per-call fetch. */
  amountUsd: number
  /** Rail's processing fee for this amount (USD). Nano rail: 0. */
  feeUsd: number
  /** On-chain confirmation of the transfer. */
  finality: "sub-second" | "seconds"
  /**
   * A short, wallet-readable settlement instruction the agent's wallet acts
   * on (sign + broadcast on EVM/Solana; build+send on Nano).
   */
  instruction: string
}

const SOL_USDC_FEE_BPS = 5 // example processing fee, 0.05%
const NANO_FEE_USD = 0
const NANO_MIN = 100_000_000 // 0.1 XNO in raw units before rounding to 0

/**
 * Quote a settlement instruction for one pay-per-call fee on a given rail.
 * Pure and deterministic; no network, no keys.
 */
export function quoteSettlement(rail: RailId, amountUsd: number): SettleQuote {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error(`amountUsd must be a positive number, got ${amountUsd}`)
  }
  if (rail === "usdc-solana") {
    const feeUsd = Math.round(amountUsd * SOL_USDC_FEE_BPS) / 10_000
    // Micro-amount floor: a transfer leaves the payer a settlement cost on
    // top of gas, so below ~a cent it is uneconomic on a gas rail.
    return {
      rail,
      amountUsd,
      feeUsd,
      finality: "seconds",
      instruction: `pay ${amountUsd.toFixed(6)} USDC on Solana (fee ${feeUsd.toFixed(6)})`,
    }
  }
  // nano-xno: native feeless transfer. Guard the sub-raw-unit edge so a
  // sub-pico amount does not round to an empty transfer.
  const instruction = `send ${amountUsd.toFixed(6)} USDC-worth of XNO to the data feed`
  return {
    rail,
    amountUsd,
    feeUsd: NANO_FEE_USD,
    finality: "sub-second",
    instruction: amountUsd * 1_000_000 < NANO_MIN ? `${instruction} (inline)` : instruction,
  }
}

/**
 * Pick the cheaper rail for a recurring per-call fee. For micro amounts the
 * feeless rail wins; above a size where the other rail's fee no longer
 * dominates, the caller may carry their preferred rail. Pure.
 */
export function pickCheaperRail(amountUsd: number): SettleQuote {
  const nano = quoteSettlement("nano-xno", amountUsd)
  const usdc = quoteSettlement("usdc-solana", amountUsd)
  // Compare total cost (fee), tie-break on finality.
  if (nano.feeUsd < usdc.feeUsd) return nano
  if (usdc.feeUsd < nano.feeUsd) return usdc
  return nano.finality === "sub-second" ? nano : usdc
}
