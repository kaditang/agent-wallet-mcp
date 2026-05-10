import { Connection, VersionedTransaction } from "@solana/web3.js"

// Frame-busting: refuse to render inside an iframe. Safari ignores
// CSP frame-ancestors from <meta>, so this catches that case too.
if (window.top !== window.self) {
  try {
    window.top!.location.replace(window.location.href)
  } catch {
    // Cross-origin parent — can't redirect, just blank ourselves.
    document.documentElement.innerHTML = ""
  }
  throw new Error("framed")
}

const DEFAULT_API =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3030"
    : "https://autoyield-api.fly.dev"
const RPC = "https://solana-rpc.publicnode.com"
const conn = new Connection(RPC, "confirmed")

// Hosts allowed to load this sign page. Anything else is treated as phishing.
// Production should bake the canonical host(s) here at build time.
const ALLOWED_HOSTS = new Set([
  "autoyield.org",
  "www.autoyield.org",
  "localhost",
  "127.0.0.1",
])

function checkOriginOrAbort(): boolean {
  const host = location.hostname
  if (ALLOWED_HOSTS.has(host)) return true
  // Block: render a hard warning instead of the sign UI.
  document.body.innerHTML = `
    <div style="max-width:560px;margin:4rem auto;padding:2rem;font-family:system-ui;color:#fff;background:#1a0000;border:2px solid #ef4444;border-radius:12px">
      <h1 style="color:#ef4444;margin:0 0 1rem">⚠ Suspicious origin</h1>
      <p>This sign page is being served from <code style="background:#000;padding:.2rem .4rem">${host}</code>, which is not an authorized autoyield host.</p>
      <p>If you didn't expect this, <b>close the tab and do not sign anything.</b></p>
      <p>Authorized hosts: ${Array.from(ALLOWED_HOSTS).join(", ")}</p>
    </div>`
  return false
}

if (!checkOriginOrAbort()) {
  // Stop the rest of the script.
  throw new Error("blocked by origin check")
}

// Soft geofence: if visitor appears to be in the US, prepend a banner
// before they sign anything. Issuers (Backed/Ondo) restrict at contract
// level too; this is just an early nudge.
fetch("https://ipapi.co/json/", { cache: "force-cache" })
  .then((r) => r.json())
  .then((d) => {
    if (d?.country_code !== "US") return
    const banner = document.createElement("div")
    banner.style.cssText =
      "max-width:480px;margin:0 auto 1rem;padding:1rem 1.25rem;background:rgba(239,68,68,.1);border:1px solid #ef4444;border-radius:10px;color:#fca5a5;font-size:0.95rem"
    banner.innerHTML = `<strong style="color:#ef4444">Not for U.S. persons.</strong> The tokens this transaction references are issued under non-U.S. prospectuses. Do not sign.`
    document.body.insertBefore(banner, document.body.firstChild)
  })
  .catch(() => {})

const params = new URLSearchParams(location.search)
const id = params.get("id")
// SECURITY: refuse `?api=` override on production hosts. A phishing site
// could use it to redirect tx fetches to attacker-controlled backend that
// substitutes a wallet-draining unsigned tx (the page renders the attacker's
// claims, user signs, funds gone). On localhost we still honour it for dev.
const isLocalhost =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
const apiOverride = isLocalhost ? params.get("api") : null
const apiBase = (apiOverride ?? DEFAULT_API).replace(/\/$/, "")

const card = document.getElementById("card") as HTMLDivElement
const btn = document.getElementById("sign") as HTMLButtonElement
const statusEl = document.getElementById("status") as HTMLDivElement

