# Security

`autoyield` handles a real-money path on Solana mainnet. This doc explains
what we defend against, what's out of scope, and how to report issues.

This is a living document — last revised **2026-05-11**.

---

## What autoyield is — and isn't

**Is:**
- A read + tx-construction service. An AI agent calls our tools to compare
  yields, quote tokenized US equities, build unsigned Solana transactions,
  and look up tx confirmation status.
- A sign-page (autoyield.org/sign.html) where the user reviews the unsigned
  tx and signs it in their own Phantom wallet.

**Isn't:**
- A custodian. We never hold user funds.
- A signer. We never have access to private keys or seed phrases.
- A broker-dealer. We don't match orders or take possession of securities.
- An MTL/MSB. We don't transmit money; users transmit money via their own
  signed transactions to public protocols (Jupiter, Backed, Ondo).
- Investment advice. Yield rankings are data, not recommendations. See
  [Disclaimer](https://autoyield.org/disclaimer.html).

The boundary: every action that moves value requires the user's own
signature in their own wallet. Our backend cannot move user funds on its
own — there is no key in our infrastructure that has authority over any
user wallet.

---

## Trust assumptions

For autoyield to deliver its stated guarantees, we assume:

| Assumption | If violated |
|---|---|
| The user's wallet (Phantom, etc.) faithfully shows the tx being signed | User signs something they didn't intend |
| The user's machine is not compromised at the OS level | Attacker reads keys regardless of our design |
| Solana network is honest-majority | Standard chain-level assumption |
| Jupiter (swap router), Backed (xStocks issuer), Ondo (USDY issuer) are honest | Tokens reference real assets / quotes are accurate |
| Helius / public Solana RPC endpoints return correct data | We could broadcast a tx to a tampered network view |
| GitHub Pages and Fly.io are not actively tampering with our deployed artifacts | Hosted code could differ from source |

The assumptions about Jupiter / Backed / Ondo / Phantom are
**dependency-of-dependencies**. autoyield does not re-verify what those
parties claim; we compose their guarantees.

---

## Threat model

### In scope (we actively defend against these)

| Threat | Defense | Where |
|---|---|---|
| AI agent / MCP client is malicious — calls tools to drain user wallet | Every tool returns an *unsigned* tx + sign URL. No tool can spend on the user's behalf. | Whole architecture |
| Stolen sign URL → attacker broadcasts a different signed tx | `/sign/broadcast` verifies the signed tx's fee-payer equals the stashed wallet. Sig presence + structural sanity required. | `src/server/index.ts` `/sign/broadcast` |
| Sign-id leaks → attacker mills `/sign/rebuild` for free Jupiter quotes | Per-id rebuild cap (`REBUILD_CAP_PER_ID = 20`). 429 after exhaustion. | `src/sol/sign-store.ts:reserveRebuild` |
| Sign-id leaks → attacker tries double-broadcast | Per-id mutex (`withBroadcastLock`) — second submission gets `BroadcastLockError`. Signature recorded inside lock. | `src/sol/sign-store.ts:withBroadcastLock` |
| Phishing sign-page on attacker domain | `web/src/sign-main.ts` host allowlist; refuses to render outside `autoyield.org` / `www.autoyield.org`. `?api=` override is localhost-only. | `web/src/sign-main.ts:checkOriginOrAbort` |
| iframe wrapping our sign-page | `<meta CSP frame-ancestors 'none'>` + JS frame-bust (covers Safari's meta-CSP ignorance). | `web/sign.html`, `web/src/sign-main.ts` |
| Backend response XSS poisoning the sign-page | `renderCardInto` uses `createElement` + `textContent`. No `innerHTML` on backend-supplied fields. | `web/src/sign-main.ts:renderCardInto` |
| Phantom account-switch between connect() and sign() | Two pubkey checks: at connect time and immediately before `signTransaction`. | `web/src/sign-main.ts` |
| Stale-tx swap-after-render: `/sign/rebuild` morphs to different tx | Sign-page verifies rebuilt `id/wallet/kind` match; >5% drift in `expectedOut` re-renders the card and requires re-click. | `web/src/sign-main.ts` |
| Wide-slippage tx → high MEV / sandwich exposure | `MAX_SLIPPAGE_BPS_HARD_CAP = 100` (1%). Clamped at tool dispatch AND at `/sign/rebuild`. Liquidity sanity check refuses construction if Jupiter min-out drop exceeds slippage cap. | `src/server/tools.ts:clampSlippage`, `checkPriceImpactSane` |
| Fat-finger huge amount | `MAX_AMOUNT_PER_TX = 100,000` units (per-input-token). Refused before quote. | `src/server/tools.ts:buildSwapAndStash` |
| High-value accidental click-through on sign page | Any tx with USD-value > $50 requires 3-second armed delay + second confirmation click. | `web/src/sign-main.ts` |
| `/auth/token` accepts any `ak_*` shape as access_token | Validates against `lookupApiKey` before echoing. | `src/server/index.ts` `/auth/token` |
| API key brute-force / scraping | sha256-hashed at rest. 60/min read, 20/min build, 10/min broadcast per IP. Per-pubkey key cap (10) with LRU eviction. | `src/server/auth-store.ts`, `src/server/index.ts` rate limiters |
| Replay of a Phantom challenge signature | Nonce single-use, 5-min TTL. Message stored at issue time and returned at consume — bytes the user signed = bytes the server verifies. | `src/server/auth-store.ts:issueNonce/consumeNonce` |
| `/auth/revoke` (mode=all) replay | Same nonce/message binding as `/auth/verify`. | `src/server/index.ts` `/auth/revoke` |
| RPC primary outage | `withRpcFallback` pool: Helius primary, mainnet-beta + publicnode fallbacks; transient-error pattern matching. | `src/sol/connection.ts` |
| Operational secret leakage via 500 responses | `sanitizeError` strips file paths and stack frames in production; Sentry `beforeSend` strips cookies/headers/body/query before transport. | `src/server/auth.ts:sanitizeError`, `src/server/sentry.ts` |
| Audit log loss on crash | Sync `appendFileSync` on flush, called from SIGTERM/SIGINT/beforeExit. | `src/server/audit.ts` |
| OAuth redirect_uri to `javascript:` / `data:` | `redirectIsSafeScheme` refuses non-http(s) up front. | `web/src/account-main.ts` |
| OAuth redirect to `*.localhost` phishing | Exact-match-only for `localhost` and `127.0.0.1`; wildcard reserved for `smithery.*` and `run.tools`. | `web/src/account-main.ts` |

### Out of scope (user / upstream responsibility)

- **User's wallet security.** Phantom seed-phrase exposure, OS-level malware,
  browser extension supply chain, hardware wallet authenticity. We can't
  fix these and we don't claim to.
- **Underlying protocol correctness.** If Jupiter's router returns a bad
  quote, if Backed's xStock contract has a flaw, if Ondo USDY's mint /
  redemption is mispriced — we surface their data, we don't re-verify it.
- **Issuer-side compliance / KYC.** Backed (xStocks) and Ondo (USDY)
  enforce non-US-person restrictions at the contract / mint level. We do
  not onboard users and do not perform KYC; users connect their own wallet.
- **MEV inside Jupiter.** Slippage cap (1%) bounds the loss; we do not
  run private mempool / Jito bundles. A determined searcher with deep
  liquidity routes can still extract within the cap.
- **Tax / reporting.** Trade history is on-chain; tax reporting is the
  user's responsibility.
- **Long-term issuer solvency.** Backed dissolves / Ondo redeems / Solana
  halts: we don't insure any of these. Users hold the underlying
  redemption claim, not autoyield.

### Explicitly NOT defended (known gaps)

- **Frontrunning a build → sign → broadcast cycle**: a network observer
  who sees the unsigned tx between build and broadcast can frontrun via
  Jupiter's own pools. Defense would require private mempool routing,
  which we don't currently do.
- **Long-lived sign-id leak in user's browser history / share buffer**:
  if a sign URL leaks (and the underlying tx hasn't expired), the holder
  can read tx details (wallet, amount, expectedOut). They cannot
  broadcast — that requires the user's signature. Rebuild is capped
  but not blocked.
- **Backend operator compromise**: an attacker with control of the
  autoyield-api.fly.dev backend can return a different unsigned tx than
  the AI requested. The sign-page renders backend-supplied amounts; the
  user would see those amounts in Phantom too. Detection relies on the
  user reading the Phantom prompt carefully. Mitigations: open-source
  build, reproducible deploys (in progress), no private signing key in
  the backend so the attacker still can't sign anything.

---

## Audit history

| Date | Type | Scope | Outcome |
|---|---|---|---|
| 2026-05-10 | Self-audit pass 1 | New domain + sign-flow hardening | 3 critical findings closed (dead EVM secrets, `?api=` phishing override, frame-bust hole) |
| 2026-05-10 | Self-audit pass 2 | OAuth metadata + audit-log surface | 5 medium findings closed (`/sign/confirm` removed, rate limits on `.well-known/*`, typed BroadcastLockError, get_portfolio fix) |
| 2026-05-10 | Self-audit pass 3 | NaN guards + eviction logs | 2 low findings closed |
| 2026-05-11 | Three-agent global audit | Full 3.6k LOC tree | 5 P1 findings closed (`/auth/token` echo, broadcast race, rebuild slippage, sign-page rebuild verify, renderCard XSS) |
| 2026-05-11 | Audit P2 sweep | Test coverage + redirect_uri | 6 new tests for fee-payer / rebuild-cap / auth e2e; redirect_uri scheme guard; `*.localhost` tightened |

**No external paid audit has been performed.** This is a deliberate
trade-off: we operate no custom Solana programs, no smart contracts, no
on-chain state machine — every chain-level action goes through Jupiter
(audited) and protocols' own audited contracts (Backed, Ondo). Our
attack surface is a stateless tx-construction service + a sign-page.

If you represent an institution that needs an external audit before
integrating: contact us (below). We are open to commissioning one if a
real customer needs it.

---

## Real-money track record

| Metric | Value | As of |
|---|---|---|
| Mainnet transactions through `/sign/broadcast` | 9 | 2026-05-11 |
| Distinct test wallets | 3 (self + 2 external testers) | 2026-05-11 |
| Funds lost / stuck | 0 | 2026-05-11 |
| Test coverage | 22 vitest tests, all green | 2026-05-11 |
| RPC primary | Helius mainnet | 2026-05-11 |

All on-chain proof is public:
- [`55Agf6...`](https://solscan.io/tx/55Agf6Dx1DbBTKC5zYdWi9McAUotBQkEiM6AqrAhKCCKBcGByoryTUMQiJuKDbTK5P46GtDCqG6scPnHRxmJEusD) — first mainnet swap
- [`3EJ7Dy...`](https://solscan.io/tx/3EJ7DyeJjsRPx8yZuFSJr2W62bTJF68QU2zKnU4FHHZoh8ff8sySTAgvfpg2VJQRcME9U3CqTwMbuXUsi1xYysLX) — first Claude-MCP-driven mainnet swap
- Repo log: [github.com/kaditang/agent-wallet-mcp](https://github.com/kaditang/agent-wallet-mcp/commits/main)

---

## Reporting a vulnerability

If you find a security issue, **please don't open a public GitHub issue**.

**Preferred:** [Open a private Security Advisory](https://github.com/kaditang/agent-wallet-mcp/security/advisories/new) on the repo. This is what GitHub's "security" tab is for, and it lets us collaborate privately.

**Alternative:** email **`windrunnertb@gmail.com`** with subject prefix
`[autoyield security]`. PGP not required; if you'd prefer, include your
own public key for the reply.

### What to include
- Affected endpoint / file / commit hash
- Reproduction steps (curl / code snippet ideal)
- Impact: what an attacker could do
- Whether you've tested on mainnet (not required, but useful)

### What you'll get back
- Acknowledgment within **72 hours** (we are a small team, but we triage seriously).
- A timeline to fix, ideally within **7 days** for high-severity issues, **30 days** for medium.
- Public credit in the changelog / SECURITY.md once the fix ships, if you want it (some researchers prefer anonymity).

### No bug bounty (yet)
We don't currently run a paid bug bounty program. autoyield is pre-revenue
and bootstrapped; we can't responsibly commit to payouts we might not be
able to honor. As we accumulate real users and revenue, this will change.

### Responsible disclosure
Please give us a reasonable window to fix before public disclosure
(typically 30 days for medium-severity, 7 days for actively-exploitable).
We commit to:
- Not threatening legal action against good-faith researchers
- Not requiring NDAs for normal vuln reports
- Crediting researchers who follow responsible disclosure

---

## What "non-custodial" actually means here

This is a precise technical claim, not marketing. To verify it yourself:

1. **No private key in our infrastructure.** Search the repo for any
   `Keypair.fromSecretKey`, any `*.sign(...)` call where `*` is anything
   we control, any reference to a base58-encoded private key. You won't
   find one for any user-funds-bearing pubkey. There used to be a stale
   `SOL_AGENT_SECRET` from the old V1.5 Squads design — it's been deleted
   from `.env` (commit `dda1fc4`, 2026-05-10).
2. **Every action goes through `signTransaction`.** Every build_*_tx tool
   returns base64-encoded unsigned bytes. The user signs in Phantom; we
   broadcast the bytes they signed. Our backend cannot mutate the
   already-signed tx (it would invalidate the signature).
3. **Fly secrets list (audit yourself):** the only sensitive vars in our
   deploy are `SOL_RPC` (Helius URL with API key), `SENTRY_DSN`,
   `DEMO_TOKENS` (legacy auth fallback, empty in prod), `ALLOWED_ORIGINS`,
   `WEB_BASE_URL`, `PUBLIC_ORIGIN`. None of these confer authority over
   any user wallet.
4. **If our backend disappears tomorrow**: your funds stay in your wallet.
   The xStocks and USDY you bought are SPL tokens on your address — you
   can swap them back via Jupiter directly, no autoyield required. You
   are never depending on us to give your money back.

---

## Build / deploy supply chain

| Component | Provider | Notes |
|---|---|---|
| Source | GitHub (`kaditang/agent-wallet-mcp`, public, MIT) | Main-branch only. No force-pushes; commit signatures via co-author trailer. |
| CI | GitHub Actions | Test gate (`npm ci && npm test`) blocks deploy. Workflow lives at `.github/workflows/fly-deploy.yml`. |
| Backend hosting | Fly.io (`autoyield-api.fly.dev`, sjc region) | Single machine, paid trial — no auto-stop. `/data` volume for sign-store / audit / api-keys. |
| Static frontend | GitHub Pages (`autoyield.org` via Cloudflare DNS → `docs/`) | Built by `web/` Vite multi-page; output copied to `docs/`. |
| Runtime container | Node 20 Alpine | `npm ci --omit=dev` in runtime stage. Runs as root currently — see Dockerfile note (migration to `USER node` requires runtime chown of existing volume). |
| Error monitoring | Sentry (`o4511365611585536`, US ingest) | `beforeSend` strips request body / headers / cookies / query — no api keys leave the box. |
| RPC | Helius (paid free tier) primary; `api.mainnet-beta.solana.com` + `solana-rpc.publicnode.com` fallbacks. | Multi-endpoint fallback on transient errors. |

If you want to verify what's running matches what's in the repo: the CI
workflow builds the Docker image and `flyctl deploy --remote-only` ships
it. The commit SHA is reflected in Sentry's `release` (when set) and in
the GitHub Actions run. We don't yet provide reproducible Docker builds
or attestations; this is a known gap.

---

## Compliance posture (informational, not legal advice)

We do not custody assets, do not match orders, do not transmit money,
and do not provide investment advice. We aren't a broker-dealer, MTL,
or MSB on our facts. We rely on the issuers (Backed, Ondo) for their
respective securities compliance — including non-US-person restrictions
enforced at the contract / mint level.

[Terms](https://autoyield.org/terms.html) cap our liability at the
greater of fees you've paid us (currently $0) or $100. Use is at your
own risk; see the [Disclaimer](https://autoyield.org/disclaimer.html)
for the full risk list.

---

## Document changelog

- **2026-05-11** — Initial version. Reflects state at commit `cefecb2`.

If you've reviewed this doc and have suggestions, open a Security
Advisory (preferred) or PR.
