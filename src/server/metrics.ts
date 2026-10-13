// Anonymous, aggregate usage metrics — so we can tell whether anyone uses the
// connector (the research edition has no login, so nothing else records it)
// and which tools are slow or failing.
//
// What is recorded, per UTC day and per edition (research | full):
//   - tool calls: count, error count, latency histogram
//   - prompt fetches: count per prompt
//   - connections: count of MCP `initialize` handshakes
// What is NOT recorded: wallet addresses, IPs, arguments, results — nothing
// that identifies a user (see the privacy policy).
//
// Persisted to METRICS_PATH (Fly: /data — set in the Dockerfile, or a deploy
// wipes it), flushed on a debounce and on shutdown; 90 days retained.

import fs from "node:fs"
import path from "node:path"

export type Edition = "research" | "full"

/** Latency bins (ms, upper bounds). p50/p95 are reported as the bin's upper bound. */
const BINS = [250, 500, 1000, 2000, 4000, 8000, Infinity] as const
const RETAIN_DAYS = 90
const PATH = process.env.METRICS_PATH ?? "data/metrics.json"

type ToolStat = { calls: number; errors: number; msSum: number; hist: number[] }
type EditionDay = { connects: number; tools: Record<string, ToolStat>; prompts: Record<string, number> }
type Store = { days: Record<string, Partial<Record<Edition, EditionDay>>> }

let store: Store = { days: {} }
try {
  if (fs.existsSync(PATH)) store = JSON.parse(fs.readFileSync(PATH, "utf8")) ?? { days: {} }
} catch {
  store = { days: {} }
}

const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10)

function day(edition: Edition, now = Date.now()): EditionDay {
  const d = (store.days[today(now)] ??= {})
  return (d[edition] ??= { connects: 0, tools: {}, prompts: {} })
}

let timer: NodeJS.Timeout | null = null
function scheduleFlush() {
  if (timer || process.env.NODE_ENV === "test") return
  timer = setTimeout(() => {
    timer = null
    flushMetricsSync()
  }, 30_000)
  timer.unref?.()
}

export function flushMetricsSync() {
  try {
    const cutoff = today(Date.now() - RETAIN_DAYS * 86_400_000)
    for (const k of Object.keys(store.days)) if (k < cutoff) delete store.days[k]
    const dir = path.dirname(PATH)
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(PATH + ".tmp", JSON.stringify(store))
    fs.renameSync(PATH + ".tmp", PATH)
  } catch (e) {
    console.warn(`[metrics] flush failed: ${(e as Error).message}`)
  }
}

export function recordToolCall(edition: Edition, tool: string, ok: boolean, ms: number) {
  const t = (day(edition).tools[tool] ??= { calls: 0, errors: 0, msSum: 0, hist: BINS.map(() => 0) })
  t.calls++
  if (!ok) t.errors++
  t.msSum += ms
  t.hist[BINS.findIndex((b) => ms <= b)]++
  scheduleFlush()
}

export function recordPrompt(edition: Edition, prompt: string) {
  const p = day(edition).prompts
  p[prompt] = (p[prompt] ?? 0) + 1
  scheduleFlush()
}

export function recordConnect(edition: Edition) {
  day(edition).connects++
  scheduleFlush()
}

/** PURE: approximate percentile from a histogram (upper bound of the bin). */
export function histPercentile(hist: number[], q: number): number | null {
  const total = hist.reduce((a, b) => a + b, 0)
  if (!total) return null
  let acc = 0
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i]
    if (acc >= q * total) return Number.isFinite(BINS[i]) ? BINS[i] : 8000
  }
  return null
}

/** Aggregate over the last `days` days (inclusive of today). */
export function metricsSummary(days = 7, now = Date.now()) {
  const from = today(now - (days - 1) * 86_400_000)
  const out: Record<
    string,
    { connects: number; tools: Record<string, { calls: number; errors: number; avgMs: number; p50Ms: number | null; p95Ms: number | null }>; prompts: Record<string, number> }
  > = {}
  for (const [d, eds] of Object.entries(store.days)) {
    if (d < from) continue
    for (const [ed, v] of Object.entries(eds) as [Edition, EditionDay][]) {
      const o = (out[ed] ??= { connects: 0, tools: {}, prompts: {} })
      o.connects += v.connects
      for (const [p, n] of Object.entries(v.prompts)) o.prompts[p] = (o.prompts[p] ?? 0) + n
      for (const [name, t] of Object.entries(v.tools)) {
        const agg = ((o.tools[name] as any) ??= { calls: 0, errors: 0, msSum: 0, hist: BINS.map(() => 0) })
        agg.calls += t.calls
        agg.errors += t.errors
        agg.msSum += t.msSum
        t.hist.forEach((n, i) => (agg.hist[i] += n))
      }
    }
  }
  for (const o of Object.values(out)) {
    for (const [name, a] of Object.entries(o.tools) as [string, any][]) {
      o.tools[name] = {
        calls: a.calls,
        errors: a.errors,
        avgMs: a.calls ? Math.round(a.msSum / a.calls) : 0,
        p50Ms: histPercentile(a.hist, 0.5),
        p95Ms: histPercentile(a.hist, 0.95),
      }
    }
  }
  return { from, to: today(now), days, editions: out }
}

/** Test hook. */
export function _resetMetrics() {
  store = { days: {} }
}
