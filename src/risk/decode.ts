import { decodeFunctionData, parseAbi, type Hex } from "viem"

// Known function selectors that often appear in drainers / phishing flows.
// We decode and surface them so the LLM (or human) sees what's actually
// being signed, with severity hints.
const DANGEROUS_SELECTORS: Record<
  string,
  { name: string; severity: "warn" | "block"; reason: string }
> = {
  // setApprovalForAll(operator, true) — gives operator full control of an NFT collection
  "0xa22cb465": {
    name: "setApprovalForAll",
    severity: "warn",
    reason: "grants operator full control of an NFT collection — confirm operator is trusted",
  },
  // permit(...) — EIP-2612 signature-based allowance, common in phishing
  "0xd505accf": {
    name: "permit",
    severity: "warn",
    reason: "off-chain permit grants ERC20 allowance via signature — confirm spender",
  },
  // permitForAll — Seaport/Blur patterns
  "0xb88d4fde": {
    name: "safeTransferFrom",
    severity: "warn",
    reason: "moves NFT — confirm recipient",
  },
}

const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
  "function transferFrom(address from, address to, uint256 amount)",
])

const MAX_UINT_256 =
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn

export type DecodedCall = {
  to: Hex
  selector: string
  function?: string
  args?: unknown
  flags: { severity: "info" | "warn" | "block"; message: string }[]
}

export function decodeCall(call: { to: Hex; data: Hex; value?: bigint }): DecodedCall {
  const selector = call.data.slice(0, 10).toLowerCase()
  const out: DecodedCall = { to: call.to, selector, flags: [] }

  // Try ERC-20 decode first (most common)
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data })
    out.function = decoded.functionName
    out.args = decoded.args
    if (decoded.functionName === "approve") {
      const [, amount] = decoded.args as [Hex, bigint]
      // Infinite or near-infinite approval is a red flag for unknown spenders.
      if (amount >= MAX_UINT_256 / 2n) {
        out.flags.push({
          severity: "warn",
          message: "infinite (max-uint) ERC20 approval — limit to exact amount when possible",
        })
      }
    }
  } catch {
    // not ERC-20, fall through
  }

  if (DANGEROUS_SELECTORS[selector]) {
    const d = DANGEROUS_SELECTORS[selector]
    out.function = out.function ?? d.name
    out.flags.push({ severity: d.severity, message: d.reason })
  }

  // Plain ETH transfer to an unverified contract is mild
  if (call.data === "0x" || call.data.length === 2) {
    out.function = "(plain ETH transfer)"
  }

  return out
}
