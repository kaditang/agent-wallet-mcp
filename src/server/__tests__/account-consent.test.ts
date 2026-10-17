// @vitest-environment jsdom
//
// The OAuth consent page (account.html?authz=…) end to end on the page side:
// it must show WHO is asking, have Phantom sign the server-issued message
// that names the app, post that signature to /oauth/approve, and never show
// or handle the api key itself. Server side is covered in oauth.test.ts.

import { describe, expect, it, vi } from "vitest"
import nacl from "tweetnacl"
import bs58 from "bs58"

describe("account page — OAuth consent mode", () => {
  it("shows the requesting app, signs the bound message, approves", async () => {
    const AUTHZ = "AbCdEfGhIjKlMnOpQrStUvWx"
    window.history.replaceState(null, "", `/?authz=${AUTHZ}`)
    document.body.innerHTML = `
      <h1>Get your API key</h1><p class="sub"></p>
      <div class="card" id="info"></div>
      <button id="signin">Connect Phantom &amp; get API key</button>
      <div id="result" style="display:none"></div>
      <div id="status" class="status" style="display:none"></div>`

    const kp = nacl.sign.keyPair()
    const pubkey = bs58.encode(kp.publicKey)
    const MESSAGE = `autoyield.org wants you to sign in with your Solana account:\n${pubkey}\n\nAuthorize "Claude" (claude.ai) to use autoyield as an MCP connector.\n\nNonce: n1\nRequest ID: ${AUTHZ}`
    // Uint8Array.from: jsdom's TextEncoder returns a cross-realm Uint8Array that
    // tweetnacl's instanceof check rejects (a test-harness artifact, not a page bug).
    const signMessage = vi.fn(async (bytes: Uint8Array) => ({
      signature: nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey),
    }))
    ;(window as any).phantom = {
      solana: { isPhantom: true, connect: async () => ({ publicKey: { toString: () => pubkey } }), signMessage },
    }

    let approveBody: any = null
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url)
      if (u.endsWith(`/oauth/request/${AUTHZ}`)) {
        return { ok: true, json: async () => ({ client_name: "Claude", redirect_host: "claude.ai", known_host: true }) }
      }
      if (u.endsWith("/oauth/challenge")) {
        expect(JSON.parse(init.body)).toEqual({ authz: AUTHZ, pubkey })
        return { ok: true, json: async () => ({ nonce: "n1", message: MESSAGE }) }
      }
      if (u.endsWith("/oauth/approve")) {
        approveBody = JSON.parse(init.body)
        return { ok: true, json: async () => ({ redirect: "https://claude.ai/api/mcp/auth_callback?code=c1&state=s" }) }
      }
      if (u.endsWith("/auth/challenge") || u.endsWith("/auth/verify")) {
        throw new Error("plain API-key sign-in must not run in consent mode")
      }
      return { ok: true, json: async () => ({}) }
    })
    vi.stubGlobal("fetch", fetchMock)

    await import("../../../web/src/account-main.ts")
    await vi.waitFor(() => expect(document.querySelector("h1")!.textContent).toBe("Connect Claude to autoyield"))
    expect(document.querySelector(".sub")!.textContent).toContain("claude.ai")
    expect(document.getElementById("status")!.style.display).toBe("none") // known host → no warning

    const btn = document.getElementById("signin") as HTMLButtonElement
    expect(btn.textContent).toBe("Connect Phantom & authorize Claude")
    btn.click()

    await vi.waitFor(() => expect(approveBody, document.getElementById("status")!.textContent ?? "").not.toBeNull())
    // Phantom signed exactly the server-issued, app-naming message…
    expect(new TextDecoder().decode(Uint8Array.from(signMessage.mock.calls[0][0]))).toBe(MESSAGE)
    // …and the page forwarded a signature that verifies for that wallet.
    expect(approveBody).toMatchObject({ authz: AUTHZ, pubkey, nonce: "n1" })
    const sig = Uint8Array.from(Buffer.from(approveBody.signatureBase64, "base64"))
    expect(nacl.sign.detached.verify(Uint8Array.from(new TextEncoder().encode(MESSAGE)), sig, kp.publicKey)).toBe(true)
    await vi.waitFor(() => expect(document.getElementById("status")!.textContent).toMatch(/Authorized/))
    // The api key never reaches the page in this flow.
    expect(document.body.innerHTML).not.toMatch(/ak_/)
  })
})
