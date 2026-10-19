import { afterEach, describe, expect, it, vi } from "vitest"

// 0.4.0: the StockWaves gate was retired on 2026-10-31, so with no XSTOCK_GATE_URL nothing is fetched and the
// tool says the gate is not configured (the buy flow treats that as "checks not run" and stays fail-open).
describe("xStock safety gate without XSTOCK_GATE_URL", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

  it("makes no network call and reports the gate as not configured", async () => {
    delete process.env.XSTOCK_GATE_URL
    vi.resetModules()
    const fetchSpy = vi.fn(async () => Response.json({}))
    vi.stubGlobal("fetch", fetchSpy)
    const { dispatch } = await import("../tools.js")
    const r: any = await dispatch({ name: "check_xstock_safety", arguments: { ticker: "AAPL" } } as any)
    const text = r.content[0].text as string
    expect(text).toMatch(/not configured/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
