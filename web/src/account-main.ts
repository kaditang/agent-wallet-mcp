// Phantom-based "Sign In with Solana" -> API key.
//
// Flow: connect Phantom -> POST /auth/challenge {pubkey} -> signMessage in Phantom ->
// POST /auth/verify with {pubkey, nonce, signatureBase64} -> show api key.

// Frame-busting: refuse to render inside an iframe (clickjacking defense).
if (window.top !== window.self) {
  try {
    window.top!.location.replace(window.location.href)
  } catch {
    document.documentElement.innerHTML = ""
  }
  throw new Error("framed")
}

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

// SECURITY: refuse `?api=` override on production hosts. Same phishing
// concern as sign-main: an attacker-supplied backend would issue its own
// nonce, capture the user's signature, then... actually a replay against
// the real backend would fail (different nonce). But it pollutes UX and
// has no legitimate prod use. Keep it on localhost for dev only.
const isLocalhost =
  location.hostname === "localhost" || location.hostname === "127.0.0.1"
const params = new URLSearchParams(location.search)
const apiOverride = isLocalhost ? params.get("api") : null
const apiBase = (apiOverride ?? DEFAULT_API).replace(/\/$/, "")

// OAuth 2.1 consent mode. An MCP client (Claude.ai, ChatGPT, …) sends the
// user to the API's /oauth/authorize, which validates the client, its
// pre-registered redirect_uri and the PKCE challenge, then redirects here with
// an opaque `?authz=<id>`. This page never sees or trusts a redirect_uri: it
// asks the API who is asking, shows it, has the user sign a message that NAMES
// that app, and the API answers with where to send the browser (carrying a
// one-time code — the api key never appears in a URL or in this page).
//
// The old bridge (`?response_type=code&redirect_uri=…` → redirect with
// code=<api key>) is gone: it put the key in browser history and trusted an
// attacker-supplied redirect_uri behind a host allowlist.
const authzId = (() => {
  const v = params.get("authz")
  return v && /^[A-Za-z0-9_-]{16,64}$/.test(v) ? v : null
})()

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
  // Consent mode owns the button (runConsent sets btn.onclick); this plain
  // "get an API key" handler must not also run.
  if (authzId) return
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
    // Sending the wallet puts it in the signed message and binds the nonce to it.
    const r = await fetch(`${apiBase}/auth/challenge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ purpose: "login", pubkey }),
    })
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

// --- OAuth consent mode -----------------------------------------------------
async function runConsent(id: string) {
  const h1 = document.querySelector("h1")
  const sub = document.querySelector(".sub")
  const info = document.getElementById("info")
  if (info) info.style.display = "none"
  btn.disabled = true
  btn.textContent = "Loading…"

  let d: { client_name: string; redirect_host: string; known_host: boolean }
  try {
    const r = await fetch(`${apiBase}/oauth/request/${id}`)
    if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error_description ?? `HTTP ${r.status}`)
    d = await r.json()
  } catch (e: any) {
    setStatus("err", `This connection request is invalid or expired.\nGo back to your app and click Connect again.\n(${e.message ?? e})`)
    btn.textContent = "Expired"
    return
  }

  if (h1) h1.textContent = `Connect ${d.client_name} to autoyield`
  document.title = `Connect ${d.client_name} · autoyield`
  // The page footer is about manually minted API keys — irrelevant (and
  // confusing) while authorizing an app.
  document.querySelectorAll("p.small").forEach((el) => {
    if (/Lost your key/.test(el.textContent ?? "")) (el as HTMLElement).style.display = "none"
  })
  if (sub) {
    sub.textContent =
      `${d.client_name} (${d.redirect_host}) is asking to use autoyield as a connector. ` +
      "It will be able to read public data for your wallet and prepare transactions. " +
      "Nothing ever moves unless you sign each transaction yourself in Phantom."
  }
  if (!d.known_host) {
    setStatus(
      "warn",
      `Unrecognized app: access would be sent to ${d.redirect_host}.\nOnly continue if you started this connection yourself from that app.`,
    )
  }
  btn.disabled = false
  btn.textContent = `Connect Phantom & authorize ${d.client_name}`

  btn.onclick = async () => {
    const provider = getPhantom()
    if (!provider) {
      setStatus("warn", "Phantom not detected.\nInstall it from https://phantom.com (Chrome / Brave / Firefox extension).")
      return
    }
    btn.disabled = true
    btn.textContent = "Connecting…"
    try {
      const pubkey = (await provider.connect()).publicKey.toString()
      const ch = await fetch(`${apiBase}/oauth/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authz: id, pubkey }),
      })
      if (!ch.ok) throw new Error((await ch.json().catch(() => ({})))?.error_description ?? `HTTP ${ch.status}`)
      const { nonce, message } = await ch.json()
      setStatus("info", "Phantom will show what you're authorizing. Approve to continue.")
      btn.textContent = "Signing…"
      const signed = await provider.signMessage(new TextEncoder().encode(message), "utf8")
      const sigBytes: Uint8Array = signed.signature ?? signed
      const ap = await fetch(`${apiBase}/oauth/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authz: id, pubkey, nonce, signatureBase64: bytesToBase64(sigBytes) }),
      })
      if (!ap.ok) throw new Error((await ap.json().catch(() => ({})))?.error_description ?? `HTTP ${ap.status}`)
      const { redirect } = await ap.json()
      setStatus("ok", `Authorized. Returning to ${d.client_name}…`)
      btn.textContent = "✓ Authorized"
      window.location.replace(redirect)
    } catch (e: any) {
      if (/reject|denied|cancel/i.test(e?.message ?? "")) setStatus("warn", "You cancelled — nothing was authorized.")
      else setStatus("err", `Authorization failed: ${e.message ?? e}`)
      btn.disabled = false
      btn.textContent = `Connect Phantom & authorize ${d.client_name}`
    }
  }
}

if (authzId) void runConsent(authzId)

