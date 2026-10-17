// @vitest-environment jsdom
//
// The account page's "Revoke all keys for my wallet" button, page side: one click
// only arms it; the second asks the server for a revoke_all challenge naming the
// wallet, has Phantom sign exactly that message, and posts it to /auth/revoke
// mode=all. Server side (purpose binding) is covered in auth-purpose*.test.ts.

import { describe, expect, it, vi } from "vitest"
import nacl from "tweetnacl"
import bs58 from "bs58"

describe("account page — revoke all keys", () => {
  it("arms on the first click, revokes on the second with a revoke_all signature", async () => {
    window.history.replaceState(null, "", "/")
    document.body.innerHTML = `
      <h1>Get your API key</h1><p class="sub"></p>
      <div class="card" id="info"></div>
      <button id="signin">Connect Phantom &amp; get API key</button>
      <div id="result" style="display:none"></div>
      <div id="status" class="status" style="display:none"></div>
      <div id="footer">
        <button id="revoke-all">Revoke all keys for my wallet</button>
        <div id="revoke-status" style="display:none"></div>
      </div>`

    const kp = nacl.sign.keyPair()
    const pubkey = bs58.encode(kp.publicKey)
    const MESSAGE = `autoyield.org wants you to sign in with your Solana account:\n${pubkey}\n\nRevoke ALL autoyield API keys for this wallet.\n\nNonce: r1`
    const signMessage = vi.fn(async (bytes: Uint8Array) => ({
      signature: nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey),
    }))
    ;(window as any).phantom = {
      solana: { isPhantom: true, connect: async () => ({ publicKey: { toString: () => pubkey } }), signMessage },
    }

    let challengeBody: any = null
    let revokeBody: any = null
    const fetchMock = vi.fn(async (url: any, init?: any) => {
      const u = String(url)
      if (u.endsWith("/auth/challenge")) {
        challengeBody = JSON.parse(init.body)
        return { ok: true, json: async () => ({ nonce: "r1", message: MESSAGE }) }
      }
      if (u.endsWith("/auth/revoke")) {
        revokeBody = JSON.parse(init.body)
        return { ok: true, json: async () => ({ revoked: 2 }) }
      }
      throw new Error(`unexpected fetch ${u}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    await import("../../../web/src/account-main.ts")
    const btn = document.getElementById("revoke-all") as HTMLButtonElement

    btn.click()
    expect(btn.textContent).toMatch(/Click again/)
    expect(fetchMock).not.toHaveBeenCalled()

    btn.click()
    await vi.waitFor(() => expect(document.getElementById("revoke-status")!.textContent).toMatch(/Revoked 2 keys/))
    expect(challengeBody).toEqual({ purpose: "revoke_all", pubkey })
    expect(new TextDecoder().decode(Uint8Array.from(signMessage.mock.calls[0][0]))).toBe(MESSAGE)
    expect(revokeBody).toMatchObject({ mode: "all", pubkey, nonce: "r1" })
    const sig = Uint8Array.from(Buffer.from(revokeBody.signatureBase64, "base64"))
    expect(nacl.sign.detached.verify(Uint8Array.from(new TextEncoder().encode(MESSAGE)), sig, kp.publicKey)).toBe(true)
    expect(btn.textContent).toBe("Revoke all keys for my wallet")
    expect(btn.disabled).toBe(false)
  })
})
