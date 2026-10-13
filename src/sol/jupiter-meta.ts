import { jupFetch } from "./jupiter.js"
// Jupiter token metadata helpers — live liquidity + verification flag.
// Cached for 5 minutes per mint so list_xstocks / quote tools don't hammer
// Jupiter's search endpoint.

const TTL_MS = 5 * 60 * 1000

type CacheEntry = {
  liquidityUsd: number
  isVerified: boolean
  usdPrice: number | null
  fetchedAt: number
}

const cache = new Map<string, CacheEntry>()

export type LiveTokenMeta = {
  mint: string
  liquidityUsd: number
  isVerified: boolean
  usdPrice: number | null
  cached: boolean
  staleMs: number
}

export async function getLiveTokenMeta(mint: string): Promise<LiveTokenMeta> {
  const hit = cache.get(mint)
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) {
    return {
      mint,
      liquidityUsd: hit.liquidityUsd,
      isVerified: hit.isVerified,
      usdPrice: hit.usdPrice,
      cached: true,
      staleMs: Date.now() - hit.fetchedAt,
    }
  }
  try {
    // Same host failover as quotes/swaps (see jupFetch).
    const r = await jupFetch(`/tokens/v2/search?query=${encodeURIComponent(mint)}&limit=3`, {}, "jupiter search")
    const arr = (await r.json()) as Array<{
      id: string
      liquidity?: number
      isVerified?: boolean
      usdPrice?: number | null
    }>
    const found = arr.find((t) => t.id === mint)
    const entry: CacheEntry = {
      liquidityUsd: Number(found?.liquidity ?? 0),
      isVerified: !!found?.isVerified,
      usdPrice: typeof found?.usdPrice === "number" ? found.usdPrice : null,
      fetchedAt: Date.now(),
    }
    cache.set(mint, entry)
    return {
      mint,
      liquidityUsd: entry.liquidityUsd,
      isVerified: entry.isVerified,
      usdPrice: entry.usdPrice,
      cached: false,
      staleMs: 0,
    }
  } catch (e) {
    // Fall back to last cached value if any, even if expired.
    if (hit) {
      return {
        mint,
        liquidityUsd: hit.liquidityUsd,
        isVerified: hit.isVerified,
        usdPrice: hit.usdPrice,
        cached: true,
        staleMs: Date.now() - hit.fetchedAt,
      }
    }
    // No data at all — return zeros so callers can detect.
    return {
      mint,
      liquidityUsd: 0,
      isVerified: false,
      usdPrice: null,
      cached: false,
      staleMs: 0,
    }
  }
}
