# Claude connector directory — submission answers

Portal: https://claude.ai/directory/manage → **Submit new** → **MCP connector**.
Submit the **read-only research edition**. The full edition (`/mcp`) prepares
transactions and falls under the directory's financial-transactions exclusion
(Software Directory Policy §4.A), so it is not submitted.

---

## 1. Connection
- Server URL: `https://mcp.autoyield.org/research` (live, TLS verified 2026-10-13)
- Users connect to one URL (no per-user URLs).

## 2. Tools
Syncs automatically: 10 tools, all with `title` + `readOnlyHint: true`;
2 prompts (`portfolio_checkup`, `best_yield`). Nothing should be flagged.

## 3. Listing
- **Server name** (≤100): `autoyield Research: Tokenized Stocks & Yield`
- **One-liner** (≤200):
  `Research tokenized US stocks and USDC yield on Solana: risk-adjusted yield rankings, fair-price and order-size cost checks, token safety checks and wallet checkups. Read-only.`
- **Description** (≤2000):

```
autoyield helps you research tokenized US stocks (Backed xStocks such as SPYx, NVDAx, TSLAx) and USDC yield on Solana. It is read-only and works from public data.

Things you can ask Claude:
• "Where can idle USDC earn the most, risk-adjusted?" Ranks lending and tokenized-treasury yields across Solana, Ethereum, Base and Arbitrum by risk-adjusted APY, with a risk score and the reasons behind each discount.
• "Is now a fair time to buy NVDAx?" A live quote plus an entry-timing signal that compares the token's price with the real NYSE stock against its own history, and shows how much extra a larger order costs because of pool depth.
• "Is this token the real one?" Checks a tokenized stock against the issuer's own registry and flags copycats, depegs, thin liquidity and trading halts.
• "Check my wallet." Holdings and value for any Solana address, notes on idle cash or positions trading at a premium, rebalance suggestions toward a target allocation, and a trade-history export (CSV) for record keeping.

This connector never creates, signs or sends transactions, and needs no sign-in: wallet addresses are public on-chain data. Answers are information, not investment advice. Tokenized US stocks are not offered to US persons.

Data comes from public sources (Solana RPC, Jupiter, DefiLlama, Stooq and Yahoo market data) plus autoyield's own hourly price-tracking dataset. Open source (MIT).
```

- **Categories** (1–5): Finance; Data & Analytics (or Research) — pick the closest the portal offers.
- **Documentation URL**: `https://github.com/kaditang/agent-wallet-mcp#readme`
- **Privacy policy URL**: `https://autoyield.org/privacy.html`
- **Support contact**: `https://github.com/kaditang/agent-wallet-mcp/issues` (or a support email you choose)
- **Icon**: `docs/icon.png` (512×512) — also at `https://autoyield.org/icon.png`
- **Slug** (permanent): `autoyield`

## 4. Use cases
- **Primary use cases**
  1. Compare risk-adjusted yields for idle USDC across chains.
  2. Check whether a tokenized US stock's on-chain price is fair versus the real stock, and what a given order size costs.
  3. Verify a tokenized stock is the issuer's genuine token before buying it anywhere.
  4. Review a Solana wallet's tokenized-stock and yield holdings, get rebalance suggestions, and export trade history.
- **What users need first**: nothing. Optional: a Solana wallet address for the wallet tools.
- **Reads / writes**: reads data only.

## 5. Company
- Company name: autoyield
- Website: `https://autoyield.org`
- Primary contact: *(your name + email for review updates)*

## 6. Authentication
- **No authentication.** All inputs are public data.

## 7. Data handling
- Underlying APIs: **third-party public APIs we don't control** (Solana RPC, Jupiter, DefiLlama, Stooq, Yahoo Finance), combined with autoyield's own computations and its own price-tracking dataset.
- Personal health data: **no**. Sponsored content: **no**.

## 8. Test & launch
No account or credentials are needed.

```
1. Add https://mcp.autoyield.org/research as a custom connector (no sign-in).
2. Try:
   - "Compare risk-adjusted USDC yields for $1,000."
   - "Quote $5,000 of SPYx. Is the price fair right now, and what does the size cost?"
   - "Is AAPLx the genuine token and safe to buy right now?"
   - "List the tokenized stocks and treasuries you support."
   - "Check Solana wallet <PUBLIC_WALLET_ADDRESS>, suggest a rebalance to 60% SPY / 40% USDC, and export its trade history."
   - "Look up Solana transaction <SIGNATURE>."
3. For the wallet tools, any public Solana address holding xStocks works.
```

- Confirm you ran every tool (done 2026-10-13: all 10 succeed against production via an MCP client; also add it as a custom connector in Claude and run them once yourself before ticking the box).

## 9. Compliance (all seven — read each before ticking)
- Directory guidelines — tool names ≤64 chars, every tool annotated, descriptions state only what each tool does.
- First-party API usage — autoyield's own service; it calls public market-data APIs, does not wrap or resell another company's private API.
- **Financial transactions — this edition does not transfer money or crypto and does not execute transactions; it creates no transactions at all.**
- AI media generation — none.
- Prompt injection — descriptions are descriptive; no instructions to Claude, no external behavioral instructions.
- Conversation data collection — only tool arguments; no conversation, memory or file access (privacy policy says so).
- Public documentation — README + privacy policy are public.

Escalations: mcp-review@anthropic.com
