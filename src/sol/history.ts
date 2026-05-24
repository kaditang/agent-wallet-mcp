// Trade-history export — the "errand running: generate tax records" value
// driver, scoped HONESTLY as a transaction RECORD, not a tax CALCULATION.
// It reconstructs the wallet's tokenized-equity / yield-token trades from
// on-chain history. Execution price is derived from the tx's OWN token
// balance deltas (USDC in/out vs asset in/out) — no external historical
// price feed needed. Explicitly NOT tax advice; a record for the user's
// accountant.
//
// Pure classifier (classifyTrade) is unit-tested; the RPC shell
// (fetchTradeHistory) walks getSignaturesForAddress + getParsedTransaction.

import { SOL_USDC, XSTOCKS } from "./tokens.js"
import { YIELD_TOKENS } from "./yield-tokens.js"
import { withRpcFallback } from "./connection.js"

export type RegistryAsset = {
  symbol: string
  kind: "usdc" | "xstock" | "yield"
}

/** mint -> asset metadata, for the assets we recognize as tradeable. */
export function buildRegistry(): Record<string, RegistryAsset> {
  const reg: Record<string, RegistryAsset> = {
    [SOL_USDC]: { symbol: "USDC", kind: "usdc" },
  }
  for (const x of Object.values(XSTOCKS)) reg[x.mint] = { symbol: x.symbol, kind: "xstock" }
  for (const y of Object.values(YIELD_TOKENS)) reg[y.mint] = { symbol: y.symbol, kind: "yield" }
  return reg
}

export type MintDelta = { mint: string; uiDelta: number } // + received, − sent

export type Trade = {
  action: "buy" | "sell"
  asset: string // the non-USDC asset's symbol
  assetKind: "xstock" | "yield"
  amount: number // asset units traded (absolute)
  usdc: number // USDC spent (buy) or received (sell), absolute
  pricePerUnit: number // usdc / amount
}

/**
 * PURE: classify one tx's per-mint balance deltas (for the wallet) into a
 * trade, or null if it isn't a clean USDC↔asset swap (transfer, multi-asset,
 * airdrop, dust, etc.). Conservative: requires exactly one USDC leg + exactly
 * one non-USDC registry asset leg, moving in opposite directions.
 */
export function classifyTrade(
  deltas: MintDelta[],
  registry: Record<string, RegistryAsset>,
): Trade | null {
  // Keep only meaningful, recognized legs.
  const legs = deltas
    .filter((d) => registry[d.mint] && Math.abs(d.uiDelta) > 1e-9)
    .map((d) => ({ ...d, asset: registry[d.mint] }))

  const usdcLegs = legs.filter((l) => l.asset.kind === "usdc")
  const assetLegs = legs.filter((l) => l.asset.kind !== "usdc")
  if (usdcLegs.length !== 1 || assetLegs.length !== 1) return null

  const usdc = usdcLegs[0]
  const asset = assetLegs[0]
  // Opposite directions: USDC out + asset in = buy; USDC in + asset out = sell.
  if (usdc.uiDelta < 0 && asset.uiDelta > 0) {
    const usdcAbs = Math.abs(usdc.uiDelta)
    return {
      action: "buy",
      asset: asset.asset.symbol,
      assetKind: asset.asset.kind as "xstock" | "yield",
      amount: asset.uiDelta,
      usdc: usdcAbs,
      pricePerUnit: usdcAbs / asset.uiDelta,
    }
  }
  if (usdc.uiDelta > 0 && asset.uiDelta < 0) {
    const assetAbs = Math.abs(asset.uiDelta)
    return {
      action: "sell",
      asset: asset.asset.symbol,
      assetKind: asset.asset.kind as "xstock" | "yield",
      amount: assetAbs,
      usdc: usdc.uiDelta,
      pricePerUnit: usdc.uiDelta / assetAbs,
    }
  }
  return null
}

export type HistoryEntry = Trade & {
  signature: string
  blockTime: number | null
  isoTime: string | null
  solscanUrl: string
}

/**
 * Walk the wallet's recent signatures, parse each tx, and reconstruct the
 * USDC↔(xStock|yield) trades. Capped at `limit` signatures (default 100) to
 * bound RPC load. Read-only.
 */
export async function fetchTradeHistory(
  wallet: string,
  limit = 100,
): Promise<HistoryEntry[]> {
  const registry = buildRegistry()
  const { PublicKey } = await import("@solana/web3.js")
  const pubkey = new PublicKey(wallet)

  const sigs = await withRpcFallback((c) =>
    c.getSignaturesForAddress(pubkey, { limit: Math.min(Math.max(limit, 1), 200) }),
  )

  const entries: HistoryEntry[] = []
  for (const s of sigs) {
    if (s.err) continue // skip failed txs
    let tx
    try {
      tx = await withRpcFallback((c) =>
        c.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        }),
      )
    } catch {
      continue
    }
    if (!tx?.meta) continue

    // Compute per-mint UI-amount deltas for THIS wallet's token accounts.
    const owner = wallet
    const pre = tx.meta.preTokenBalances ?? []
    const post = tx.meta.postTokenBalances ?? []
    const byMint = new Map<string, number>()
    for (const b of pre) {
      if (b.owner !== owner) continue
      byMint.set(b.mint, (byMint.get(b.mint) ?? 0) - (b.uiTokenAmount.uiAmount ?? 0))
    }
    for (const b of post) {
      if (b.owner !== owner) continue
      byMint.set(b.mint, (byMint.get(b.mint) ?? 0) + (b.uiTokenAmount.uiAmount ?? 0))
    }
    const deltas: MintDelta[] = [...byMint.entries()].map(([mint, uiDelta]) => ({ mint, uiDelta }))

    const trade = classifyTrade(deltas, registry)
    if (!trade) continue

    entries.push({
      ...trade,
      signature: s.signature,
      blockTime: s.blockTime ?? null,
      isoTime: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
      solscanUrl: `https://solscan.io/tx/${s.signature}`,
    })
  }
  return entries
}

/** Render entries as a CSV string (for the user's accountant). */
export function toCsv(entries: HistoryEntry[]): string {
  const header = "date,action,asset,amount,usdc,price_per_unit,signature"
  const rows = entries.map((e) =>
    [
      e.isoTime ?? "",
      e.action,
      e.asset,
      e.amount,
      e.usdc,
      e.pricePerUnit.toFixed(6),
      e.signature,
    ].join(","),
  )
  return [header, ...rows].join("\n")
}
