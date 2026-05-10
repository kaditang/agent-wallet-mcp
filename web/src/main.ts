import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  parseAbi,
  parseUnits,
  type Hex,
} from "viem"
import { toAccount } from "viem/accounts"
import { baseSepolia } from "viem/chains"
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import {
  createKernelAccount,
} from "@zerodev/sdk"
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants"
import {
  toPermissionValidator,
  serializePermissionAccount,
} from "@zerodev/permissions"
import { toECDSASigner } from "@zerodev/permissions/signers"
import {
  CallPolicyVersion,
  ParamCondition,
  toCallPolicy,
} from "@zerodev/permissions/policies"

// Must match src/config.ts in the server
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const
const SWAP_ROUTER = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as const
const chain = baseSepolia
const entryPoint = getEntryPoint("0.7")
const kernelVersion = KERNEL_V3_1

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
])
const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)",
])

// Must match src/policies.ts on the server (same on-chain bytes -> same enable signature).
const sessionPolicies = [
  toCallPolicy({
    policyVersion: CallPolicyVersion.V0_0_4,
    permissions: [
      {
        target: USDC,
        abi: erc20Abi,
        functionName: "approve",
        args: [
          { condition: ParamCondition.EQUAL, value: SWAP_ROUTER },
          { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: parseUnits("100", 6) },
        ],
      },
      {
        target: SWAP_ROUTER,
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [null],
      },
      {
        target: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [
          null,
          { condition: ParamCondition.LESS_THAN_OR_EQUAL, value: parseUnits("1", 6) },
        ],
      },
    ],
  }),
]

const log = (m: unknown) => {
  const el = document.getElementById("log")!
  el.textContent = typeof m === "string" ? m : JSON.stringify(m, null, 2)
}

const $ = (id: string) => document.getElementById(id) as HTMLInputElement

let ownerAddress: `0x${string}` | null = null

document.getElementById("connect")!.addEventListener("click", async () => {
  const eth = (window as any).ethereum
  if (!eth) return log("no injected wallet — install MetaMask/Rabby")
  try {
    const [addr] = await eth.request({ method: "eth_requestAccounts" })
    await eth.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${chain.id.toString(16)}` }],
    }).catch(() => {})
    ownerAddress = addr
    ;(document.getElementById("grant") as HTMLButtonElement).disabled = false
    log(`connected: ${addr}\nchain: ${chain.name}`)
  } catch (e) {
    log(`connect failed: ${(e as Error).message}`)
  }
})

document.getElementById("grant")!.addEventListener("click", async () => {
  try {
    await runGrant()
  } catch (e) {
    console.error("[grant] FAILED", e)
    log(`ERROR: ${(e as Error).message}\n\n${(e as Error).stack ?? ""}`)
  }
})

async function runGrant() {
  const api = $("api").value.replace(/\/$/, "")
  const token = $("token").value
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` }

  if (!ownerAddress) return log("connect wallet first")

  log("fetching session pubkey from server...")
  const r = await fetch(`${api}/session-pubkey`, { headers })
  if (!r.ok) return log(`session-pubkey ${r.status}: ${await r.text()}`)
  const { sessionPubkey } = await r.json()
  log(`session pubkey: ${sessionPubkey}\n\nbuilding kernel account...`)

  // ZeroDev's RPC supports standard eth_* and is faster from browser than
  // the public Base Sepolia endpoint.
  const ZERODEV_RPC =
    "https://rpc.zerodev.app/api/v3/2665b3c0-8f97-42e5-8ce6-ba2471023562/chain/84532"
  const publicClient = createPublicClient({ chain, transport: http(ZERODEV_RPC) })
  const eth = (window as any).ethereum
  const walletClient = createWalletClient({
    account: ownerAddress,
    chain,
    transport: custom(eth),
  })

  // ZeroDev's signerToEcdsaValidator expects a LocalAccount-shaped signer
  // (signMessage/signTypedData ON the account). WalletClient has these methods
  // but they take {account, ...} — toAccount() bridges the two shapes.
  const ownerAccount = toAccount({
    address: ownerAddress,
    async signMessage({ message }) {
      return walletClient.signMessage({ account: ownerAddress!, message })
    },
    async signTransaction(tx) {
      return walletClient.signTransaction({ account: ownerAddress!, ...tx } as any)
    },
    async signTypedData(typedData) {
      return walletClient.signTypedData({
        account: ownerAddress!,
        ...(typedData as any),
      })
    },
  })

  const sudo = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion,
  })

  // The browser only knows the session PUBKEY. We never sign with the session
  // key here (that happens on the agent server). toECDSASigner needs a
  // LocalAccount-shape, so give it one with throwing signers.
  const sessionStub = toAccount({
    address: sessionPubkey as Hex,
    async signMessage() {
      throw new Error("session key signs on the agent server, not in browser")
    },
    async signTypedData() {
      throw new Error("session key signs on the agent server, not in browser")
    },
    async signTransaction() {
      throw new Error("session key signs on the agent server, not in browser")
    },
  })
  const sessionSigner = await toECDSASigner({ signer: sessionStub })
  const regular = await toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion,
    signer: sessionSigner,
    policies: sessionPolicies,
  })

  console.log("[grant] sudo validator:", sudo)
  console.log("[grant] regular (session) validator:", regular)
  log("creating kernel account (rpc calls)...")
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion,
    plugins: { sudo, regular },
  })
  console.log("[grant] kernel account built:", account.address)
  log(`kernel address: ${account.address}\nrequesting wallet signature...`)

  // Triggers the EIP-712 signature in the user's wallet under the hood, then
  // returns a base64 blob the agent can deserialize without ever seeing the
  // owner key.
  const approval = await serializePermissionAccount(account)
  console.log("[grant] approval blob length:", approval.length)

  log(`account: ${account.address}\napproval (truncated): ${approval.slice(0, 80)}...\n\nposting to ${api}/grant ...`)

  const post = await fetch(`${api}/grant`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      accountAddress: account.address,
      approval,
      sessionPubkey,
    }),
  })
  if (!post.ok) return log(`grant ${post.status}: ${await post.text()}`)
  log(`granted! account ${account.address} now lets the agent act within policy.`)
}
