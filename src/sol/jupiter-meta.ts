// Jupiter token metadata helpers — live liquidity + verification flag.
// Cached for 5 minutes per mint so list_xstocks / quote tools don't hammer
// Jupiter's search endpoint.

const SEARCH_BASE = "https://lite-api.jup.ag/tokens/v2/search"
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
    const r = await fetch(
      `${SEARCH_BASE}?query=${encodeURIComponent(mint)}&limit=3`,
    )
    if (!r.ok) throw new Error(`jupiter search ${r.status}`)
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
