import type { Request, Response, NextFunction } from "express"
import { lookupApiKey } from "./auth-store.js"

/**
 * Sanitize an error message before returning to the client. Strips file
 * paths, stack traces, and zod schema internals. In dev mode (NODE_ENV !==
 * 'production'), passes through to aid debugging.
 */
export function sanitizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (process.env.NODE_ENV !== "production") return raw

  // Strip file paths like /Users/.../foo.ts:123:45
  let s = raw.replace(/(\/[^\s]+\.[a-z]+:\d+:\d+)/g, "")
  // Strip "at functionName (...)" stack lines
  s = s.replace(/at \S+ \([^)]+\)/g, "")
  // Truncate to a reasonable length
  if (s.length > 240) s = s.slice(0, 240) + "…"
  return s.trim() || "internal error"
}

/** Standard sanitized 500 reply. */
export function reply500(res: Response, e: unknown) {
  const msg = sanitizeError(e)
  // Always log full server-side
  console.error("[error]", e)
  res.status(500).json({ error: msg })
}

// Two auth paths (checked in order):
//
// 1. **API key** (production path): user signs in with Phantom at
//    autoyield.org/account, we mint an `ak_<64hex>` key. Hashed in
//    data/api-keys.json. userId = the wallet pubkey.
//
// 2. **DEMO_TOKENS env** (legacy / bootstrap fallback): same shape as before,
//    "tok1:userA,tok2:userB". Useful for local dev and emergency access if
//    api-keys.json gets wiped. Deprecated for end-users — set to "" in prod
//    once everyone is on api keys.
const DEMO_TABLE = new Map<string, string>(
  (process.env.DEMO_TOKENS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((kv) => {
      const [token, userId] = kv.split(":")
      return [token, userId] as const
    }),
)

declare module "express-serve-static-core" {
  interface Request {
    userId?: string
  }
}

// RFC 6750: 401 responses on protected resources should include
// WWW-Authenticate so clients know the scheme. Without this header,
// Smithery's gateway falls back to assuming OAuth — and gets stuck.
const WWW_AUTH = 'Bearer realm="autoyield-mcp", error="invalid_token"'

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization") ?? ""
  // Accept three formats so we play nice with proxies (e.g. Smithery's
  // gateway) that can't template a "Bearer " prefix onto user-supplied
  // params:
  //   1. `Authorization: Bearer ak_xxx`        ← canonical
  //   2. `Authorization: ak_xxx`               ← raw api key as the value
  //   3. `Authorization: Bearer demo-token`    ← DEMO_TOKENS fallback path
  let token = ""
  if (auth.startsWith("Bearer ")) {
    token = auth.slice(7)
  } else if (auth.startsWith("ak_")) {
    token = auth
  }
  if (!token) {
    res.set("WWW-Authenticate", WWW_AUTH)
    res.status(401).json({ error: "unauthorized" })
    return
  }
  // Path 1: api key (Phantom-issued)
  if (token.startsWith("ak_")) {
    const pubkey = lookupApiKey(token)
    if (pubkey) {
      req.userId = pubkey
      next()
      return
    }
  }
  // Path 2: DEMO_TOKENS fallback
  const demoUser = DEMO_TABLE.get(token)
  if (demoUser) {
    req.userId = demoUser
    next()
    return
  }
  res.set("WWW-Authenticate", WWW_AUTH)
  res.status(401).json({ error: "unauthorized" })
}