type StatusKind = "info" | "ok" | "err" | "warn"
function setStatus(kind: StatusKind, msg: string) {
  statusEl.className = `status${kind === "info" ? "" : " " + kind}`
  statusEl.textContent = msg
}
function appendStatus(msg: string) {
  // Preserve existing children (which may contain <a> links from
  // setStatusWithLinks) by appending text + auto-linkified URLs to the tail.
  const URL_RE = /https?:\/\/\S+/g
  statusEl.appendChild(document.createTextNode("\n"))
  let lastIdx = 0
  for (const match of msg.matchAll(URL_RE)) {
    const start = match.index ?? 0
    if (start > lastIdx) {
      statusEl.appendChild(document.createTextNode(msg.slice(lastIdx, start)))
    }
    const a = document.createElement("a")
    a.href = match[0]
    a.target = "_blank"
    a.rel = "noopener noreferrer"
    a.textContent = match[0]
    a.style.color = "inherit"
    a.style.textDecoration = "underline"
    statusEl.appendChild(a)
    lastIdx = start + match[0].length
  }
  if (lastIdx < msg.length) {
    statusEl.appendChild(document.createTextNode(msg.slice(lastIdx)))
  }
}
/**
 * Linkify any solscan / autoyield URLs in a status message. URL parts get
 * <a target="_blank"> via createElement (no innerHTML — XSS-safe even though
 * the values come from our backend); everything else stays as text node.
 */
function setStatusWithLinks(kind: StatusKind, msg: string) {
  statusEl.className = `status${kind === "info" ? "" : " " + kind}`
  statusEl.replaceChildren()
  const URL_RE = /https?:\/\/\S+/g
  let lastIdx = 0
  for (const match of msg.matchAll(URL_RE)) {
    const start = match.index ?? 0
    if (start > lastIdx) {
      statusEl.appendChild(document.createTextNode(msg.slice(lastIdx, start)))
    }
    const a = document.createElement("a")
    a.href = match[0]
    a.target = "_blank"
    a.rel = "noopener noreferrer"
    a.textContent = match[0]
    a.style.color = "inherit"
    a.style.textDecoration = "underline"
    statusEl.appendChild(a)
    lastIdx = start + match[0].length
  }
  if (lastIdx < msg.length) {
    statusEl.appendChild(document.createTextNode(msg.slice(lastIdx)))
  }
}
function shortAddr(a: string, lead = 6, tail = 6) {
  return a.length > lead + tail + 1 ? `${a.slice(0, lead)}…${a.slice(-tail)}` : a
}

function getPhantom(): any {
  const p = (window as any).phantom?.solana ?? (window as any).solana
  return p?.isPhantom ? p : null
}

function setCardError(msg: string) {
  // Replace card contents with a single styled error message — using
  // textContent (not innerHTML) so the message is treated as data, not
  // markup. The audit flagged every remaining innerHTML in this file
  // because the card sits next to the signTransaction call.
  card.replaceChildren()
  const span = document.createElement("span")
  span.style.color = "var(--err)"
  span.textContent = msg
  card.appendChild(span)
}

if (!id) {
  setCardError("missing ?id= in URL")
  setStatus("err", "Cannot load: no transaction id supplied.")
} else {
  void load(id)
}

