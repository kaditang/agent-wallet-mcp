import { describe, it, expect, beforeAll } from "vitest"
import type { Connection } from "@solana/web3.js"

// connection.ts captures RPC_CALL_TIMEOUT_MS at module load and builds its
// endpoint pool from env + public defaults (always ≥2 endpoints). Set a short
// timeout BEFORE importing so a hanging attempt fails over quickly under test.
let withRpcFallback: (fn: (c: Connection) => Promise<unknown>) => Promise<unknown>
let endpointCount: number

beforeAll(async () => {
  process.env.RPC_CALL_TIMEOUT_MS = "50"
  const mod = await import("../../sol/connection.js")
  withRpcFallback = mod.withRpcFallback as typeof withRpcFallback
  endpointCount = mod.SOL_RPC_ENDPOINTS.length
})

const never = () => new Promise<never>(() => {})

describe("withRpcFallback", () => {
  it("times out a hanging endpoint and falls over to the next", async () => {
    expect(endpointCount).toBeGreaterThanOrEqual(2)
    let calls = 0
    const out = await withRpcFallback(async () => {
      calls++
      if (calls === 1) return never() // first endpoint hangs → 50ms timeout
      return "ok" // second endpoint answers
    })
    expect(out).toBe("ok")
    expect(calls).toBe(2)
  })

  it("falls over on a transient (429) error", async () => {
    let calls = 0
    const out = await withRpcFallback(async () => {
      calls++
      if (calls === 1) throw new Error("429 Too Many Requests")
      return "recovered"
    })
    expect(out).toBe("recovered")
    expect(calls).toBe(2)
  })

  it("throws a non-transient error immediately without falling over", async () => {
    let calls = 0
    await expect(
      withRpcFallback(async () => {
        calls++
        throw new Error("invalid public key input")
      }),
    ).rejects.toThrow(/invalid public key/)
    expect(calls).toBe(1)
  })
})
