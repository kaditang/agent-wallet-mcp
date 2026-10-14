// Load a persisted JSON store without ever losing it to a bad read.
//
// Every store (api keys, OAuth clients, sign store, metrics) used to start
// empty when its file failed to parse — and the next debounced save then
// overwrote the file with that empty state. One corrupt api-keys.json would
// have silently revoked every user's key. Now an unreadable file is moved
// aside as `<path>.corrupt-<timestamp>` (kept for recovery) and reported, and
// the store starts empty knowingly.

import fs from "node:fs"
import { captureMessage } from "./sentry.js"

/** Parsed file contents, or undefined when the file is missing or unreadable. */
export function loadJsonFile<T>(file: string, label: string): T | undefined {
  if (!fs.existsSync(file)) return undefined
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch (e) {
    const aside = `${file}.corrupt-${Date.now()}`
    let moved = false
    try {
      fs.renameSync(file, aside)
      moved = true
    } catch {
      /* fall through: still report */
    }
    const msg = `[${label}] could not parse ${file} (${(e as Error).message}); ${moved ? `moved to ${aside}` : "could not move it aside"} — starting empty`
    console.error(msg)
    // Stores load at import time, before index.ts runs initSentry().
    setImmediate(() => captureMessage(msg, "error", { tags: { store: label } }))
    return undefined
  }
}
