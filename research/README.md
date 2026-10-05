# Research datasets

Collected unattended by `.github/workflows/snapshot.yml` (hourly), via
`scripts/snapshot-microstructure.ts`. Each file is ndjson: one JSON record per
line, `t` (ISO timestamp) always the first key. Append-only — never rewrite.

| File | Cadence | What it answers |
|---|---|---|
| `snapshots/microstructure.ndjson` | every run (~10/day) | xStock price vs real NYSE price (premium), liquidity, US market regime. Feeds the live timing signal (90-day rolling window). |
| `snapshots/cost-curve.ndjson` | ~every 3h | How much can you buy before slippage bites? Jupiter BUY quotes per xStock at $100 / $1k / $10k / $50k. |
| `snapshots/yields.ndjson` | ~daily | The whole risk-scored USDC + tokenized-treasury pool universe (TVL ≥ $1M), to later backtest whether the risk-adjusted ranking avoided yield collapses. |

## microstructure.ndjson
`{ t, marketState: "open"|"closed-afterhours"|"closed-weekend", entries: [{ ticker, symbol, xStockUsd, underlyingUsd, underlyingSrc, premiumPct, liquidityUsd }] }`
- `xStockUsd` is Jupiter's per-SHARE reference price; `underlyingUsd` is Stooq/Yahoo (~15 min delayed). During closed regimes `underlyingUsd` is the last close.
- Monday pre-market is labelled `closed-afterhours` — find weekend→Monday transitions by ET weekday, not by `closed-weekend → open`.

## cost-curve.ndjson
`{ t, marketState, entries: [{ ticker, q: [{ usd, outRaw, impactPct }], costBps: { "100", "1000", "10000", "50000" } }] }`
- `outRaw` = RAW tokens received (NOT shares — xStocks have a share multiplier; see `src/sol/share-multiplier.ts`). Ratios between sizes are multiplier-free.
- `costBps[size]` = extra cost in bps of buying `size` USDC vs the smallest successful size's price. The authoritative slippage metric.
- `impactPct` = Jupiter's `priceImpactPct` converted to a real percent (Jupiter sends a fraction).
- `null` = that quote failed.

## yields.ndjson
`{ t, n, pools: [{ id, p, c, apy, base, rew, tvl, radj, score, f, x }] }`
- `id` = DefiLlama pool id (stable across days — join on it), `p` protocol, `c` chain, `apy/base/rew` headline / base / reward APY %, `tvl` USD, `radj` risk-adjusted APY, `score` risk score 0-100, `f` risk factors, `x` executable by autoyield today.
