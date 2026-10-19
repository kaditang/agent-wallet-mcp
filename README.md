# autoyield

> [!WARNING]
> **This service will be retired on 31 October 2026.** After that date autoyield (the hosted connector at mcp.autoyield.org and the sign page on this site) is no longer operated. The npm package is deprecated; the source code stays available on GitHub. This domain will not be renewed and lapses in May 2027 — do not sign transactions or trust pages from it after that date. Thank you to everyone who tried it.

**Research tokenized US stocks and USDC yield from Claude — paste one URL.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP](https://img.shields.io/badge/protocol-MCP-blue.svg)](https://modelcontextprotocol.io)
[![Solana](https://img.shields.io/badge/chain-Solana-9945FF.svg)](https://solana.com)
[![npm](https://img.shields.io/npm/v/@kaditang/agent-wallet-mcp.svg)](https://www.npmjs.com/package/@kaditang/agent-wallet-mcp)

autoyield is an MCP server (this repo, `agent-wallet-mcp`) that gives your AI assistant the analysis a careful human would do before touching tokenized stocks (Backed xStocks on Solana) or parking USDC for yield: risk-adjusted yield rankings, fair-price and order-size checks against the real stock, token-authenticity checks, and wallet checkups. The research edition is read-only and needs no account, no wallet and no install.

## Try it in 30 seconds

| Client | How |
|---|---|
| Claude (web, desktop, mobile) | *Settings → Connectors → Add custom connector* → `https://mcp.autoyield.org/research` |
| Claude Code | `claude mcp add --transport http autoyield https://mcp.autoyield.org/research` |
| VS Code | [Add to VS Code](https://vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522autoyield%2522%252C%2522type%2522%253A%2522http%2522%252C%2522url%2522%253A%2522https%253A%252F%252Fmcp.autoyield.org%252Fresearch%2522%257D) |
| Cursor | `~/.cursor/mcp.json`: `{"mcpServers": {"autoyield": {"url": "https://mcp.autoyield.org/research"}}}` — or the **Add to Cursor** button on [autoyield.org](https://autoyield.org) |
| Any MCP client | Streamable HTTP, no auth: `https://mcp.autoyield.org/research` |

Then ask:

- "Where can $10,000 of idle USDC earn the most, risk-adjusted?"
- "Is now a fair time to buy NVDAx, and what does a $50k order cost compared with $100?"
- "Is AAPLx the genuine token, and is it safe to trade right now?"
- "Check Solana wallet `<address>` and suggest a rebalance to 60% SPY / 40% USDC."

## What the answers look like

Live output on 2026-10-15, `compare_yields` for $10,000:

| Pool | Chain | Headline APY | Risk-adjusted | Risk score | Why |
|---|---|---|---|---|---|
| accountable-usdc | Monad | 9.8% | 6.5% | 66 | protocol carries elevated risk |
| fluid-lending-usdc | Ethereum | 6.9% | 5.4% | 79 | DefiLlama models predict the yield may fall |
| kamino-usdc | Solana | 5.9% | 4.0% | 67 | best pool autoyield can prepare a deposit for |
| ample-usdc | Base | **63.7%** | 5.4% → *speculative* | 8 | thin TVL ($0.2M), unknown protocol, yield predicted to fall — ranked after every pool scoring ≥ 25 |

The highest headline rate on the page is the one you should probably avoid; the ranking says so, and says why.

`quote_tokenized_stock` for NVDAx the same day: the token traded 1.1% below NVDA (z ≈ −1.8 against its own history → "good entry"), and pool depth made a $5k buy cost 0.10% more per share than a $100 buy, a $50k buy 0.38% more.

## Two editions

| | Research — `https://mcp.autoyield.org/research` | Full — `https://autoyield-api.fly.dev/mcp` |
|---|---|---|
| Sign-in | None | OAuth 2.1: sign one free, off-chain message in Phantom that names the app |
| Tools | 10 read-only | The same 10 + 4 `build_*` tools that prepare unsigned transactions |
| Can it move money? | No — it creates no transactions | Not by itself: you review and sign every transaction in your own wallet |

## Safety model

- **Research edition:** never prepares, signs or sends a transaction, and refuses the `build_*` tools even when called by name.
- **Full edition:** non-custodial. The server holds no keys and never signs. Before broadcasting a transaction you signed, it re-simulates it on two RPC endpoints and blocks it if the outcome diverges from what you were shown (different output token or recipient, over-spend).
- Usage counters are anonymous (no wallets, IPs or arguments). Details: [SECURITY.md](./SECURITY.md) · [privacy policy](https://autoyield.org/privacy.html).

## How it's built

- TypeScript; MCP over Streamable HTTP (stateless) and stdio (npm). Every tool has MCP annotations and an output schema.
- Data: Solana RPC, Jupiter, DefiLlama, Stooq/Yahoo market data, plus an hourly dataset of xStock prices against the real stocks collected since May 2026 (in [`research/`](./research); SPYx has tracked SPY within ±0.13%, 1σ, during market hours).
- Built by one developer with heavy use of Claude Code. Guardrails: 175 tests, a dated security-audit log in SECURITY.md, and the transaction path validated with real mainnet transactions (buy, sell, deposit, withdraw).
- Tokenized stocks are not offered to US persons by their issuers. Everything here is information, not investment advice.

## Why this exists

Tokenized US equities (Backed's xStocks, Ondo Global Markets) and on-chain treasury products are the fastest-growing real-world-asset (RWA) category. As of mid-2026 these have real liquidity on Solana — NVDAx, TSLAx, SPYx all carry $300K-$3M each, with ~$5/share trades incurring zero detectable price impact.

Coinbase, Phantom, and Crossmint all offer "agent wallets," but they are generic. None opinionated about RWA discovery, yield aggregation, or the boring-but-correct execution that makes idle USDC actually earn. This server fills that gap, distributed via the AI tool layer.

## Install options

The table above covers hosted use. For the **full edition** (prepares transactions you sign), add `https://autoyield-api.fly.dev/mcp` as a custom connector instead; Claude opens a page on autoyield.org where you sign one off-chain message in Phantom that names the app you're connecting (standard OAuth 2.1 with PKCE and dynamic client registration).

Run it locally instead of using the hosted server (Claude Desktop / Cursor / any stdio MCP client): add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop on macOS) or your editor's MCP config:

```json
{
  "mcpServers": {
    "agent-wallet": {
      "command": "npx",
      "args": ["-y", "@kaditang/agent-wallet-mcp"]
    }
  }
}
```

> The npm package is **published** as [`@kaditang/agent-wallet-mcp`](https://www.npmjs.com/package/@kaditang/agent-wallet-mcp) (and listed in the official MCP Registry) — the config above runs it directly via `npx`, no clone needed.
>
> To run from source instead (for development), clone this repo and run:
> ```bash
> git clone https://github.com/kaditang/agent-wallet-mcp.git
> cd agent-wallet-mcp && npm install
> cp .env.example .env   # then fill in SOL_RPC (api keys are minted via Phantom at /account)
> npm run mcp:http       # serves on :3030
> ```
> Then point your MCP client at `http://localhost:3030/mcp` with an `Authorization: Bearer <your-api-key>` header.

### Solana RPC endpoint (recommended)

Public RPCs (`api.mainnet-beta.solana.com`) rate-limit aggressively and reject `getTokenAccountsByOwner` in some cases. For any meaningful traffic you want a paid endpoint as primary; public ones are kept as fallback automatically.

Free tier from [Helius](https://helius.dev) is enough for V1:

1. Sign up → New project → copy the RPC URL (looks like `https://mainnet.helius-rpc.com/?api-key=...`)
2. Set in `.env`:
   ```
   SOL_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
   ```
3. (Optional) add a second provider as `SOL_RPC_FALLBACK_1` for redundancy.

The pool tries primary first; on transient failures (429, timeouts, 5xx) it falls through to fallbacks, then to the public mainnet-beta + publicnode endpoints.

### Error monitoring (optional)

Set `SENTRY_DSN` to ship server-side errors to Sentry. Disabled by default; no outbound network when unset. Captures 500s and broadcast failures with sanitized context — request bodies, cookies, headers (which can carry api keys) are stripped before send.

```
SENTRY_DSN=https://<key>@oXXXXXX.ingest.sentry.io/XXXXXX
SENTRY_RELEASE=<git-sha>            # optional, for release tracking
```

## Tool surface

| Tool | Purpose | Signs anything? |
|------|---------|-----------------|
| `compare_yields` | Rank USDC lending + tokenized-treasury yields across chains, **risk-adjusted** (volatility / TVL / protocol / stability / reward-dependence), not headline APY. Solana protocols tagged `executable: true`. | No |
| `list_yield_tokens` | List supported tokenized treasuries (USDY by Ondo). | No |
| `list_xstocks` | List supported tokenized US equities (Backed xStocks). | No |
| `check_xstock_safety` | **Pre-trade safety check** for a tokenized US stock (any issuer / mint / EVM address): is it the **real** token (not a copycat) and OK to buy now — verified vs the issuer's own registry, plus depeg / liquidity / market-hours / trading-halt. Catches impersonator tokens (the #1 risk). Free, read-only. Auto-run before `build_buy_xstock_tx`. | No |
| `quote_tokenized_stock` | Live Jupiter quote for USDC → xStock, a **size-cost** check for orders ≥ $200 (how much more per share this size costs than a $100 buy) + a **best-entry-timing** signal (premium vs the underlying stock, compared against a same-market-regime baseline — US market open vs closed). | No |
| `get_portfolio` | Snapshot a wallet: SOL, USDC, xStocks + yield tokens valued via Jupiter. | No |
| `portfolio_health` | "Should I do anything?" — holdings vs best risk-adjusted yield + per-xStock timing + actionable notes. | No |
| `suggest_rebalance` | Given a target allocation, compute the buy/sell trades to reach it. Read-only; user executes. | No |
| `export_history` | Export tokenized-equity / yield trade history (date, action, price, CSV) — a record for your accountant, not tax advice. | No |
| `track_tx` | Lookup confirmation status for a Solana signature. | No |
| `build_deposit_yield_tx` | Build unsigned USDC → USDY tx + one-click sign URL. | **No** — user signs in Phantom. |
| `build_withdraw_yield_tx` | Build unsigned USDY → USDC tx + sign URL. | **No** |
| `build_buy_xstock_tx` | Build unsigned USDC → xStock tx + sign URL. | **No** |
| `build_sell_xstock_tx` | Build unsigned xStock → USDC tx + sign URL. | **No** |

Every tool carries MCP annotations: the 10 read tools are marked read-only (clients can offer "always allow"); the 4 `build_*` tools are marked not read-only but **not destructive** — they only prepare a transaction, nothing moves until you sign.

## Prompts

Ready-made workflows that show up in your client's prompt menu (e.g. Claude Desktop / Claude Code):

| Prompt | Arguments | What it does |
|--------|-----------|--------------|
| `portfolio_checkup` | `wallet` | Reviews holdings, idle USDC and positions, ends with at most one suggestion. |
| `buy_us_stock` | `ticker`, `amountUsdc`, `wallet` | Safety check → live quote + entry timing → builds the buy **only after you confirm**. |
| `best_yield` | `amountUsdc` (optional) | Best actionable vs global risk-adjusted yield, and why a lower headline APY can win. |

## Architecture

```
[Claude / Cursor / Claude Code]
        ↓ MCP (stdio or HTTP)
[agent-wallet-mcp server]
   ├─ READ tools (DefiLlama, Jupiter quote, RPC reads)
   ├─ BUILD tools (Jupiter swap → unsigned VersionedTransaction)
   └─ MONITOR tools (RPC signature lookup)
        ↓ returns tx + signUrl
[user's browser]
        ↓ Phantom signs + sends
[Solana mainnet]
```

Zero custody, zero signing keys held by the server. The service is pure intelligence + transaction construction.

## Quick example

User to Claude:
> "I have a Solana wallet at `7QCg1LegbEE2eYDJZfgeMX7JhjtFVVZx9su3HzncuSh2`. Buy me 5 USDC of NVDA tokenized."

Claude calls `build_buy_xstock_tx` → receives sign URL → shows it to you. You click, Phantom prompts, you approve. ~0.023 NVDAx lands in your wallet.

## Caveats

- **You sign every action.** Nothing executes automatically.
- **Tokenized equities are issued under non-US prospectuses.** Issuers (Backed, Ondo) restrict US persons. We do not onboard or KYC anyone — that's between you and the issuer.
- **Markets move.** Slippage cap is 0.5% by default; widen it carefully on illiquid pairs.

## Security

This service handles a real-money path. We've documented the full security posture, threat model, audit history, and vulnerability-disclosure process in **[SECURITY.md](./SECURITY.md)** — including a verifiable account of what "non-custodial" means here (i.e., what an attacker who controls our backend cannot do).

If you find a security issue, please [open a private Security Advisory](https://github.com/kaditang/agent-wallet-mcp/security/advisories/new) instead of a public issue. See SECURITY.md for the full disclosure process.

## Related

Pair this with [StockWaves](https://stockwaves.net) — pay-per-call quant signals (equities / crypto / cross-asset macro) over the x402 protocol. StockWaves tells an agent *what* to trade; this server lets it *execute* non-custodially.

## License

MIT

## Status

**Live on Solana mainnet.** First USDC → Ondo USDY transaction signed via Phantom + broadcast through this service:
[`55Agf6...JEusD`](https://solscan.io/tx/55Agf6Dx1DbBTKC5zYdWi9McAUotBQkEiM6AqrAhKCCKBcGByoryTUMQiJuKDbTK5P46GtDCqG6scPnHRxmJEusD)

Building in public.
