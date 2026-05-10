import type { Request, Response, NextFunction } from "express"

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

// Demo-grade. For production swap to OAuth/JWT (Auth0, Clerk, WorkOS, Supabase).
// The mapping is token -> userId. Multiple tokens may map to the same user.
const TABLE = new Map<string, string>(
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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.header("authorization") ?? ""
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : ""
  const userId = TABLE.get(token)
  if (!userId) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  req.userId = userId
  next()
}
