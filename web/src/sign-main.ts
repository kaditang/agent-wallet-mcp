import { Connection, VersionedTransaction } from "@solana/web3.js"

const DEFAULT_API = "http://localhost:3030"
const RPC = "https://solana-rpc.publicnode.com"
const conn = new Connection(RPC, "confirmed")

const params = new URLSearchParams(location.search)
const id = params.get("id")
const apiOverride = params.get("api")
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
  btn.onclick = () => void sign(tx)
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

  setStatus("info", "Phantom will prompt to sign. Approve to send.")

  let signature: string
  try {
    const result = await provider.signAndSendTransaction(versionedTx)
    signature = result.signature
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
