// MCP prompts — ready-made workflows a user can pick from the client's prompt
// menu (Claude Desktop / Claude Code show them as slash-style commands), so a
// new user doesn't have to guess what to ask. Each one encodes the SAFE order
// of tool calls: read and explain first, build a transaction only after the
// user explicitly confirms, and remind them they sign in their own wallet.
//
// Argument values are interpolated into a user-role message, so they are
// format-validated first (they come from the user themselves, but garbage in a
// prompt just produces confusing tool calls).

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"

type PromptArg = { name: string; description: string; required: boolean }
type PromptDef = {
  name: string
  title: string
  description: string
  arguments: PromptArg[]
  render: (a: Record<string, string>) => string
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const TICKER = /^[A-Za-z]{1,6}$/
const AMOUNT = /^\d+(\.\d+)?$/

const RULES = `Rules: reply in the language I write in. This is information, not investment advice. Do NOT call any build_* tool unless I explicitly confirm in a later message. autoyield never holds my funds — any transaction is signed by me in my own wallet.`

const PROMPTS: PromptDef[] = [
  {
    name: "portfolio_checkup",
    title: "Portfolio checkup",
    description: "Review a wallet's tokenized stocks, treasuries and idle USDC, and get at most one suggested action.",
    arguments: [{ name: "wallet", description: "Solana wallet address to review", required: true }],
    render: (a) =>
      `Give my Solana wallet ${a.wallet} a checkup.\n\n` +
      `1. Call portfolio_health and get_portfolio for this wallet.\n` +
      `2. Summarize what I hold and its USD value in a short table.\n` +
      `3. Flag anything worth attention: idle USDC that earns nothing, a held yield token beaten by a better risk-adjusted option, an xStock position that looks rich or cheap vs its real stock.\n` +
      `4. End with at most ONE concrete suggestion, or say clearly that nothing needs doing.\n\n` +
      RULES,
  },
  {
    name: "buy_us_stock",
    title: "Buy a US stock safely",
    description: "Safety check, live quote and entry-timing for a tokenized US stock, then build the buy only after you confirm.",
    arguments: [
      { name: "ticker", description: "US ticker, e.g. NVDA, SPY, TSLA", required: true },
      { name: "amountUsdc", description: "USDC to spend, e.g. 50", required: true },
      { name: "wallet", description: "Solana wallet that will sign and receive the shares", required: true },
    ],
    render: (a) =>
      `I want to buy about ${a.amountUsdc} USDC of ${a.ticker.toUpperCase()} as a tokenized stock, from wallet ${a.wallet}.\n\n` +
      `1. Call check_xstock_safety for ${a.ticker.toUpperCase()}. If it says avoid, stop and explain why.\n` +
      `2. Call quote_tokenized_stock for ${a.amountUsdc} USDC. Tell me the shares I'd get, the price impact, and what the entry-timing signal says (good entry / fair / rich).\n` +
      `3. Summarize in 3-4 lines and ask me whether to proceed.\n` +
      `4. Only if I confirm: call build_buy_xstock_tx, give me the sign link, and after I say I signed, check it with track_tx.\n\n` +
      RULES,
  },
  {
    name: "best_yield",
    title: "Best yield for idle USDC",
    description: "Compare risk-adjusted USDC and tokenized-treasury yields, and explain the trade-offs.",
    arguments: [{ name: "amountUsdc", description: "Optional: how much USDC you're considering, e.g. 1000", required: false }],
    render: (a) =>
      `Where should idle USDC earn yield${a.amountUsdc ? ` (I'm considering about ${a.amountUsdc} USDC)` : ""}?\n\n` +
      `1. Call compare_yields${a.amountUsdc ? ` with amountUsdc ${a.amountUsdc}` : ""}.\n` +
      `2. Show the best option I can act on now (topExecutable) and the best across all chains (topByRiskAdjustedOverall), with headline APY vs risk-adjusted APY and the main risk notes.\n` +
      `3. Explain in plain words why a lower headline APY can be the better pick.\n\n` +
      RULES,
  },
]

const VALIDATORS: Record<string, RegExp> = { wallet: BASE58, ticker: TICKER, amountUsdc: AMOUNT }

export function listPrompts() {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({ name, title, description, arguments: args }))
}

export function getPrompt(name: string, args: Record<string, string> = {}) {
  const def = PROMPTS.find((p) => p.name === name)
  if (!def) throw new McpError(ErrorCode.InvalidParams, `unknown prompt: ${name}`)
  const clean: Record<string, string> = {}
  for (const arg of def.arguments) {
    const v = (args[arg.name] ?? "").trim()
    if (!v) {
      if (arg.required) throw new McpError(ErrorCode.InvalidParams, `missing required argument: ${arg.name}`)
      continue
    }
    const re = VALIDATORS[arg.name]
    if (re && !re.test(v)) throw new McpError(ErrorCode.InvalidParams, `invalid ${arg.name}: ${v.slice(0, 60)}`)
    clean[arg.name] = v
  }
  return {
    description: def.description,
    messages: [{ role: "user" as const, content: { type: "text" as const, text: def.render(clean) } }],
  }
}
