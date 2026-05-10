// Phantom-based "Sign In with Solana" -> API key.
//
// Flow: connect Phantom -> POST /auth/challenge -> signMessage in Phantom ->
// POST /auth/verify with {pubkey, nonce, signatureBase64} -> show api key.

const DEFAULT_API =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3030"
    : "https://autoyield-api.fly.dev"

const ALLOWED_HOSTS = new Set([
  "autoyield.org",
  "www.autoyield.org",
  "localhost",
  "127.0.0.1",
])
if (!ALLOWED_HOSTS.has(location.hostname)) {
  document.body.innerHTML = `
    <div style="max-width:560px;margin:4rem auto;padding:2rem;font-family:system-ui;color:#fff;background:#1a0000;border:2px solid #ef4444;border-radius:12px">
      <h1 style="color:#ef4444;margin:0 0 1rem">⚠ Suspicious origin</h1>
      <p>This page is being served from <code>${location.hostname}</code>, not an authorized autoyield host.</p>
      <p>Close the tab — do not sign anything.</p>
    </div>`
  throw new Error("blocked")
}

const apiBase = (new URLSearchParams(location.search).get("api") ?? DEFAULT_API).replace(/\/$/, "")

const btn = document.getElementById("signin") as HTMLButtonElement
const statusEl = document.getElementById("status") as HTMLDivElement
const resultEl = document.getElementById("result") as HTMLDivElement

type StatusKind = "info" | "ok" | "err" | "warn"
function setStatus(kind: StatusKind | "hidden", msg = "") {
  if (kind === "hidden") {
    statusEl.style.display = "none"
    return
  }
  statusEl.style.display = "block"
  statusEl.className = `status${kind === "info" ? "" : " " + kind}`
  statusEl.textContent = msg
}

function getPhantom(): any {
  const p = (window as any).phantom?.solana ?? (window as any).solana
  return p?.isPhantom ? p : null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.slice(i, i + chunkSize)))
  }
  return btoa(binary)
}

btn.addEventListener("click", async () => {
  setStatus("hidden")
  resultEl.style.display = "none"

  const provider = getPhantom()
  if (!provider) {
    setStatus(
      "warn",
      "Phantom not detected.\nInstall it from https://phantom.com (Chrome / Brave / Firefox extension).",
    )
    return
  }

  btn.disabled = true
  btn.textContent = "Connecting…"

  let pubkey: string
  try {
    const r = await provider.connect()
    pubkey = r.publicKey.toString()
  } catch (e: any) {
    setStatus("err", `Connect failed: ${e.message ?? e}`)
    btn.disabled = false
    btn.textContent = "Connect Phantom & get API key"
    return
  }

  setStatus("info", `Connected as ${pubkey.slice(0, 6)}…${pubkey.slice(-6)}\nFetching challenge…`)
  btn.textContent = "Signing…"

  let nonce: string
  let message: string
  try {
    const r = await fetch(`${apiBase}/auth/challenge`, { method: "POST" })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const j = await r.json()
    nonce = j.nonce
    message = j.message
  } catch (e: any) {
    setStatus("err", `Could not reach backend at ${apiBase}\n${e.message ?? e}`)
    btn.disabled = false
    btn.textContent = "Connect Phantom & get API key"
    return
  }

  setStatus("info", "Phantom will prompt to sign the login message. Approve.")

  let sigBase64: string
  try {
    const encoded = new TextEncoder().encode(message)
    const signed = await provider.signMessage(encoded, "utf8")
    // Phantom returns { signature: Uint8Array, publicKey }
    const sigBytes: Uint8Array = signed.signature ?? signed
    sigBase64 = bytesToBase64(sigBytes)
  } catch (e: any) {
    if (/reject|denied|cancel/i.test(e?.message ?? "")) {
      setStatus("warn", "You cancelled the signature.")
    } else {
      setStatus("err", `Sign failed: ${e.message ?? e}`)
    }
    btn.disabled = false
    btn.textContent = "Connect Phantom & get API key"
    return
  }

  setStatus("info", "Verifying signature…")
  let apiKey: string
  try {
    const r = await fetch(`${apiBase}/auth/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, nonce, signatureBase64: sigBase64 }),
    })
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`)
    const j = await r.json()
    apiKey = j.apiKey
  } catch (e: any) {
    setStatus("err", `Verify failed: ${e.message ?? e}`)
    btn.disabled = false
    btn.textContent = "Connect Phantom & get API key"
    return
  }

  setStatus("ok", `Signed in as ${pubkey.slice(0, 6)}…${pubkey.slice(-6)}`)
  btn.textContent = "✓ API key issued"
  resultEl.style.display = "block"
  resultEl.innerHTML = `
    <div class="card" style="border-color:var(--accent)">
      <div style="font-weight:600;margin-bottom:0.5rem">Your API key (save it now — won't be shown again)</div>
      <div class="key-box" id="key">${apiKey}</div>
      <button class="copy-btn" id="copy">Copy</button>
      <div class="small" style="margin-top:1rem">
        <strong>How to use in Claude Desktop:</strong> add this to your MCP config —
        <pre style="margin:0.5rem 0;background:#000;padding:0.75rem;border-radius:6px;font-size:0.8rem;white-space:pre-wrap;word-break:break-all"><code>{
  "mcpServers": {
    "autoyield": {
      "command": "npx",
      "args": ["mcp-remote", "https://autoyield-api.fly.dev/mcp", "--header", "Authorization: Bearer ${apiKey}"]
    }
  }
}</code></pre>
        Or pass it as <code>Authorization: Bearer ${apiKey.slice(0, 12)}…</code> in any HTTP client.
      </div>
    </div>
  `
  document.getElementById("copy")!.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(apiKey)
      const b = document.getElementById("copy") as HTMLButtonElement
      b.textContent = "✓ Copied"
      setTimeout(() => (b.textContent = "Copy"), 1500)
    } catch {
      // ignore — user can select+copy manually
    }
  })
})