async function load(txId: string) {
  card.textContent = "Loading transaction…"
  let r: Response
  try {
    r = await fetch(`${apiBase}/sign/tx/${txId}`)
  } catch (e) {
    setStatus("err", `Cannot reach backend at ${apiBase}\n${(e as Error).message}`)
    setCardError("backend unreachable")
    return
  }
  if (r.status === 404) {
    setCardError("Transaction not found or expired.")
    setStatus("err", "Try asking your AI to build a fresh transaction.")
    return
  }
  if (!r.ok) {
    setCardError(`load failed: ${r.status}`)
    setStatus("err", await r.text())
    return
  }
  const tx = await r.json()

  if (tx.signature) {
    renderCardInto(card, tx)
    setStatusWithLinks(
      "ok",
      `Already signed.\nSignature: ${tx.signature}\nhttps://solscan.io/tx/${tx.signature}`,
    )
    btn.disabled = true
    btn.textContent = "Already signed"
    return
  }

  renderCardInto(card, tx)
  btn.disabled = false
  // High-value confirmation: any tx >$50 USD-equivalent (whichever side is
  // USDC — input for buy/deposit, output for sell/withdraw) requires a
  // 2-step click with 3-second delay. Defends against accidental click-through.
  const HIGH_VALUE_THRESHOLD_USD = 50
  const value = tx.valueUsdEstimate ?? tx.amountUsdc ?? 0
  if (value > HIGH_VALUE_THRESHOLD_USD) {
    const valueShown = Math.round(value * 100) / 100
    btn.textContent = `Confirm $${valueShown} (3s)…`
    btn.disabled = true
    let armedAt = 0
    setTimeout(() => {
      btn.disabled = false
      btn.textContent = `I confirm $${valueShown} — Sign in Phantom`
      armedAt = Date.now()
      btn.onclick = () => {
        if (Date.now() - armedAt < 100) return // double-click guard
        void sign(tx)
      }
    }, 3000)
  } else {
    btn.onclick = () => void sign(tx)
  }
}

function renderCardInto(target: HTMLElement, tx: any): void {
  // Build the card via DOM API (createElement + textContent) — never via
  // innerHTML. tx fields come straight off a fetch() response; treating
  // them as text closes off any XSS in the same DOM that holds the
  // signTransaction call. Audit P1.
  target.replaceChildren()

  const actionLabel = (() => {
    switch (tx.kind) {
      case "buy_xstock":
        return tx.symbol ? `Buy ${tx.symbol}` : "Buy xStock"
      case "deposit_yield":
        return tx.symbol ? `Buy ${tx.symbol}` : "Buy yield token"
      case "sell_xstock":
        return tx.inputSymbol
          ? `Sell ${tx.inputSymbol} for USDC`
          : "Sell xStock for USDC"
      case "withdraw_yield":
        return tx.inputSymbol
          ? `Sell ${tx.inputSymbol} for USDC`
          : "Sell yield token for USDC"
      default:
        return typeof tx.kind === "string" ? tx.kind : "Transaction"
    }
  })()
  target.appendChild(rowEl("Action", actionLabel))

  // "Spending" row — uses inputAmount/inputSymbol (unified, works for all 4
  // kinds). Falls back to amountUsdc for older stashed txs that predate
  // the input-fields fix.
  if (tx.inputAmount != null && typeof tx.inputSymbol === "string") {
    target.appendChild(
      rowEl("Spending", `${formatAmount(tx.inputAmount)} ${tx.inputSymbol}`, true),
    )
  } else if (typeof tx.amountUsdc === "number") {
    target.appendChild(rowEl("Spending", `${formatAmount(tx.amountUsdc)} USDC`, true))
  }

  // "You receive (≈)" row — for buy/deposit shows token; for sell/withdraw
  // shows USDC.
  if (tx.expectedOut) {
    const isReceiveUsdc =
      tx.kind === "sell_xstock" || tx.kind === "withdraw_yield"
    const receiveSymbol = isReceiveUsdc ? "USDC" : tx.symbol
    if (typeof receiveSymbol === "string") {
      target.appendChild(
        rowEl("You receive (≈)", `${formatAmount(tx.expectedOut)} ${receiveSymbol}`, true),
      )
    }
  }

  target.appendChild(rowEl("Wallet", shortAddr(String(tx.wallet ?? ""), 6, 6)))
  target.appendChild(rowEl("Network", "Solana mainnet"))
}

function formatAmount(n: number): string {
  // Defensive: never display NaN/Infinity to the user.
  if (!Number.isFinite(n)) return "?"
  // Trim trailing zeros: 0.881736 → "0.881736", 2 → "2", 0.00921674 → "0.00921674"
  if (Number.isInteger(n)) return String(n)
  // Up to 6 decimals, strip trailing zeros.
  return n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
}

