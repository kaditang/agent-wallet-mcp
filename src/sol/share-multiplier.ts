// xStocks share multiplier (reinvested dividends).
//
// xStocks reinvest dividends by REBASING. On Solana that is the Token-2022
// `scaledUiAmountConfig` extension: one RAW token (atomic / 10**decimals) is
// worth `multiplier` SHARES. The two units show up in different places, and
// this package used to mix them:
//
//   RAW    — Jupiter quote/swap amounts, on-chain transfers, tx pre/post
//            token balances, the preflight simulation decode.
//   SHARES — getParsedTokenAccountsByOwner `uiAmountString` (the RPC applies
//            the multiplier there — measured: SPYx ratio 1.005715), and the
//            Jupiter token API `usdPrice` (the snapshot history built from it
//            sits at ~0% premium for every ticker).
//
// Mixing them mis-stated every dividend payer by its multiplier (SPYx 0.57%,
// MSFTx 0.59% on 2026-09-10): quotes labelled raw tokens as shares, the live
// entry-timing signal compared a raw-per-token price to a per-share history
// (SPYx read z=+6.7 "unusually HIGH — consider waiting" on every call; correct
// is ~+0.8), portfolio value was overstated, and selling the displayed share
// balance asked for 0.57% more raw tokens than the wallet holds.
//
// Convention after this fix: everything that touches the chain, the sign
// store, rebuild recipes and preflight stays RAW (unchanged, and internally
// consistent). Conversion to/from SHARES happens only at the tool boundary.
// Non-dividend payers (TSLAx/AMZNx/COINx) carry the extension at exactly 1.0,
// so for them nothing changes.

import { PublicKey } from "@solana/web3.js"
import { withRpcFallback } from "./connection.js"

export type ScaledUiCfg = { multiplier: number; newMultiplier: number; effectiveTs: number }

export type ShareMultiplier =
  | { status: "applied"; value: number } // read from the mint's scaledUiAmountConfig
  | { status: "none_on_mint"; value: 1 } // mint read fine, no extension → genuinely 1.0
  | { status: "unavailable"; value: 1 } // could NOT read the mint — 1.0 is a fallback, not a fact

/**
 * PURE: extract the raw config from a jsonParsed mint `info`.
 *   null      → the mint has NO scaled-UI extension (genuinely 1.0)
 *   "invalid" → it HAS one but the value is unusable — must surface as
 *               `unavailable`, NEVER collapse into "no extension = 1.0".
 */
export function parseScaledUiCfg(info: any): ScaledUiCfg | null | "invalid" {
  const ext = Array.isArray(info?.extensions)
    ? info.extensions.find((e: any) => e?.extension === "scaledUiAmountConfig")
    : null
  const st = ext?.state
  if (!st) return ext ? "invalid" : null
  const multiplier = Number(st.multiplier)
  const newMultiplier = Number(st.newMultiplier ?? st.multiplier)
  const effectiveTs = Number(st.newMultiplierEffectiveTimestamp ?? 0)
  // NOT a tight band around 1.0: xStocks apply stock SPLITS through this same
  // multiplier ("stock splits increase balances proportionally"), so a 10:1
  // split makes it ~10 and a 1:10 reverse split ~0.1. A (0.5, 2) band — the
  // first version of this — would have rejected a real split and, worse,
  // reported it as "no extension = 1.0": every price and balance silently off
  // 10x while labelled verified. Reject only what no corporate action produces.
  const sane = (m: number) => Number.isFinite(m) && m >= 1e-3 && m <= 1e3
  if (!sane(multiplier) || !sane(newMultiplier)) return "invalid"
  return { multiplier, newMultiplier, effectiveTs: Number.isFinite(effectiveTs) ? effectiveTs : 0 }
}

/** PURE: the multiplier in force at `nowSec` (newMultiplier takes over at effectiveTs). */
export function effectiveMultiplier(cfg: ScaledUiCfg, nowSec = Date.now() / 1000): number {
  return cfg.effectiveTs > 0 && nowSec >= cfg.effectiveTs ? cfg.newMultiplier : cfg.multiplier
}

// Cache the RAW config, never the derived number: the effective value is
// time-dependent, so caching it would freeze a multiplier across its own
// switch-over. Failed reads are NOT cached (an RPC blip must not pin 1.0).
const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 500
const cache = new Map<string, { ts: number; cfg: ScaledUiCfg | null }>()

export async function getShareMultiplier(mint: string): Promise<ShareMultiplier> {
  const hit = cache.get(mint)
  let cfg: ScaledUiCfg | null
  if (hit && Date.now() - hit.ts < TTL_MS) {
    cfg = hit.cfg
  } else {
    try {
      const res = await withRpcFallback((c) => c.getParsedAccountInfo(new PublicKey(mint)))
      const info = (res.value?.data as any)?.parsed?.info
      if (!info) return { status: "unavailable", value: 1 }
      const parsed = parseScaledUiCfg(info)
      // An unusable extension is not cached (and is not "none"): retry next call.
      if (parsed === "invalid") return { status: "unavailable", value: 1 }
      cfg = parsed
      if (cache.size >= MAX_ENTRIES) cache.clear()
      cache.set(mint, { ts: Date.now(), cfg })
    } catch {
      return { status: "unavailable", value: 1 }
    }
  }
  return cfg ? { status: "applied", value: effectiveMultiplier(cfg) } : { status: "none_on_mint", value: 1 }
}

/** Shares → raw token units (for building a sell from a share count). */
export const sharesToRaw = (shares: number, m: number) => shares / m
/** Raw token units → shares (for displaying what a buy delivers). */
export const rawToShares = (raw: number, m: number) => raw * m

/** Test hook. */
export function _clearShareMultiplierCache() {
  cache.clear()
}
