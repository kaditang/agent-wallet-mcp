import "dotenv/config"

const ACCOUNT = process.env.TENDERLY_ACCOUNT
const PROJECT = process.env.TENDERLY_PROJECT
const KEY = process.env.TENDERLY_KEY

export type Call = { to: `0x${string}`; data: `0x${string}`; value?: bigint }

export type SimResult = {
  success: boolean
  gasUsed: number
  errorMessage?: string
  assetChanges?: unknown
  url?: string
  skipped?: boolean
}

export async function simulateBundle(opts: {
  from: `0x${string}`
  calls: Call[]
  chainId: number
}): Promise<SimResult[]> {
  if (!ACCOUNT || !PROJECT || !KEY) {
    return opts.calls.map(() => ({ success: true, gasUsed: 0, skipped: true }))
  }
  const url = `https://api.tenderly.co/api/v1/account/${ACCOUNT}/project/${PROJECT}/simulate-bundle`
  const body = {
    simulations: opts.calls.map((c) => ({
      network_id: String(opts.chainId),
      from: opts.from,
      to: c.to,
      input: c.data,
      value: (c.value ?? 0n).toString(),
      save: true,
      simulation_type: "quick",
    })),
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "X-Access-Key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`tenderly: ${resp.status} ${await resp.text()}`)
  const json: any = await resp.json()
  return (json.simulation_results ?? []).map((r: any) => ({
    success: !!r.transaction?.status,
    gasUsed: Number(r.transaction?.gas_used ?? 0),
    errorMessage: r.transaction?.error_message,
    assetChanges: r.transaction?.transaction_info?.asset_changes,
    url: `https://dashboard.tenderly.co/${ACCOUNT}/${PROJECT}/simulator/${r.simulation?.id}`,
  }))
}