function rowEl(label: string, val: string, big = false): HTMLElement {
  const div = document.createElement("div")
  div.className = "row"
  const labelSpan = document.createElement("span")
  labelSpan.className = "label"
  labelSpan.textContent = label
  const valSpan = document.createElement("span")
  valSpan.className = "val" + (big ? " big" : "")
  valSpan.textContent = val
  div.appendChild(labelSpan)
  div.appendChild(valSpan)
  return div
}

async function sign(tx: any) {
  const provider = getPhantom()
  if (!provider) {
    setStatus(
      "warn",
      "Phantom not detected. Install at https://phantom.com — or open this page in a browser where Phantom is installed and unlocked.",
    )
    return
  }

  setStatus("info", "Connecting to Phantom…")
  btn.disabled = true
  btn.textContent = "Signing…"

  try {
    const res = await provider.connect()
    const connectedAddr: string = res.publicKey.toString()
    if (connectedAddr !== tx.wallet) {
      setStatus(
        "err",
        `Wallet mismatch.\nThis transaction is for ${shortAddr(tx.wallet)} but Phantom is connected as ${shortAddr(connectedAddr)}.\nSwitch accounts in Phantom and try again.`,
      )
      btn.disabled = false
      btn.textContent = "Connect Phantom & Sign"
      return
    }
  } catch (e: any) {
    setStatus("err", `Connect failed: ${e.message ?? e}`)
    btn.disabled = false
    btn.textContent = "Connect Phantom & Sign"
    return
  }

  // Always refresh the tx right before signing — Jupiter quotes have
  // ~60s blockhash. If user took >30s to click sign, this prevents expiry.
  // SECURITY: verify the rebuilt tx has the same id/wallet/kind as what we
  // rendered. Otherwise a compromised or buggy /sign/rebuild could
  // substitute wallet-draining bytes after the user already approved
  // the rendered details. If the expected output drifted >5%, force the
  // user to re-confirm against the new numbers (re-render the card).
  setStatus("info", "Refreshing transaction (latest blockhash)…")
  try {
    const r = await fetch(`${apiBase}/sign/rebuild/${tx.id}`, { method: "POST" })
    if (r.ok) {
      const fresh = await r.json()
      // Identity check — the rebuild must be FOR the same tx we showed.
      if (
        (typeof fresh.id === "string" && fresh.id !== tx.id) ||
        (typeof fresh.wallet === "string" && fresh.wallet !== tx.wallet) ||
        (typeof fresh.kind === "string" && fresh.kind !== tx.kind)
      ) {
        setStatus(
          "err",
          "Rebuild returned a different transaction. Aborting for safety. Ask your AI to build a fresh one.",
        )
        btn.disabled = true
        btn.textContent = "Aborted"
        return
      }
      // Drift check — if the quote moved by >5%, treat it as a new offer
      // the user needs to approve. Re-render the card with fresh numbers
      // and bail out of this sign attempt (user clicks again).
      if (
        typeof tx.expectedOut === "number" &&
        typeof fresh.expectedOut === "number" &&
        tx.expectedOut > 0
      ) {
        const drift = Math.abs(fresh.expectedOut - tx.expectedOut) / tx.expectedOut
        if (drift > 0.05) {
          tx.unsignedTxBase64 = fresh.unsignedTxBase64
          tx.expectedOut = fresh.expectedOut
          renderCardInto(card, tx)
          setStatus(
            "warn",
            `Quote drifted ${(drift * 100).toFixed(1)}%. Review the updated numbers above and click sign again.`,
          )
          btn.disabled = false
          btn.textContent = "Confirm new quote — Sign in Phantom"
          return
        }
      }
      tx.unsignedTxBase64 = fresh.unsignedTxBase64
      if (typeof fresh.expectedOut === "number") tx.expectedOut = fresh.expectedOut
    }
  } catch {
    // best-effort; fall through with stashed bytes
  }

  let versionedTx: VersionedTransaction
  try {
    const bytes = Uint8Array.from(atob(tx.unsignedTxBase64), (c) => c.charCodeAt(0))
    versionedTx = VersionedTransaction.deserialize(bytes)
  } catch (e: any) {
    setStatus("err", `Could not deserialize transaction: ${e.message ?? e}`)
    btn.disabled = false
    btn.textContent = "Connect Phantom & Sign"
    return
  }

  // Re-check the active Phantom account RIGHT before sign. Phantom does not
  // re-prompt the user when the active account is switched in the extension
  // between connect() and signTransaction(); without this check, signing with
  // the wrong account produces an invalid signature that fails on broadcast,
  // but only AFTER Phantom showed the user a deceptive approval prompt.
  const activePubkey = provider.publicKey?.toString?.() ?? null
  if (activePubkey && activePubkey !== tx.wallet) {
    setStatus(
      "err",
      `Wallet switched in Phantom.\nThis transaction is for ${shortAddr(tx.wallet)} but Phantom's active account is now ${shortAddr(activePubkey)}.\nSwitch back in Phantom, then click sign again.`,
    )
    btn.disabled = false
    btn.textContent = "Connect Phantom & Sign"
    return
  }

  setStatus("info", "Phantom will prompt to sign. Approve.")

  let signature: string
  try {
    // Sign only (don't let Phantom broadcast — its RPC is sometimes unreliable
    // for Token-2022 + Jupiter routes). We broadcast via our backend's RPC.
    const signedTx = await provider.signTransaction(versionedTx)
    const signedBytes = signedTx.serialize()
    // base64 encode
    let binary = ""
    const chunkSize = 0x8000
    for (let i = 0; i < signedBytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, signedBytes.slice(i, i + chunkSize) as any)
    }
    const signedTxBase64 = btoa(binary)

    setStatus("info", "Broadcasting via backend RPC…")
    const r = await fetch(`${apiBase}/sign/broadcast`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: tx.id, signedTxBase64 }),
    })
    if (!r.ok) {
      throw new Error(`broadcast failed: ${r.status} ${await r.text()}`)
    }
    const j = await r.json()
    signature = j.signature
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    if (/User reject|reject|denied/i.test(msg)) {
      setStatus("warn", "You cancelled the signature.")
    } else if (/insufficient/i.test(msg)) {
      setStatus(
        "err",
        "Insufficient funds. Make sure your wallet has enough USDC for the trade and at least 0.005 SOL for fees.",
      )
    } else if (/blockhash|expired/i.test(msg)) {
      setStatus(
        "err",
        "Transaction expired (blockhash too old). Ask your AI to build a fresh one and try again.",
      )
    } else if (/simulation/i.test(msg)) {
      setStatus("err", `Simulation failed: ${msg}\nLikely cause: insufficient balance or pool out of liquidity.`)
    } else {
      setStatus("err", `Sign failed: ${msg}`)
    }
    btn.disabled = false
    btn.textContent = "Connect Phantom & Sign"
    return
  }

  setStatusWithLinks(
    "ok",
    `Submitted.\nSignature: ${signature}\nhttps://solscan.io/tx/${signature}\n\nWaiting for confirmation…`,
  )

  // (No /sign/confirm ping — backend records the signature server-side
  // when broadcast succeeds; the extra round-trip was redundant + an
  // unauthenticated write surface attackers could abuse to mark txs
  // "already signed" with arbitrary bytes.)

  try {
    const conf = await conn.confirmTransaction(signature, "confirmed")
    if (conf.value.err) {
      setStatusWithLinks(
        "err",
        `Transaction failed on-chain: ${JSON.stringify(conf.value.err)}\nhttps://solscan.io/tx/${signature}`,
      )
    } else {
      appendStatus(`✅ Confirmed.`)
      btn.textContent = "Done"
    }
  } catch (e: any) {
    appendStatus(
      `Could not confirm yet — check Solscan in a moment:\nhttps://solscan.io/tx/${signature}`,
    )
  }
}
