# agent-wallet-mcp

> A non-custodial RWA service for AI agents on Solana — yield comparison, tokenized US-equity quotes, and ready-to-sign transactions. Funds stay in your wallet; we never sign.

Connect this MCP server to **Claude**, **Cursor**, **Claude Code**, or any MCP-compatible client. Your AI can then:

- Compare USDC lending yields across Solana, Ethereum, Base, Arbitrum (read-only data).
- Quote and build transactions to buy Backed xStocks (NVDAx, AAPLx, TSLAx, SPYx) on Solana.
- Snapshot any wallet's portfolio (SOL, USDC, held xStocks valued live via Jupiter).
- Track transaction confirmations.

You sign every transaction in **your own Phantom (or other Solana wallet)**. We do not custody funds, hold keys, or co-sign. Architecturally we are a *service* — closer to Tradingview than to a wallet.

## Why this exists

Tokenized US equities (Backed's xStocks, Ondo Global Markets) and on-chain treasury products are the fastest-growing real-world-asset (RWA) category. As of mid-2026 these have real liquidity on Solana — NVDAx, TSLAx, SPYx all carry $300K-$3M each, with ~$5/share trades incurring zero detectable price impact.

Coinbase, Phantom, and Crossmint all offer "agent wallets," but they are generic. None opinionated about RWA discovery, yield aggregation, or the boring-but-correct execution that makes idle USDC actually earn. This server fills that gap, distributed via the AI tool layer.

## Install

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (Claude Desktop on macOS) or your editor's MCP config:

```json
{
  "mcpServers": {
    "agent-wallet": {
      "command": "npx",
      "args": ["-y", "@your-scope/agent-wallet-mcp"]
    }
  }
}
```

(The npm package is published at — TBD; for now clone this repo and point `command` at `tsx src/server/index.ts`.)

## Tool surface

| Tool | Purpose | Signs anything? |
|------|---------|-----------------|
| `compare_yields` | Rank USDC lending APY across major chains via DefiLlama. Tags Solana protocols `executable: true`. | No |
| `quote_tokenized_stock` | Live Jupiter quote for USDC → xStock (price, route, slippage). | No |
| `build_buy_xstock_tx` | Build an unsigned Solana versioned transaction. Returns base64 + a one-click sign URL. | **No** — user signs in their wallet. |
| `get_portfolio` | Snapshot a wallet: SOL, USDC, xStocks valued via Jupiter. | No |
| `track_tx` | Lookup confirmation status for a Solana signature. | No |

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

## Coverage

| Asset class | V1 | V1.5 | V2 |
|---|---|---|---|
| Backed xStocks (Solana) | ✅ | | |
| USDC lending data (cross-chain) | ✅ | | |
| Solana lending execution (Kamino / MarginFi / JLP) | | ✅ | |
| Ethereum-side RWA execution (BUIDL / OUSG / USDY) | | | ✅ |
| Cross-chain rebalance | | | ✅ |

## Caveats

- **You sign every action.** Auto-execution requires V1.5's optional Squads-spending-limit grant (separately, opt-in).
- **Tokenized equities are issued under non-US prospectuses.** Issuers (Backed, Ondo) restrict US persons. We do not onboard or KYC anyone — that's between you and the issuer.
- **Markets move.** Slippage cap is 0.5% by default; widen it carefully on illiquid pairs.

## License

MIT

## Status

Pre-alpha. Building in public.
