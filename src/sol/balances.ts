import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import { withRpcFallback } from "./connection.js"
import { SOL_USDC, XSTOCKS } from "./tokens.js"
import { YIELD_TOKENS } from "./yield-tokens.js"

const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")

const xstockMintMap = new Map(
  Object.values(XSTOCKS).map((s) => [s.mint, s] as const),
)
const yieldMintMap = new Map(
  Object.values(YIELD_TOKENS).map((y) => [y.mint, y] as const),
)

export type BalancesReport = {
  address: string
  sol: number
  usdc: number
  xstocks: { ticker: string; symbol: string; mint: string; amount: number }[]
  /** Tokenized treasuries / yield-bearing stables (USDY etc.) — most are SPL, not Token-2022. */
  yieldTokens: { slug: string; symbol: string; mint: string; amount: number }[]
  otherToken2022: { mint: string; amount: number }[]
}

/**
 * Exact raw (atomic) balance of one mint for an owner, summed across their
 * token accounts. Used by "sell max" — selling the displayed UI amount can
 * overshoot the true balance by ~1 atomic unit (float `human * 10**dec`
 * rounding), tripping Jupiter InsufficientFunds (0x1788). The raw atomic
 * amount is exact, so selling it never overshoots.
 */
export async function getRawTokenBalance(
  addressBase58: string,
  mint: string,
): Promise<{ atomic: bigint; decimals: number } | null> {
  const owner = new PublicKey(addressBase58)
  for (const programId of [SPL_TOKEN, TOKEN_2022]) {
    const accs = await withRpcFallback((c) =>
      c.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint), programId }),
    ).catch(() => null)
    if (!accs || accs.value.length === 0) continue
    let atomic = 0n
    let decimals = 0
    for (const a of accs.value) {
      const ta = a.account.data.parsed.info.tokenAmount
      atomic += BigInt(ta.amount as string)
      decimals = ta.decimals
    }
    return { atomic, decimals }
  }
  return null
}

export async function getBalances(addressBase58: string): Promise<BalancesReport> {
  const owner = new PublicKey(addressBase58)

  const [lamports, splAccs, t22Accs] = await Promise.all([
    withRpcFallback((c) => c.getBalance(owner)),
    withRpcFallback((c) =>
      c.getParsedTokenAccountsByOwner(owner, { programId: SPL_TOKEN }),
    ),
    withRpcFallback((c) =>
      c.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022 }),
    ),
  ])

  const splInfos = splAccs.value.map((a) => a.account.data.parsed.info)
  const usdc = splInfos
    .filter((i: any) => i.mint === SOL_USDC)
    .reduce((s, i: any) => s + Number(i.tokenAmount.uiAmountString ?? 0), 0)

  const xstocks: BalancesReport["xstocks"] = []
  const yieldTokens: BalancesReport["yieldTokens"] = []
  const other: BalancesReport["otherToken2022"] = []

  // SPL Token program: USDC plus any yield tokens (USDY etc.) that live here.
  for (const a of splAccs.value) {
    const i: any = a.account.data.parsed.info
    const mint = i.mint as string
    const amount = Number(i.tokenAmount.uiAmountString ?? 0)
    if (amount === 0) continue
    if (mint === SOL_USDC) continue // already aggregated as `usdc`
    const yt = yieldMintMap.get(mint)
    if (yt) {
      yieldTokens.push({ slug: yt.slug, symbol: yt.symbol, mint, amount })
    }
    // Otherwise: silently ignored (could be SOL-based memecoins, NFTs, etc.).
  }

  // Token-2022 program: xStocks live here; future yield tokens might too.
  for (const a of t22Accs.value) {
    const i: any = a.account.data.parsed.info
    const mint = i.mint as string
    const amount = Number(i.tokenAmount.uiAmountString ?? 0)
    if (amount === 0) continue
    const stock = xstockMintMap.get(mint)
    if (stock) {
      xstocks.push({ ticker: stock.ticker, symbol: stock.symbol, mint, amount })
      continue
    }
    const yt = yieldMintMap.get(mint)
    if (yt) {
      yieldTokens.push({ slug: yt.slug, symbol: yt.symbol, mint, amount })
      continue
    }
    other.push({ mint, amount })
  }

  return {
    address: addressBase58,
    sol: lamports / LAMPORTS_PER_SOL,
    usdc,
    xstocks,
    yieldTokens,
    otherToken2022: other,
  }
}
