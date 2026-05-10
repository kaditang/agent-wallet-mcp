import {
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from "@solana/web3.js"

const SOL_USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
const SPL_TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const SPL_TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")

// Public mainnet-beta is rate-limited and CORS-touchy from browsers; publicnode
// is open-CORS and reasonably fast.
const RPC = "https://solana-rpc.publicnode.com"
const conn = new Connection(RPC, "confirmed")

const log = (m: unknown) => {
  document.getElementById("log")!.textContent =
    typeof m === "string" ? m : JSON.stringify(m, null, 2)
}
const append = (m: string) => {
  const el = document.getElementById("log")!
  el.textContent = (el.textContent ?? "") + "\n" + m
  el.scrollTop = el.scrollHeight
}
const $ = (id: string) => document.getElementById(id) as HTMLInputElement
const $sel = (id: string) => document.getElementById(id) as HTMLSelectElement

let pubkey: PublicKey | null = null

function getPhantom(): any {
  return (window as any).phantom?.solana ?? (window as any).solana
}

async function connect() {
  const provider = getPhantom()
  if (!provider?.isPhantom) {
    log("Phantom not found — install at phantom.com or unlock the extension.")
    return
  }
  try {
    const resp = await provider.connect()
    pubkey = new PublicKey(resp.publicKey.toString())
    ;(document.getElementById("balances") as HTMLButtonElement).disabled = false
    ;(document.getElementById("quote") as HTMLButtonElement).disabled = false
    ;(document.getElementById("grant") as HTMLButtonElement).disabled = false
    log(`connected: ${pubkey.toBase58()}\nnetwork: solana mainnet (${RPC})`)
  } catch (e) {
    log(`connect failed: ${(e as Error).message}`)
  }
}

async function grant() {
  if (!pubkey) return log("connect first")
  const provider = getPhantom()
  const api = $("api").value.replace(/\/$/, "")
  const token = $("token").value
  if (!token) return log("set bearer token first")

  log("requesting grant plan from backend...")
  const r1 = await fetch(`${api}/sol/grant-plan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ owner: pubkey.toBase58(), dailyUsdcCap: 5 }),
  })
  if (!r1.ok) return log(`grant-plan ${r1.status}: ${await r1.text()}`)
  const plan = await r1.json()

  append(
    `multisigPda: ${plan.multisigPda}\nvaultPda: ${plan.vaultPda}\nagent: ${plan.agent}\ndailyUsdcCap: ${plan.dailyUsdcCap} USDC\nasking Phantom to sign + send...`,
  )

  // Decode + sign + send
  const txBytes = Uint8Array.from(atob(plan.transactionBase64), (c) =>
    c.charCodeAt(0),
  )
  const tx = Transaction.from(txBytes)
  let sig: string
  try {
    const result = await provider.signAndSendTransaction(tx)
    sig = result.signature
  } catch (e) {
    return append(`Phantom rejected: ${(e as Error).message}`)
  }
  append(`tx sent: ${sig}\nwaiting for confirmation...`)
  await conn.confirmTransaction(sig, "confirmed").catch(() => {})
  append(`confirmed.\nposting /sol/grant-confirm...`)

  const r2 = await fetch(`${api}/sol/grant-confirm`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      owner: pubkey.toBase58(),
      multisigPda: plan.multisigPda,
      vaultPda: plan.vaultPda,
      createKey: plan.createKey,
      spendingLimitCreateKey: plan.spendingLimitCreateKey,
      txSignature: sig,
    }),
  })
  if (!r2.ok) return append(`grant-confirm ${r2.status}: ${await r2.text()}`)
  append(
    `granted!\nfund the vault by sending USDC to:\n  ${plan.vaultPda}\nagent can then trade up to ${plan.dailyUsdcCap} USDC/day within whitelist.`,
  )
}

async function readBalances() {
  if (!pubkey) return log("connect first")
  const api = $("api").value.replace(/\/$/, "")
  log(`reading balances via backend (${api}/sol/balances)...`)
  const r = await fetch(`${api}/sol/balances?address=${pubkey.toBase58()}`)
  if (!r.ok) {
    log(`backend ${r.status}: ${await r.text()}`)
    return
  }
  const b = await r.json()
  let out = `address: ${b.address}\nSOL: ${b.sol.toFixed(6)}\nUSDC: ${b.usdc}`
  if (b.xstocks.length > 0) {
    out += `\nxStocks held:`
    for (const x of b.xstocks)
      out += `\n  ${x.symbol.padEnd(8)} ${x.amount}  (${x.mint})`
  } else {
    out += `\nxStocks: none`
  }
  if (b.otherToken2022.length > 0) {
    out += `\nOther Token-2022: ${b.otherToken2022.length} accounts`
  }
  log(out)
}

async function getQuote() {
  const api = $("api").value.replace(/\/$/, "")
  const token = $("token").value
  const ticker = $sel("ticker").value
  const amount = $("amount").value
  if (!token) return log("set bearer token first")
  log(`quoting ${amount} USDC -> ${ticker}x via MCP backend...`)
  const r = await fetch(`${api}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "quote_tokenized_stock",
        arguments: { ticker, amountUsdc: amount },
      },
    }),
  })
  const text = await r.text()
  // Streamable HTTP returns event-stream; pull the first data: line
  const m = text.match(/data:\s*(\{[\s\S]*\})/)
  if (!m) return log(`unexpected response:\n${text.slice(0, 800)}`)
  const env = JSON.parse(m[1])
  if (env.error) return log(`MCP error: ${JSON.stringify(env.error, null, 2)}`)
  const result = JSON.parse(env.result.content[0].text)
  log(result)
}

document.getElementById("connect")!.addEventListener("click", connect)
document.getElementById("balances")!.addEventListener("click", readBalances)
document.getElementById("grant")!.addEventListener("click", () =>
  grant().catch((e) => append(`grant error: ${(e as Error).message}`)),
)
document.getElementById("quote")!.addEventListener("click", getQuote)
