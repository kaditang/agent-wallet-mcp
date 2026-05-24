// @solana/web3.js v1 is ~240KB minified — by far the biggest dependency in
// this bundle. The user only needs it *if* they click Sign (we deserialize
// the tx, sign, then confirm). The 90%+ of visitors who just look at the
// card and leave shouldn't pay the parse cost. Lazy-load via dynamic
// import; memoized so a click → sign → confirm only loads once.
let web3Promise: Promise<typeof import("@solana/web3.js")> | null = null
function getWeb3() {
  if (!web3Promise) web3Promise = import("@solana/web3.js")
  return web3Promise
}
// Type-only imports stay free (erased at compile time).
import type { VersionedTransaction } from "@solana/web3.js"

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

// ─── i18n ──────────────────────────────────────────────────────────────────
// Display-string translation only. No security/control-flow logic lives here.
// Each entry is either a plain string or a function taking interpolation
// params. t(key, params?) resolves against the active language with an
// English fallback.
type Lang = "en" | "zh"
type TParams = Record<string, string | number>
type Entry = string | ((p: TParams) => string)

const STRINGS: Record<Lang, Record<string, Entry>> = {
  en: {
    // page shell
    title: "Approve transaction",
    sub: "Your AI prepared this. Review the details, then sign in Phantom. We never hold your keys or funds.",
    footer: "Non-custodial. The transaction is signed and sent from your wallet.",
    // card labels
    "label.action": "Action",
    "label.spending": "Spending",
    "label.receive": "You receive (≈)",
    "label.wallet": "Wallet",
    "label.network": "Network",
    network: "Solana mainnet",
    // action labels
    "action.buy": (p) => `Buy ${p.symbol}`,
    "action.buyXstock": "Buy xStock",
    "action.buyYield": "Buy yield token",
    "action.sell": (p) => `Sell ${p.symbol} for USDC`,
    "action.sellXstock": "Sell xStock for USDC",
    "action.sellYield": "Sell yield token for USDC",
    "action.fallback": "Transaction",
    // card load/errors
    cardLoading: "Loading transaction…",
    cardMissingId: "missing ?id= in URL",
    cardBackendUnreachable: "backend unreachable",
    cardNotFound: "Transaction not found or expired.",
    cardLoadFailed: (p) => `load failed: ${p.status}`,
    // button states
    "btn.connectSign": "Connect Phantom & Sign",
    "btn.signing": "Signing…",
    "btn.confirmCountdown": (p) => `Confirm $${p.value} (3s)…`,
    "btn.confirmSign": (p) => `I confirm $${p.value} — Sign in Phantom`,
    "btn.alreadySigned": "Already signed",
    "btn.done": "Done",
    "btn.aborted": "Aborted",
    "btn.confirmNewQuote": "Confirm new quote — Sign in Phantom",
    // status messages
    "st.noId": "Cannot load: no transaction id supplied.",
    "st.backendUnreachable": (p) => `Cannot reach backend at ${p.api}\n${p.err}`,
    "st.tryFresh": "Try asking your AI to build a fresh transaction.",
    "st.alreadySigned": (p) =>
      `Already signed.\nSignature: ${p.sig}\nhttps://solscan.io/tx/${p.sig}`,
    "st.phantomMissing":
      "Phantom not detected. Install at https://phantom.com — or open this page in a browser where Phantom is installed and unlocked.",
    "st.connecting": "Connecting to Phantom…",
    "st.walletMismatch": (p) =>
      `Wallet mismatch.\nThis transaction is for ${p.txWallet} but Phantom is connected as ${p.connected}.\nSwitch accounts in Phantom and try again.`,
    "st.connectFailed": (p) => `Connect failed: ${p.err}`,
    "st.refreshing": "Refreshing transaction (latest blockhash)…",
    "st.rebuildMismatch":
      "Rebuild returned a different transaction. Aborting for safety. Ask your AI to build a fresh one.",
    "st.drift": (p) =>
      `Quote drifted ${p.pct}%. Review the updated numbers above and click sign again.`,
    "st.deserializeFailed": (p) => `Could not deserialize transaction: ${p.err}`,
    "st.walletSwitched": (p) =>
      `Wallet switched in Phantom.\nThis transaction is for ${p.txWallet} but Phantom's active account is now ${p.active}.\nSwitch back in Phantom, then click sign again.`,
    "st.approvePrompt": "Phantom will prompt to sign. Approve.",
    "st.cancelled": "You cancelled the signature.",
    "st.insufficient":
      "Insufficient funds. Make sure your wallet has enough USDC for the trade and at least 0.005 SOL for fees.",
    "st.expired":
      "Transaction expired (blockhash too old). Ask your AI to build a fresh one and try again.",
    "st.simulationFailed": (p) =>
      `Simulation failed: ${p.msg}\nLikely cause: insufficient balance or pool out of liquidity.`,
    "st.signFailed": (p) => `Sign failed: ${p.msg}`,
    "st.broadcasting": "Broadcasting via backend RPC…",
    "st.submitted": (p) =>
      `Submitted.\nSignature: ${p.sig}\nhttps://solscan.io/tx/${p.sig}\n\nWaiting for confirmation…`,
    "st.onchainFailed": (p) =>
      `Transaction failed on-chain: ${p.err}\nhttps://solscan.io/tx/${p.sig}`,
    "st.confirmed": "✅ Confirmed.",
    "st.stillConfirming": (p) =>
      `Still confirming — txs usually land within a minute. Check Solscan:\nhttps://solscan.io/tx/${p.sig}`,
    "st.pollFailed": (p) =>
      `Broadcast succeeded — couldn't poll confirmation. Check Solscan:\nhttps://solscan.io/tx/${p.sig}`,
    geofence:
      "Not for U.S. persons. The tokens this transaction references are issued under non-U.S. prospectuses. Do not sign.",
  },
  zh: {
    // page shell
    title: "确认交易",
    sub: "此交易由你的 AI 准备。请核对详情后在 Phantom 中签名。我们绝不持有你的私钥或资金。",
    footer: "非托管。交易在你自己的钱包中完成签名并发送。",
    // card labels
    "label.action": "操作",
    "label.spending": "支出",
    "label.receive": "预计收到",
    "label.wallet": "钱包",
    "label.network": "网络",
    network: "Solana 主网",
    // action labels
    "action.buy": (p) => `买入 ${p.symbol}`,
    "action.buyXstock": "买入 xStock",
    "action.buyYield": "买入收益代币",
    "action.sell": (p) => `卖出 ${p.symbol} 换 USDC`,
    "action.sellXstock": "卖出 xStock 换 USDC",
    "action.sellYield": "卖出收益代币换 USDC",
    "action.fallback": "交易",
    // card load/errors
    cardLoading: "正在加载交易…",
    cardMissingId: "URL 中缺少 ?id= 参数",
    cardBackendUnreachable: "无法连接后端",
    cardNotFound: "交易不存在或已过期。",
    cardLoadFailed: (p) => `加载失败：${p.status}`,
    // button states
    "btn.connectSign": "连接 Phantom 并签名",
    "btn.signing": "正在签名…",
    "btn.confirmCountdown": (p) => `确认 $${p.value}（3 秒）…`,
    "btn.confirmSign": (p) => `我确认 $${p.value} — 在 Phantom 签名`,
    "btn.alreadySigned": "已签名",
    "btn.done": "完成",
    "btn.aborted": "已中止",
    "btn.confirmNewQuote": "确认新报价 — 在 Phantom 签名",
    // status messages
    "st.noId": "无法加载：未提供交易 id。",
    "st.backendUnreachable": (p) => `无法连接后端 ${p.api}\n${p.err}`,
    "st.tryFresh": "请让你的 AI 重新生成一笔交易。",
    "st.alreadySigned": (p) =>
      `已签名。\n签名：${p.sig}\nhttps://solscan.io/tx/${p.sig}`,
    "st.phantomMissing":
      "未检测到 Phantom。请在 https://phantom.com 安装，或在已安装并解锁 Phantom 的浏览器中打开此页面。",
    "st.connecting": "正在连接 Phantom…",
    "st.walletMismatch": (p) =>
      `钱包不匹配。\n此交易对应 ${p.txWallet}，但 Phantom 当前连接的是 ${p.connected}。\n请在 Phantom 中切换账户后重试。`,
    "st.connectFailed": (p) => `连接失败：${p.err}`,
    "st.refreshing": "正在刷新交易（获取最新区块哈希）…",
    "st.rebuildMismatch":
      "重建返回了不同的交易。为安全起见已中止。请让你的 AI 重新生成一笔交易。",
    "st.drift": (p) =>
      `报价已变动 ${p.pct}%。请核对上方更新后的数字，然后再次点击签名。`,
    "st.deserializeFailed": (p) => `无法解析交易：${p.err}`,
    "st.walletSwitched": (p) =>
      `Phantom 已切换账户。\n此交易对应 ${p.txWallet}，但 Phantom 当前账户已变为 ${p.active}。\n请在 Phantom 中切回原账户，然后再次点击签名。`,
    "st.approvePrompt": "Phantom 将弹出签名请求，请点击批准。",
    "st.cancelled": "你已取消签名。",
    "st.insufficient":
      "余额不足。请确保钱包中有足够的 USDC 用于交易，并至少保留 0.005 SOL 作为手续费。",
    "st.expired":
      "交易已过期（区块哈希过旧）。请让你的 AI 重新生成一笔交易后重试。",
    "st.simulationFailed": (p) =>
      `模拟失败：${p.msg}\n可能原因：余额不足或资金池流动性不足。`,
    "st.signFailed": (p) => `签名失败：${p.msg}`,
    "st.broadcasting": "正在通过后端 RPC 广播…",
    "st.submitted": (p) =>
      `已提交。\n签名：${p.sig}\nhttps://solscan.io/tx/${p.sig}\n\n等待确认中…`,
    "st.onchainFailed": (p) =>
      `交易在链上失败：${p.err}\nhttps://solscan.io/tx/${p.sig}`,
    "st.confirmed": "✅ 已确认。",
    "st.stillConfirming": (p) =>
      `仍在确认中 — 交易通常一分钟内上链。可在 Solscan 查看：\nhttps://solscan.io/tx/${p.sig}`,
    "st.pollFailed": (p) =>
      `广播成功 — 但无法轮询确认状态。可在 Solscan 查看：\nhttps://solscan.io/tx/${p.sig}`,
    geofence:
      "不向美国主体提供。本交易涉及的代币依据非美国招股说明书发行。请勿签名。",
  },
}

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem("autoyield.lang")
    if (saved === "en" || saved === "zh") return saved
  } catch {
    // localStorage unavailable (private mode) — fall through to navigator.
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh" : "en"
}

