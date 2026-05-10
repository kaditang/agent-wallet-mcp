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
  statusEl.textContent = (statusEl.textContent ?? "") + "\n" + msg
}
function shortAddr(a: string, lead = 6, tail = 6) {
  return a.length > lead + tail + 1 ? `${a.slice(0, lead)}…${a.slice(-tail)}` : a
}

function getPhantom(): any {
  const p = (window as any).phantom?.solana ?? (window as any).solana
  return p?.isPhantom ? p : null
}

if (!id) {
  card.innerHTML = `<span style="color:var(--err)">missing ?id= in URL</span>`
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
    card.innerHTML = `<span style="color:var(--err)">backend unreachable</span>`
    return
  }
  if (r.status === 404) {
    card.innerHTML = `<span style="color:var(--err)">Transaction not found or expired.</span>`
    setStatus("err", "Try asking your AI to build a fresh transaction.")
    return
  }
  if (!r.ok) {
    card.innerHTML = `<span style="color:var(--err)">load failed: ${r.status}</span>`
    setStatus("err", await r.text())
    return
  }
  const tx = await r.json()

  if (tx.signature) {
    card.innerHTML = renderCard(tx)
    setStatus(
      "ok",
      `Already signed.\nSignature: ${tx.signature}\nhttps://solscan.io/tx/${tx.signature}`,
    )
    btn.disabled = true
    btn.textContent = "Already signed"
    return
  }

  card.innerHTML = renderCard(tx)
  btn.disabled = false
  // High-value confirmation: tx > $50 requires a 2-step click (button text
  // changes to "Confirm $X" with 3-second delay before second click is
  // accepted). Defends against accidental click-through.
  const HIGH_VALUE_THRESHOLD_USD = 50
  const value = tx.amountUsdc ?? 0
  if (value > HIGH_VALUE_THRESHOLD_USD) {
    btn.textContent = `Confirm spending $${value} (3s)…`
    btn.disabled = true
    let armedAt = 0
    setTimeout(() => {
      btn.disabled = false
      btn.textContent = `I confirm spending $${value} — Sign in Phantom`
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

function renderCard(tx: any): string {
  const rows: string[] = []
  if (tx.symbol && tx.amountUsdc != null) {
    rows.push(row("Action", `Buy ${tx.symbol}`))
    rows.push(row("Spending", `${tx.amountUsdc} USDC`, true))
    if (tx.expectedOut) {
      rows.push(row("You receive (≈)", `${tx.expectedOut.toFixed(6)} ${tx.symbol}`, true))
    }
  } else if (tx.kind) {
    rows.push(row("Action", tx.kind))
  }
  rows.push(row("Wallet", shortAddr(tx.wallet, 6, 6)))
  rows.push(row("Network", "Solana mainnet"))
  return rows.join("")
}

function row(label: string, val: string, big = false) {
  return `<div class="row"><span class="label">${label}</span><span class="val${big ? " big" : ""}">${val}</span></div>`
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
  setStatus("info", "Refreshing transaction (latest blockhash)…")
  try {
    const r = await fetch(`${apiBase}/sign/rebuild/${tx.id}`, { method: "POST" })
    if (r.ok) {
      const fresh = await r.json()
      tx.unsignedTxBase64 = fresh.unsignedTxBase64
      if (fresh.expectedOut) tx.expectedOut = fresh.expectedOut
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

  setStatus(
    "ok",
    `Submitted.\nSignature: ${signature}\nhttps://solscan.io/tx/${signature}\n\nWaiting for confirmation…`,
  )

  // Tell backend
  try {
    await fetch(`${apiBase}/sign/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: tx.id, signature }),
    })
  } catch {
    // best-effort
  }

  try {
    const conf = await conn.confirmTransaction(signature, "confirmed")
    if (conf.value.err) {
      setStatus(
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
