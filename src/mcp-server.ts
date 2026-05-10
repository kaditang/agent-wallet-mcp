import "dotenv/config"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseAbi,
  parseUnits,
  type Hex,
} from "viem"
import { z } from "zod"
import { buildKernelAsAgent, publicClient } from "./kernel.js"
import { SWAP_ROUTER, USDC, WETH } from "./config.js"

const sessionPk = process.env.AGENT_SESSION_PK as Hex
const accountAddress = process.env.KERNEL_ACCOUNT_ADDRESS as Hex
const approval = process.env.SESSION_APPROVAL as Hex

const kernel = await buildKernelAsAgent({ sessionPk, accountAddress, approval })

const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)",
])

const server = new Server(
  { name: "agent-wallet", version: "0.1.0" },
  { capabilities: { tools: {} } },
)

const tools = [
  {
    name: "get_account",
    description: "Return the agent's smart-account address.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_balance",
    description: "Read the smart account's USDC balance.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "propose_swap_usdc_to_weth",
    description:
      "Build (but DO NOT send) a USDC→WETH swap. Returns calldata + simulation. Use this to preview before execute_swap.",
    inputSchema: {
      type: "object",
      properties: {
        amountUsdc: { type: "string", description: "Amount of USDC, e.g. '5'" },
      },
      required: ["amountUsdc"],
    },
  },
  {
    name: "execute_swap_usdc_to_weth",
    description:
      "Send a USDC→WETH swap. Bounded by the session policy (max 100 USDC per approve, whitelisted router only).",
    inputSchema: {
      type: "object",
      properties: {
        amountUsdc: { type: "string" },
        minAmountOutWeth: { type: "string", description: "Slippage floor in WETH" },
      },
      required: ["amountUsdc", "minAmountOutWeth"],
    },
  },
] as const

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params

  if (name === "get_account") {
    return text(`smart account: ${accountAddress}`)
  }

  if (name === "get_balance") {
    const bal = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [accountAddress],
    })
    return text(`USDC balance: ${formatUnits(bal, 6)}`)
  }

  if (name === "propose_swap_usdc_to_weth") {
    const { amountUsdc } = z.object({ amountUsdc: z.string() }).parse(args)
    const amountIn = parseUnits(amountUsdc, 6)
    const calls = buildSwapCalls({ amountIn, minOut: 0n })
    return text(JSON.stringify({ calls, note: "preview only, not sent" }, null, 2))
  }

  if (name === "execute_swap_usdc_to_weth") {
    const { amountUsdc, minAmountOutWeth } = z
      .object({ amountUsdc: z.string(), minAmountOutWeth: z.string() })
      .parse(args)
    const amountIn = parseUnits(amountUsdc, 6)
    const minOut = parseUnits(minAmountOutWeth, 18)
    const calls = buildSwapCalls({ amountIn, minOut })
    const hash = await kernel.sendUserOperation({ calls })
    const receipt = await kernel.waitForUserOperationReceipt({ hash })
    return text(`userOp ${hash}\nincluded in tx: ${receipt.receipt.transactionHash}`)
  }

  return text(`unknown tool: ${name}`, true)
})

function buildSwapCalls(opts: { amountIn: bigint; minOut: bigint }) {
  const approveData = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [SWAP_ROUTER, opts.amountIn],
  })
  const swapData = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDC,
        tokenOut: WETH,
        fee: 500,
        recipient: accountAddress,
        amountIn: opts.amountIn,
        amountOutMinimum: opts.minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  return [
    { to: USDC, data: approveData, value: 0n },
    { to: SWAP_ROUTER, data: swapData, value: 0n },
  ]
}

function text(s: string, isError = false) {
  return { content: [{ type: "text", text: s }], isError }
}

await server.connect(new StdioServerTransport())
