// @vitest-environment jsdom
//
// Regression guard for the sign page's module-load + initial render.
//
// A TDZ ReferenceError in the i18n init (initial setLang() called before
// `let lastStatus` was declared) once halted the whole module before load()
// ran — the page froze on the static "Loading…" HTML and shipped to a real
// user. tsc passed, code review passed; nothing exercised the actual browser
// module-load. This test does: it imports sign-main under jsdom with the DOM
// + URL + fetch the module expects, and asserts (a) it doesn't throw at load,
// (b) load() fetched the tx, (c) the card rendered the tx (not stuck on
// "Loading…"). Any top-level init regression (TDZ, missing element, etc.)
// fails this.

import { describe, it, expect, vi } from "vitest"

describe("sign page module load + initial render", () => {
  it("initializes without throwing and renders the tx card", async () => {
    // URL must carry ?id= BEFORE import — the module reads location.search at
    // top-level. jsdom's default host is localhost (in the ALLOWED_HOSTS
    // allowlist, so checkOriginOrAbort passes).
    window.history.replaceState(null, "", "/?id=test-tx-id")

    // The DOM elements sign-main.ts grabs via getElementById at top-level.
    document.body.innerHTML = `
      <div class="lang" id="lang">
        <button id="lang-en" type="button">EN</button>
        <button id="lang-zh" type="button">中文</button>
      </div>
      <h1 id="title"></h1>
      <p id="sub"></p>
      <div id="card" class="card">Loading transaction…</div>
      <button id="sign" disabled>Connect Phantom &amp; Sign</button>
      <div id="status" class="status">Ready.</div>
      <p id="footer"></p>`

    const fakeTx = {
      id: "test-tx-id",
      kind: "buy_xstock",
      wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq",
      symbol: "NVDAx",
      ticker: "NVDA",
      inputAmount: 10,
      inputSymbol: "USDC",
      amountUsdc: 10,
      expectedOut: 0.0456,
    }
    const fetchMock = vi.fn((url: any) => {
      const u = String(url)
      if (u.includes("/sign/tx/")) {
        return Promise.resolve({ ok: true, status: 200, json: async () => fakeTx } as any)
      }
      // geofence ipapi.co (top-level, async, non-blocking)
      return Promise.resolve({ ok: true, json: async () => ({ country_code: "HK" }) } as any)
    })
    vi.stubGlobal("fetch", fetchMock)

    // Import runs top-level init (the TDZ used to throw here) + load().
    await import("../../../web/src/sign-main.ts")
    // Let load()'s awaited fetch + render microtasks settle.
    await new Promise((r) => setTimeout(r, 20))

    // (a)+(b): load() ran past init and fetched the tx — TDZ would have
    // stopped the module before this fetch.
    const fetchedTx = fetchMock.mock.calls.some((c) =>
      String(c[0]).includes("/sign/tx/test-tx-id"),
    )
    expect(fetchedTx).toBe(true)

    // (c): the card was re-rendered with the tx details — not stuck on the
    // static "Loading…" placeholder (the TDZ-freeze symptom).
    const card = document.getElementById("card")!
    expect(card.textContent).toContain("NVDAx")
    expect(card.textContent).not.toContain("Loading")

    // The sign button became actionable (load enabled it for a <$50 tx).
    const btn = document.getElementById("sign") as HTMLButtonElement
    expect(btn.disabled).toBe(false)
  })
})
