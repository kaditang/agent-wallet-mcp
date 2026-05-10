import { parseAbi, parseUnits } from "viem"
import {
  toCallPolicy,
  CallPolicyVersion,
  toSudoPolicy,
  ParamCondition,
} from "@zerodev/permissions/policies"
import { USDC, SWAP_ROUTER } from "./config.js"

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
])

const routerAbi = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)",
])

// The session key may ONLY:
//   1. approve USDC to the Uniswap router, up to 100 USDC per call
//   2. call exactInputSingle on the router
// Anything else (transfers, NFT approvals, contract upgrades, etc.) reverts.
export const sessionPolicies = [
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
      // x402 micropayment lane: USDC transfer to any recipient, capped at
      // 1 USDC per call. Even if a malicious server posts a 402 to drain the
      // wallet, blast radius per call is bounded on-chain.
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

export const sudoPolicy = toSudoPolicy({})
