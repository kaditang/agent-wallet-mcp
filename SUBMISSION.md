# mcp.so + Smithery + Anthropic directory submission checklist

This is the punch list for getting `agent-wallet` listed in MCP registries. Do these in order.

## 0. Pre-flight (today)

- [ ] Run the server locally and **manually sign one real transaction on mainnet** (1-2 USDC into USDY is enough). Without a real tx receipt, every screenshot is just a mockup.
- [ ] Push the repo to GitHub (`github.com/<your>/agent-wallet-mcp`). Update homepage URLs in `README.md`, `package.json`, `mcp-manifest.json`.
- [ ] Pick a final package name. Suggested: `@<scope>/agent-wallet-mcp` or `agent-wallet-rwa`.
- [ ] Decide the brand name (display): currently "Agent Wallet — Non-custodial RWA service for AI". Drop "Agent Wallet" if conflicts with Coinbase / Phantom branding.

## 1. Assets

Put these in `assets/` at repo root.

- [ ] `icon.png` — 512×512, transparent background. Suggest a simple glyph (USDC/wallet/Claude-style mark).
- [ ] `og-image.png` — 1200×630 for social previews.
- [ ] `screenshot-1-list-yields.png` — Claude calling `compare_yields`, showing Solana protocols ranked + cross-chain coverage.
- [ ] `screenshot-2-buy-nvdax.png` — Claude calling `build_buy_xstock_tx`, showing the returned `signUrl`.
- [ ] `screenshot-3-sign-page.png` — `/sign.html` open in browser with Phantom prompting (capture before signing).
- [ ] `screenshot-4-portfolio.png` — Claude calling `get_portfolio` after the buy succeeded, showing held xStock with USD value.
- [ ] `demo.gif` (optional but high-impact) — 30-60 second screen capture of the full flow.

How to capture (macOS):
```bash
# Cmd+Shift+5, pick "Capture Selected Window" for clean screenshots
# or Cmd+Shift+4 for a region
```

For animated demo: use Kap (free, mac).

## 2. npm publish (so `npx @scope/agent-wallet-mcp` works)

- [ ] Add a stdio entry point at `src/server/stdio.ts` (currently there's only `bridge.ts` for HTTP forwarding; for true stdio MCP we need a small wrapper).
- [ ] `npm run build` produces `dist/`. Confirm `dist/server/index.js` runs.
- [ ] Test `npx --package=. agent-wallet-mcp` locally before publishing.
- [ ] `npm login`, `npm publish --access public`.

(For now, users can clone the repo and run `npm install && npm run mcp:http` — that still works without a published package.)

## 3. Submit to mcp.so

- Site: https://mcp.so/submit
- Required: GitHub repo URL, README, screenshots, manifest.
- They scrape `mcp-manifest.json` if present; otherwise manual entry.
- Listing usually takes 1-2 days.

## 4. Submit to Smithery (smithery.ai)

- Site: https://smithery.ai/new
- Format: GitHub URL + manifest.
- They auto-test the server boots; will fail if `npx @scope/agent-wallet-mcp` errors. Ship a stable npm package first.

## 5. Anthropic MCP directory

- https://github.com/modelcontextprotocol/servers — open a PR adding the server to `community-servers.md` (or wherever they keep the registry currently).
- Curated; needs PR review.
- Faster route: tweet/post tagging `@AnthropicAI` once live.

## 6. Discoverability boosters (post-launch)

- [ ] HN Show post (Saturday morning UTC, hits weekend traffic).
- [ ] r/ClaudeAI + r/CryptoCurrency posts (link to GitHub + 1-min demo gif).
- [ ] Tweet thread: 5 tweets max, lead with the demo gif. Tag @JupiterExchange, @OndoFinance, @BackedFi.
- [ ] Reach out to MCP-curating accounts: @MCPRegistry, @smithery_ai.
- [ ] Send a direct intro email to `developers@anthropic.com` if there's a partnership path.

## 7. Talking points (for thread / HN)

- "Non-custodial. Funds never leave the user's wallet."
- "Solana-native. Where the real RWA liquidity is (xStocks $2-3M, USDY $1M+ on Jupiter)."
- "GENIUS / CLARITY safe — we route to securities (USDY) and DEX trades, not stablecoin issuer interest."
- "13 tools, all chain-aware: compare yields, buy/sell, snapshot, track."
- "Works in Claude / Cursor / Claude Code today."

## 8. Don't ship until

- [ ] At least one real on-chain test signed via `/sign.html`.
- [ ] EVM legacy code removed from runtime (already done — backend now only loads Solana paths).
- [ ] README homepage URLs are real, not placeholders.
- [ ] You have a backup Solana RPC configured (Helius free tier API key) to handle public-RPC rate limits when traffic arrives.
