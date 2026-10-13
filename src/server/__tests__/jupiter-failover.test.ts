import { afterEach, describe, expect, it, vi } from "vitest"
import { isJupFailoverStatus, jupErrorText, jupiterQuote } from "../../sol/jupiter.js"

const QUOTE = { inAmount: "100000000", outAmount: "12784674", otherAmountThreshold: "12720751", priceImpactPct: "0", routePlan: [] }
const NGINX_503 = "<html>\r\n<head><title>503 Service Temporarily Unavailable</title></head>\r\n<body><center><h1>503</h1></center></body></html>"

describe("Jupiter host failover", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("falls over to the next host on a 503 and returns its quote", async () => {
    const hosts: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      hosts.push(new URL(url).host)
      return hosts.length === 1 ? new Response(NGINX_503, { status: 503 }) : Response.json(QUOTE)
    }))
    const q = await jupiterQuote({ inputMint: "A", outputMint: "B", amountAtomic: 100_000_000n })
    expect(q.outAmount).toBe("12784674")
    expect(hosts).toEqual(["api.jup.ag", "lite-api.jup.ag"])
  })

  it("falls over on a network error / timeout too", async () => {
    let n = 0
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (n++ === 0) throw new TypeError("fetch failed")
      return Response.json(QUOTE)
    }))
    await expect(jupiterQuote({ inputMint: "A", outputMint: "B", amountAtomic: 1n })).resolves.toMatchObject({ outAmount: "12784674" })
  })

  it("does NOT fail over on a 400 (bad request fails everywhere)", async () => {
    const f = vi.fn(async () => new Response('{"error":"Could not find any route"}', { status: 400 }))
    vi.stubGlobal("fetch", f)
    await expect(jupiterQuote({ inputMint: "A", outputMint: "B", amountAtomic: 1n })).rejects.toThrow(/jupiter quote 400/)
    expect(f).toHaveBeenCalledTimes(1)
  })

  it("all hosts down → short, HTML-free error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(NGINX_503, { status: 503 })))
    const err = await jupiterQuote({ inputMint: "A", outputMint: "B", amountAtomic: 1n }).catch((e) => e as Error)
    expect(err.message).toMatch(/^jupiter quote 503/)
    expect(err.message).not.toMatch(/<|>/)
    expect(err.message.length).toBeLessThan(200)
  })
})

describe("pure helpers", () => {
  it("failover statuses", () => {
    for (const s of [500, 502, 503, 504, 429, 401, 403]) expect(isJupFailoverStatus(s)).toBe(true)
    for (const s of [400, 404, 422]) expect(isJupFailoverStatus(s)).toBe(false)
  })
  it("strips HTML", () => {
    expect(jupErrorText(503, NGINX_503)).toBe("503 503 Service Temporarily Unavailable 503")
  })
})