let lang: Lang = detectLang()

function t(key: string, params: TParams = {}): string {
  const entry = STRINGS[lang][key] ?? STRINGS.en[key]
  if (entry == null) return key
  return typeof entry === "function" ? entry(params) : entry
}

const DEFAULT_API =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:3030"
    : "https://autoyield-api.fly.dev"
const RPC = "https://solana-rpc.publicnode.com"

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
    banner.textContent = t("geofence")
    banner.dataset.i18n = "geofence"
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

// Current tx kept so a language toggle can re-render the card. The button's
// text is re-derived from a remembered key+params (set wherever we assign
// btn.textContent below) so it survives a toggle too.
let currentTx: any = null
let btnKey: string | null = null
let btnParams: TParams = {}
function setBtnText(key: string, params: TParams = {}) {
  btnKey = key
  btnParams = params
  btn.textContent = t(key, params)
}

function applyStaticI18n() {
  const set = (id: string, key: string) => {
    const el = document.getElementById(id)
    if (el) el.textContent = t(key)
  }
  set("title", "title")
  set("sub", "sub")
  set("footer", "footer")
  document.title = t("title")
  const banner = document.querySelector('[data-i18n="geofence"]')
  if (banner) banner.textContent = t("geofence")
}

function setLang(next: Lang) {
  lang = next
  try {
    localStorage.setItem("autoyield.lang", next)
  } catch {
    // ignore persistence failure
  }
  document.documentElement.lang = next === "zh" ? "zh-Hans" : "en"
  const enBtn = document.getElementById("lang-en")
  const zhBtn = document.getElementById("lang-zh")
  enBtn?.classList.toggle("active", next === "en")
  zhBtn?.classList.toggle("active", next === "zh")
  applyStaticI18n()
  if (currentTx) renderCardInto(card, currentTx)
  if (btnKey) btn.textContent = t(btnKey, btnParams)
  reapplyStatus()
}

