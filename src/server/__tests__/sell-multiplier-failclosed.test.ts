import { describe, expect, it, vi } from "vitest"

// Force the multiplier read to fail (RPC blip). Keep the real pure helpers.
vi.mock("../../sol/share-multiplier.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sol/share-multiplier.js")>()
  return { ...real, getShareMultiplier: vi.fn(async () => ({ status: "unavailable", value: 1 })) }
})

// If the handler ever reached the balance read / Jupiter, it did NOT fail closed.
vi.mock("../../sol/balances.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../sol/balances.js")>()
  return {
    ...real,
    getRawTokenBalance: vi.fn(async () => {
      throw new Error("must not be reached when the multiplier is unavailable")
    }),
  }
})

const { dispatch } = await import("../tools.js")

const WALLET = "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq"

describe("build_sell_xstock_tx with an unreadable share multiplier", () => {
  it("refuses a numeric share amount instead of treating shares as raw (would oversell ~0.6%)", async () => {
    const res: any = await dispatch({
      name: "build_sell_xstock_tx",
      arguments: { wallet: WALLET, ticker: "SPY", amountShares: "1.5" },
    })
    expect(res.isError).toBe(true)
    const body = JSON.parse(res.content[0].text)
    expect(body.ok).toBe(false)
    expect(body.reason).toMatch(/share multiplier/)
    expect(body.reason).toMatch(/"max"/) // points at the exact-balance escape hatch
  })
})
