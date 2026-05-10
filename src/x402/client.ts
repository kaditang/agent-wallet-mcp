import { encodeFunctionData, erc20Abi, parseUnits, type Hex } from "viem"
import type { UserRecord } from "../store/users.js"
import { buildKernelAsAgent } from "../kernel.js"
import { USDC } from "../config.js"
import type { PaymentChallenge } from "./types.js"

const sessionPk = process.env.AGENT_SESSION_PK as Hex

// Calls a URL once. If 402 with a USDC-on-Base-Sepolia challenge, transfers
// the required amount via the user's session-key-bounded smart account, then
// retries with X-Payment-Tx. If the request demands more than `maxPayUsdc`,
// we refuse — the agent never overpays.
export async function payAndFetch(opts: {
  user: UserRecord
  url: string
  method?: string
  body?: unknown
  maxPayUsdc?: string
}): Promise<{
  ok: boolean
  status: number
  body: unknown
  paid?: { txHash: Hex; amountUsdc: string; payTo: Hex }
}> {
  const init: RequestInit = {
    method: opts.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }

  let resp = await fetch(opts.url, init)
  if (resp.status !== 402) {
    return { ok: resp.ok, status: resp.status, body: await safeJson(resp) }
  }

  const challenge = (await resp.json()) as PaymentChallenge
  const req = challenge.paymentRequirements
  if (
    !req ||
    req.scheme !== "exact" ||
    req.asset.toLowerCase() !== USDC.toLowerCase()
  ) {
    return {
      ok: false,
      status: 402,
      body: { error: "unsupported_x402_challenge", challenge },
    }
  }
  const cap = opts.maxPayUsdc ?? "1"
  if (Number(req.amountUsdc) > Number(cap)) {
    return {
      ok: false,
      status: 402,
      body: {
        error: "amount_exceeds_cap",
        requested: req.amountUsdc,
        cap,
      },
    }
  }

  if (!opts.user.accountAddress || !opts.user.approval) {
    return {
      ok: false,
      status: 0,
      body: { error: "user has no EVM smart account configured" },
    }
  }
  const kernel = await buildKernelAsAgent({
    sessionPk,
    accountAddress: opts.user.accountAddress,
    approval: opts.user.approval,
  })
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [req.payTo, parseUnits(req.amountUsdc, 6)],
  })
  const userOpHash = await kernel.sendUserOperation({
    calls: [{ to: USDC, data, value: 0n }],
  })
  const receipt = await kernel.waitForUserOperationReceipt({ hash: userOpHash })
  const txHash = receipt.receipt.transactionHash as Hex

  resp = await fetch(opts.url, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-payment-tx": txHash,
    },
  })

  return {
    ok: resp.ok,
    status: resp.status,
    body: await safeJson(resp),
    paid: { txHash, amountUsdc: req.amountUsdc, payTo: req.payTo },
  }
}

async function safeJson(r: Response) {
  const t = await r.text()
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}
