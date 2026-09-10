// @vitest-environment jsdom
//
// The sign page must show the xStock leg in SHARES (what the user asked for and
// what Phantom displays), while the server keeps RAW token units for preflight.
// Values are a real SPYx wallet measured 2026-09-10: raw 182.7812703 tokens ×
// multiplier 1.005714560286254 = 183.82578488 shares displayed.
import { describe, it, expect, vi } from "vitest"

async function renderWith(fakeTx: Record<string, unknown>) {
  vi.resetModules()
  window.history.replaceState(null, "", `/?id=${fakeTx.id}`)
  document.body.innerHTML = `
    <div class="lang" id="lang"><button id="lang-en" type="button">EN</button><button id="lang-zh" type="button">中文</button></div>
    <h1 id="title"></h1><p id="sub"></p>
    <div id="card" class="card">Loading transaction…</div>
    <button id="sign" disabled>Connect Phantom &amp; Sign</button>
    <div id="status" class="status">Ready.</div><p id="footer"></p>`
  vi.stubGlobal(
    "fetch",
    vi.fn((url: any) =>
      String(url).includes("/sign/tx/")
        ? Promise.resolve({ ok: true, status: 200, json: async () => fakeTx } as any)
        : Promise.resolve({ ok: true, json: async () => ({ country_code: "HK" }) } as any),
    ),
  )
  await import("../../../web/src/sign-main.ts")
  await new Promise((r) => setTimeout(r, 20))
  return document.getElementById("card")!.textContent ?? ""
}

describe("sign page shows xStock legs in shares", () => {
  it("sell: Spending row is shares, not raw tokens", async () => {
    const text = await renderWith({
      id: "sell-1", kind: "sell_xstock", wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq",
      symbol: "SPYx", ticker: "SPY", inputAmount: 182.7812703, inputSymbol: "SPYx",
      expectedOut: 138500, shareMultiplier: 1.005714560286254, shareSide: "input",
    })
    expect(text).toContain("183.825785 SPYx")
    expect(text).not.toContain("182.78127 SPYx")
    expect(text).toContain("138500 USDC") // the USDC leg is never rescaled
  })

  it("buy: You-receive row is shares", async () => {
    const text = await renderWith({
      id: "buy-1", kind: "buy_xstock", wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq",
      symbol: "SPYx", ticker: "SPY", inputAmount: 1000, inputSymbol: "USDC", amountUsdc: 1000,
      expectedOut: 1.311574, shareMultiplier: 1.005714560286254, shareSide: "output",
    })
    expect(text).toContain("1.319069 SPYx")
    expect(text).toContain("1000 USDC")
  })

  it("older stashed tx without a multiplier renders raw, unchanged", async () => {
    const text = await renderWith({
      id: "old-1", kind: "buy_xstock", wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq",
      symbol: "NVDAx", ticker: "NVDA", inputAmount: 10, inputSymbol: "USDC", amountUsdc: 10, expectedOut: 0.0456,
    })
    expect(text).toContain("0.0456 NVDAx")
  })
})