document.getElementById("lang-en")?.addEventListener("click", () => setLang("en"))
document.getElementById("lang-zh")?.addEventListener("click", () => setLang("zh"))
// NOTE: the initial setLang(lang) call is deliberately NOT here. setLang →
// reapplyStatus reads `lastStatus`, a `let` declared further down; calling it
// at this point hit that variable's temporal dead zone (ReferenceError:
// Cannot access 'lastStatus' before initialization), which halted the whole
// module before load() ran — the page froze on the static "Loading…" HTML.
// The initial paint is invoked below, after all the let/const it depends on.

type StatusKind = "info" | "ok" | "err" | "warn"

// Remember the last status so a language toggle can re-render it. We store the
// translation key + params (not the resolved string) so it re-resolves into the
// newly-active language. `mode` records which renderer drew it; `appended`
// holds any subsequent appendStatus calls (also key+params) to replay in order.
type StatusRec = {
  kind: StatusKind
  mode: "plain" | "links"
  key: string
  params: TParams
  appended: { key: string; params: TParams }[]
}
let lastStatus: StatusRec | null = null

function setStatus(kind: StatusKind, msg: string) {
  statusEl.className = `status${kind === "info" ? "" : " " + kind}`
  statusEl.textContent = msg
}
// Translated wrappers: resolve key→string, render, and remember for re-toggle.
function setStatusT(kind: StatusKind, key: string, params: TParams = {}) {
  lastStatus = { kind, mode: "plain", key, params, appended: [] }
  setStatus(kind, t(key, params))
}
function setStatusWithLinksT(kind: StatusKind, key: string, params: TParams = {}) {
  lastStatus = { kind, mode: "links", key, params, appended: [] }
  setStatusWithLinks(kind, t(key, params))
}
function appendStatusT(key: string, params: TParams = {}) {
  if (lastStatus) lastStatus.appended.push({ key, params })
  appendStatus(t(key, params))
}
function reapplyStatus() {
  if (!lastStatus) return
  if (lastStatus.mode === "links") {
    setStatusWithLinks(lastStatus.kind, t(lastStatus.key, lastStatus.params))
  } else {
    setStatus(lastStatus.kind, t(lastStatus.key, lastStatus.params))
  }
  for (const a of lastStatus.appended) appendStatus(t(a.key, a.params))
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

// Initial i18n paint — safe here: every let/const setLang touches
// (lastStatus, card, btn, statusEl, currentTx, btnKey) is now initialized.
setLang(lang)

if (!id) {
  setCardError(t("cardMissingId"))
  setStatusT("err", "st.noId")
} else {
  void load(id)
}

async function load(txId: string) {
  card.textContent = t("cardLoading")
  let r: Response
  try {
    r = await fetch(`${apiBase}/sign/tx/${txId}`)
  } catch (e) {
    setStatusT("err", "st.backendUnreachable", {
      api: apiBase,
      err: (e as Error).message,
    })
    setCardError(t("cardBackendUnreachable"))
    return
  }
  if (r.status === 404) {
    setCardError(t("cardNotFound"))
    setStatusT("err", "st.tryFresh")
    return
  }
  if (!r.ok) {
    setCardError(t("cardLoadFailed", { status: r.status }))
    setStatus("err", await r.text())
    return
  }
  const tx = await r.json()
  currentTx = tx

  if (tx.signature) {
    renderCardInto(card, tx)
    setStatusWithLinksT("ok", "st.alreadySigned", { sig: tx.signature })
    btn.disabled = true
    setBtnText("btn.alreadySigned")
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
    setBtnText("btn.confirmCountdown", { value: valueShown })
    btn.disabled = true
    let armedAt = 0
    setTimeout(() => {
      btn.disabled = false
      setBtnText("btn.confirmSign", { value: valueShown })
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
        return tx.symbol ? t("action.buy", { symbol: tx.symbol }) : t("action.buyXstock")
      case "deposit_yield":
        return tx.symbol ? t("action.buy", { symbol: tx.symbol }) : t("action.buyYield")
      case "sell_xstock":
        return tx.inputSymbol
          ? t("action.sell", { symbol: tx.inputSymbol })
          : t("action.sellXstock")
      case "withdraw_yield":
        return tx.inputSymbol
          ? t("action.sell", { symbol: tx.inputSymbol })
          : t("action.sellYield")
      default:
        return typeof tx.kind === "string" ? tx.kind : t("action.fallback")
    }
  })()
  target.appendChild(rowEl(t("label.action"), actionLabel))

  // "Spending" row — uses inputAmount/inputSymbol (unified, works for all 4
  // kinds). Falls back to amountUsdc for older stashed txs that predate
  // the input-fields fix.
  if (tx.inputAmount != null && typeof tx.inputSymbol === "string") {
    target.appendChild(
      rowEl(t("label.spending"), `${formatAmount(tx.inputAmount)} ${tx.inputSymbol}`, true),
    )
  } else if (typeof tx.amountUsdc === "number") {
    target.appendChild(rowEl(t("label.spending"), `${formatAmount(tx.amountUsdc)} USDC`, true))
  }

  // "You receive (≈)" row — for buy/deposit shows token; for sell/withdraw
  // shows USDC.
  if (tx.expectedOut) {
    const isReceiveUsdc =
      tx.kind === "sell_xstock" || tx.kind === "withdraw_yield"
    const receiveSymbol = isReceiveUsdc ? "USDC" : tx.symbol
    if (typeof receiveSymbol === "string") {
      target.appendChild(
        rowEl(t("label.receive"), `${formatAmount(tx.expectedOut)} ${receiveSymbol}`, true),
      )
    }
  }

  target.appendChild(rowEl(t("label.wallet"), shortAddr(String(tx.wallet ?? ""), 6, 6)))
  target.appendChild(rowEl(t("label.network"), t("network")))
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
    setStatusT("warn", "st.phantomMissing")
    return
  }

  setStatusT("info", "st.connecting")
  btn.disabled = true
  setBtnText("btn.signing")

  try {
    const res = await provider.connect()
    const connectedAddr: string = res.publicKey.toString()
    if (connectedAddr !== tx.wallet) {
      setStatusT("err", "st.walletMismatch", {
        txWallet: shortAddr(tx.wallet),
        connected: shortAddr(connectedAddr),
      })
      btn.disabled = false
      setBtnText("btn.connectSign")
      return
    }
  } catch (e: any) {
    setStatusT("err", "st.connectFailed", { err: e.message ?? e })
    btn.disabled = false
    setBtnText("btn.connectSign")
    return
  }

  // Always refresh the tx right before signing — Jupiter quotes have
  // ~60s blockhash. If user took >30s to click sign, this prevents expiry.
  // SECURITY: verify the rebuilt tx has the same id/wallet/kind as what we
  // rendered. Otherwise a compromised or buggy /sign/rebuild could
  // substitute wallet-draining bytes after the user already approved
  // the rendered details. If the expected output drifted >5%, force the
  // user to re-confirm against the new numbers (re-render the card).
  setStatusT("info", "st.refreshing")
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
        setStatusT("err", "st.rebuildMismatch")
        btn.disabled = true
        setBtnText("btn.aborted")
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
          setStatusT("warn", "st.drift", { pct: (drift * 100).toFixed(1) })
          btn.disabled = false
          setBtnText("btn.confirmNewQuote")
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
    const { VersionedTransaction } = await getWeb3()
    const bytes = Uint8Array.from(atob(tx.unsignedTxBase64), (c) => c.charCodeAt(0))
    versionedTx = VersionedTransaction.deserialize(bytes)
  } catch (e: any) {
    setStatusT("err", "st.deserializeFailed", { err: e.message ?? e })
    btn.disabled = false
    setBtnText("btn.connectSign")
    return
  }

  // Re-check the active Phantom account RIGHT before sign. Phantom does not
  // re-prompt the user when the active account is switched in the extension
  // between connect() and signTransaction(); without this check, signing with
  // the wrong account produces an invalid signature that fails on broadcast,
  // but only AFTER Phantom showed the user a deceptive approval prompt.
  const activePubkey = provider.publicKey?.toString?.() ?? null
  if (activePubkey && activePubkey !== tx.wallet) {
    setStatusT("err", "st.walletSwitched", {
      txWallet: shortAddr(tx.wallet),
      active: shortAddr(activePubkey),
    })
    btn.disabled = false
    setBtnText("btn.connectSign")
    return
  }

  setStatusT("info", "st.approvePrompt")

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

    setStatusT("info", "st.broadcasting")
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
      setStatusT("warn", "st.cancelled")
    } else if (/insufficient/i.test(msg)) {
      setStatusT("err", "st.insufficient")
    } else if (/blockhash|expired/i.test(msg)) {
      setStatusT("err", "st.expired")
    } else if (/simulation/i.test(msg)) {
      setStatusT("err", "st.simulationFailed", { msg })
    } else {
      setStatusT("err", "st.signFailed", { msg })
    }
    btn.disabled = false
    setBtnText("btn.connectSign")
    return
  }

  setStatusWithLinksT("ok", "st.submitted", { sig: signature })

  // (No /sign/confirm ping — backend records the signature server-side
  // when broadcast succeeds; the extra round-trip was redundant + an
  // unauthenticated write surface attackers could abuse to mark txs
  // "already signed" with arbitrary bytes.)

  // Confirm by POLLING getSignatureStatus over HTTP — NOT
  // conn.confirmTransaction(signature, commitment), which uses a WebSocket
  // signatureSubscribe under the hood. Public RPC WS endpoints
  // (solana-rpc.publicnode.com) are flaky and often never deliver the
  // subscription message, so confirmTransaction threw "could not confirm"
  // even for txs that had already finalized. HTTP polling has no WS
  // dependency and is reliable on public endpoints.
  try {
    const { Connection } = await getWeb3()
    const conn = new Connection(RPC, "confirmed")
    const POLL_TIMEOUT_MS = 45_000
    const POLL_INTERVAL_MS = 2_000
    const start = Date.now()
    let confirmed = false
    let onchainErr: unknown = null
    while (Date.now() - start < POLL_TIMEOUT_MS) {
      const st = await conn.getSignatureStatus(signature, {
        searchTransactionHistory: true,
      })
      const v = st?.value
      if (v) {
        if (v.err) {
          onchainErr = v.err
          break
        }
        if (
          v.confirmationStatus === "confirmed" ||
          v.confirmationStatus === "finalized"
        ) {
          confirmed = true
          break
        }
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    }
    if (onchainErr) {
      setStatusWithLinksT("err", "st.onchainFailed", {
        err: JSON.stringify(onchainErr),
        sig: signature,
      })
    } else if (confirmed) {
      appendStatusT("st.confirmed")
      setBtnText("btn.done")
    } else {
      // Timed out polling — almost always means it's still propagating, not
      // that it failed. Point the user at Solscan rather than implying error.
      appendStatusT("st.stillConfirming", { sig: signature })
      setBtnText("btn.done")
    }
  } catch (e: any) {
    appendStatusT("st.pollFailed", { sig: signature })
    setBtnText("btn.done")
  }
}
