import "dotenv/config"
import { http } from "viem"
import { baseSepolia } from "viem/chains"

export const chain = baseSepolia
export const transport = http(process.env.RPC_URL!)
export const bundlerUrl = process.env.BUNDLER_URL!
export const paymasterUrl = process.env.PAYMASTER_URL

export const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const
export const WETH = "0x4200000000000000000000000000000000000006" as const
// Uniswap V3 SwapRouter02 on Base Sepolia
export const SWAP_ROUTER = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4" as const
