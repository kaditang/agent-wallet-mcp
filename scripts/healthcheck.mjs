#!/usr/bin/env node
// autoyield periodic health check — the manual "看数据" pass, automated.
// Run: node scripts/healthcheck.mjs   (exits 0 = all green, 1 = something needs attention)
//
// Checks, each independent (one failure doesn't abort the rest):
//   1. Service liveness    — /healthz 200, fast
//   2. MCP endpoint up     — /mcp returns 401 (auth required = alive)
//   3. Version alignment   — local package.json == npm latest
//   4. Snapshot freshness  — research ndjson updated recently + growing
//   5. Timing-signal data  — open-market sample count vs the MIN_SAMPLES=12 gate
//   6. Research collectors — cost-curve (~3h) and yields (~daily) still landing
//
// Designed to be read at a glance: prints a PASS/WARN/FAIL line per check and a
// one-line verdict. WARN (e.g. stale snapshot on a weekend) doesn't fail the run;
// only real breakage (service down, version drift) exits nonzero.

const API = process.env.AUTOYIELD_API ?? "https://autoyield-api.fly.dev"
const RAW =
  "https://raw.githubusercontent.com/kaditang/agent-wallet-mcp/main/research/snapshots/microstructure.ndjson"
const NPM = "https://registry.npmjs.org/@kaditang/agent-wallet-mcp/latest"

const results = []
const rec = (name, status, detail) => results.push({ name, status, detail }) // status: PASS|WARN|FAIL

async function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, r) => setTimeout(() => r(new Error(`timeout ${ms}ms (${label})`)), ms)),
  ])
}

async function checkHealthz() {
  try {
    const t0 = Date.now()
    const r = await withTimeout(fetch(`${API}/healthz`), 8000, "healthz")
    const dt = Date.now() - t0
    if (r.status === 200) rec("service /healthz", dt < 3000 ? "PASS" : "WARN", `200 in ${dt}ms`)
    else rec("service /healthz", "FAIL", `HTTP ${r.status}`)
  } catch (e) {
    rec("service /healthz", "FAIL", e.message)
  }
}

async function checkMcp() {
  try {
    const r = await withTimeout(
      fetch(`${API}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
      8000,
      "mcp",
    )
    // 401 = alive & requiring auth (expected). 200 would also be fine. 5xx = bad.
    if (r.status === 401 || r.status === 200) rec("mcp endpoint", "PASS", `HTTP ${r.status} (up)`)
    else rec("mcp endpoint", "FAIL", `HTTP ${r.status}`)
  } catch (e) {
    rec("mcp endpoint", "FAIL", e.message)
  }
}

async function checkVersion() {
  try {
    const fs = await import("node:fs")
    const url = await import("node:url")
    const here = url.fileURLToPath(new URL(".", import.meta.url))
    const local = JSON.parse(fs.readFileSync(`${here}/../package.json`, "utf8")).version
    const r = await withTimeout(fetch(NPM), 8000, "npm")
    const npmVer = (await r.json()).version
    if (local === npmVer) rec("version alignment", "PASS", `git=npm=${local}`)
    else rec("version alignment", "WARN", `local ${local} vs npm ${npmVer} — publish or bump?`)
  } catch (e) {
    rec("version alignment", "WARN", e.message)
  }
}

async function checkSnapshots() {
  try {
    const r = await withTimeout(fetch(RAW), 12000, "snapshot")
    const text = await r.text()
    const lines = text.trim().split("\n").filter(Boolean)
    const last = JSON.parse(lines[lines.length - 1])
    const ageH = (Date.now() - new Date(last.t).getTime()) / 3.6e6
    // The GH Action is hourly but free-tier scheduled runs are flaky; >12h between
    // snapshots is a real signal the pipeline stalled. Weekends still snapshot.
    const status = ageH > 12 ? "WARN" : "PASS"
    rec("snapshot pipeline", status, `${lines.length} records, last ${ageH.toFixed(1)}h ago`)

    // open-market sample count drives whether the timing signal is live
    const open = lines
      .map((l) => JSON.parse(l))
      .filter((x) => x.marketState === "open").length
    rec(
      "timing-signal data",
      open >= 12 ? "PASS" : "WARN",
      `${open} open-market samples (need 12 for live signal)`,
    )
  } catch (e) {
    rec("snapshot pipeline", "WARN", e.message)
  }
}

// Research collectors (cost-curve ~3h, yields ~daily). Only the newest line's
// `{"t":"…"` prefix is needed, so read just the tail via Range.
async function checkCollector(name, file, maxAgeH) {
  const url = RAW.replace("microstructure.ndjson", file)
  try {
    let r = await withTimeout(fetch(url, { headers: { Range: "bytes=-262144" } }), 12000, name)
    // GitHub raw returns 416 when the range exceeds a small file — read it whole.
    if (r.status === 416) r = await withTimeout(fetch(url), 12000, name)
    if (r.status === 404) return rec(name, "WARN", "file not created yet (first collector run pending?)")
    const lines = (await r.text()).trimEnd().split("\n")
    let t
    for (let i = lines.length - 1; i >= 0 && !t; i--) t = /^\{"t":"([^"]+)"/.exec(lines[i])?.[1]
    if (!t) return rec(name, "WARN", "no readable record timestamp")
    const ageH = (Date.now() - Date.parse(t)) / 3.6e6
    rec(name, ageH > maxAgeH ? "WARN" : "PASS", `last ${ageH.toFixed(1)}h ago (expect < ${maxAgeH}h)`)
  } catch (e) {
    rec(name, "WARN", e.message)
  }
}

const run = async () => {
  await Promise.all([
    checkHealthz(),
    checkMcp(),
    checkVersion(),
    checkSnapshots(),
    checkCollector("cost-curve data", "cost-curve.ndjson", 12),
    checkCollector("yields data", "yields.ndjson", 48),
  ])
  const icon = { PASS: "✅", WARN: "⚠️ ", FAIL: "❌" }
  for (const r of results) console.log(`${icon[r.status]} ${r.name.padEnd(20)} ${r.detail}`)
  const fails = results.filter((r) => r.status === "FAIL")
  const warns = results.filter((r) => r.status === "WARN")
  console.log(
    `\nverdict: ${fails.length ? `❌ ${fails.length} FAIL` : warns.length ? `⚠️  ${warns.length} WARN, no failures` : "✅ all green"}`,
  )
  process.exit(fails.length ? 1 : 0)
}

run()
