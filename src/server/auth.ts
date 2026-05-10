import type { Request, Response, NextFunction } from "express"

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
