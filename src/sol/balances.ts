import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js"
import { withRpcFallback } from "./connection.js"
import { SOL_USDC, XSTOCKS } from "./tokens.js"

const SPL_TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")

const xstockMintMap = new Map(
  Object.values(XSTOCKS).map((s) => [s.mint, s] as const),
)

export type BalancesReport = {
  address: string
  sol: number
  usdc: number
  xstocks: { ticker: string; symbol: string; mint: string; amount: number }[]
  otherToken2022: { mint: string; amount: number }[]
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
  const other: BalancesReport["otherToken2022"] = []
  for (const a of t22Accs.value) {
    const i: any = a.account.data.parsed.info
    const amount = Number(i.tokenAmount.uiAmountString ?? 0)
    if (amount === 0) continue
    const stock = xstockMintMap.get(i.mint)
    if (stock) {
      xstocks.push({ ticker: stock.ticker, symbol: stock.symbol, mint: i.mint, amount })
    } else {
      other.push({ mint: i.mint, amount })
    }
  }

  return {
    address: addressBase58,
    sol: lamports / LAMPORTS_PER_SOL,
    usdc,
    xstocks,
    otherToken2022: other,
  }
}
