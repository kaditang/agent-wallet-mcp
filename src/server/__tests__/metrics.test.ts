import "./setup.js"
import { beforeEach, describe, expect, it } from "vitest"
import request from "supertest"
import { app } from "../index.js"
import { _resetMetrics, histPercentile, metricsSummary } from "../metrics.js"

const init = (path: string) =>
  request(app)
    .post(path)
    .set("Accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })

describe("usage metrics", () => {
  beforeEach(() => _resetMetrics())

  it("histogram percentiles", () => {
    // bins: ≤250, ≤500, ≤1000, ≤2000, ≤4000, ≤8000, >8000
    expect(histPercentile([10, 0, 0, 0, 0, 0, 0], 0.5)).toBe(250)
    expect(histPercentile([5, 4, 0, 1, 0, 0, 0], 0.95)).toBe(2000)
    expect(histPercentile([0, 0, 0, 0, 0, 0, 0], 0.5)).toBeNull()
  })

  it("counts research connections and tool calls (with errors) without storing arguments", async () => {
    await init("/research")
    // a tool call that errors (missing args) — counted as a call + an error
    await request(app)
      .post("/research")
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "quote_tokenized_stock", arguments: { wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq" } } })
    const s = metricsSummary(1)
    expect(s.editions.research.connects).toBe(1)
    expect(s.editions.research.tools.quote_tokenized_stock).toMatchObject({ calls: 1, errors: 1 })
    expect(JSON.stringify(s)).not.toMatch(/3yAgGo/) // no wallet stored anywhere
  })

  it("/metrics needs the bearer token (404 otherwise)", async () => {
    expect((await request(app).get("/metrics")).status).toBe(404)
    expect((await request(app).get("/metrics").set("Authorization", "Bearer wrong")).status).toBe(404)
    const ok = await request(app).get("/metrics?days=7").set("Authorization", "Bearer test-metrics-token")
    expect(ok.status).toBe(200)
    expect(ok.body.days).toBe(7)
  })
})

describe("client software names", () => {
  it("counts connections per sanitized client name, bounded per day", async () => {
    const { _resetMetrics, recordConnect, metricsSummary, clientKey } = await import("../metrics.js")
    _resetMetrics()
    recordConnect("research", "Claude-AI")
    recordConnect("research", "claude-ai")
    recordConnect("research", undefined)
    recordConnect("research", "<script>x</script>")
    const r = metricsSummary(1).editions.research
    expect(r.connects).toBe(4)
    expect(r.clients["claude-ai"]).toBe(2)
    expect(r.clients._unknown).toBe(1)
    expect(clientKey("<script>x</script>")).toBe("scriptxscript")
    for (let i = 0; i < 60; i++) recordConnect("research", `bot${i}`)
    expect(Object.keys(metricsSummary(1).editions.research.clients).length).toBeLessThanOrEqual(51)
    expect(metricsSummary(1).editions.research.clients._other).toBeGreaterThan(0)
  })
})
