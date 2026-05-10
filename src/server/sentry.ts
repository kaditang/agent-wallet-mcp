// Sentry error reporting. No-op when SENTRY_DSN is unset, so local dev and
// users running without a DSN see zero overhead and zero outbound network.
//
// Why a thin wrapper instead of importing @sentry/node directly at call sites:
// - One place to flip on/off and to control init options.
// - Call sites can `captureError(e, { tags })` without checking DSN presence.
// - Keeps the Sentry import out of hot paths if DSN is absent (the init call
//   itself is cheap, but `Sentry.captureException` from disabled state is a
//   noop — no extra guard needed).

import * as Sentry from "@sentry/node"

let initialized = false

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN
  if (!dsn) return
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    release: process.env.SENTRY_RELEASE, // optional; set via CI/Fly env if desired
    tracesSampleRate: 0, // we only care about errors for now, not perf traces
    // Strip request bodies / cookies / headers — our requests can carry api
    // keys (Authorization: ak_*) and signed-tx blobs we don't want shipped off.
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies
        delete event.request.headers
        delete event.request.data
        delete event.request.query_string
      }
      return event
    },
  })
  initialized = true
  console.log("[sentry] initialized")
}

export function captureError(
  err: unknown,
  ctx?: { tags?: Record<string, string>; extra?: Record<string, unknown> },
): void {
  if (!initialized) return
  Sentry.captureException(err, {
    tags: ctx?.tags,
    extra: ctx?.extra,
  })
}

export function captureMessage(
  msg: string,
  level: "info" | "warning" | "error" = "warning",
  ctx?: { tags?: Record<string, string> },
): void {
  if (!initialized) return
  Sentry.captureMessage(msg, { level, tags: ctx?.tags })
}

/** Flush pending events; call before process exit. */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!initialized) return
  try {
    await Sentry.flush(timeoutMs)
  } catch {
    // best effort
  }
}
