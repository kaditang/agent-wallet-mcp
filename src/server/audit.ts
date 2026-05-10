// Append-only audit log. Every tx-construction and broadcast event is
// recorded so we can investigate incidents after the fact.
//
// Format: one JSON object per line (ndjson). Path configurable via env.

import fs from "node:fs"
import path from "node:path"

const LOG_PATH = process.env.AUDIT_LOG_PATH ?? "data/audit.log"

export type AuditEvent = {
  t: number // ms epoch
  kind:
    | "build_tx"
    | "rebuild_tx"
    | "broadcast_attempt"
    | "broadcast_success"
    | "broadcast_failure"
    | "auth_fail"
    | "rate_limit"
    | "api_key_minted"
    | "api_key_revoked"
    | "client_register"
  ip?: string
  wallet?: string
  signId?: string
  txKind?: string
  amount?: number
  symbol?: string
  signature?: string
  error?: string
  extra?: Record<string, unknown>
}

let queue: AuditEvent[] = []
let flushScheduled = false

function ensureDir() {
  const dir = path.dirname(LOG_PATH)
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function audit(ev: Omit<AuditEvent, "t">): void {
  queue.push({ t: Date.now(), ...ev })
  if (flushScheduled) return
  flushScheduled = true
  setTimeout(flush, 200)
}

function flush() {
  flushScheduled = false
  if (queue.length === 0) return
  const batch = queue
  queue = []
  try {
    ensureDir()
    const lines = batch.map((e) => JSON.stringify(e)).join("\n") + "\n"
    fs.appendFileSync(LOG_PATH, lines)
  } catch (e) {
    console.warn(`[audit] write failed: ${(e as Error).message}`)
  }
}

// Best-effort flush on shutdown.
process.on("beforeExit", flush)
process.on("SIGTERM", () => {
  flush()
  process.exit(0)
})
process.on("SIGINT", () => {
  flush()
  process.exit(0)
})
