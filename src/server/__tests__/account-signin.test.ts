// @vitest-environment jsdom
//
// The account page prefers Phantom's native signIn: it passes the server's signIn fields,
// forwards the bytes the wallet signed, and falls back to signMessage only when signIn is
// missing or fails for a reason other than the user cancelling.

import { beforeAll, describe, expect, it, vi } from "vitest"
import nacl from "tweetnacl"
import bs58 from "bs58"

const kp = nacl.sign.keyPair()
const pubkey = bs58.encode(kp.publicKey)
const SIGN_IN = { domain: "autoyield.org", address: pubkey, statement: "Sign in.", nonce: "n1" }
const MESSAGE = `autoyield.org wants you to sign in with your Solana account:\n${pubkey}\n\nSign in.\n\nNonce: n1`
let verifyBody: any = null

function phantom(extra: Record<string, unknown>) {
  const signMessage = vi.fn(async (bytes: Uint8Array) => ({ signature: nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey) }))
  ;(window as any).phantom = {
    solana: { isPhantom: true, connect: async () => ({ publicKey: { toString: () => pubkey } }), signMessage, ...extra },
  }
  return signMessage
}

async function clickAndWait() {
  verifyBody = null
  document.getElementById("status")!.textContent = "" // the previous run's result must not satisfy the wait
  const btn = document.getElementById("signin") as HTMLButtonElement
  btn.disabled = false // the page disables the button after a key is issued (one key per visit)
  btn.click()
  await vi.waitFor(() => expect(document.getElementById("status")!.textContent).toMatch(/Signed in|cancelled|failed/))
}

describe("account page — signIn first, signMessage fallback", () => {
  beforeAll(async () => {
    window.history.replaceState(null, "", "/")
    document.body.innerHTML = `
      <h1>Get your API key</h1><p class="sub"></p><div class="card" id="info"></div>
      <button id="signin">Connect Phantom &amp; get API key</button>
      <div id="result" style="display:none"></div>
      <div id="status" class="status" style="display:none"></div>`
    vi.stubGlobal("fetch", vi.fn(async (url: any, init?: any) => {
      const u = String(url)
      if (u.endsWith("/auth/challenge")) return { ok: true, json: async () => ({ nonce: "n1", message: MESSAGE, signIn: SIGN_IN }) }
      if (u.endsWith("/auth/verify")) {
        verifyBody = JSON.parse(init.body)
        return { ok: true, json: async () => ({ apiKey: "ak_test", pubkey }) }
      }
      throw new Error(`unexpected fetch ${u}`)
    }))
    await import("../../../web/src/account-main.ts")
  })

  it("uses signIn and forwards the wallet-signed bytes", async () => {
    const walletText = MESSAGE.replace("Sign in.", "Sign in.") // the wallet's own rendering
    const signIn = vi.fn(async () => {
      const bytes = new TextEncoder().encode(walletText)
      return { address: { toString: () => pubkey }, signedMessage: bytes, signature: nacl.sign.detached(Uint8Array.from(bytes), kp.secretKey) }
    })
    const signMessage = phantom({ signIn })
    await clickAndWait()
    expect(signIn).toHaveBeenCalledWith(SIGN_IN)
    expect(signMessage).not.toHaveBeenCalled()
    expect(Buffer.from(verifyBody.signedMessageBase64, "base64").toString()).toBe(walletText)
    const ok = nacl.sign.detached.verify(
      Uint8Array.from(Buffer.from(verifyBody.signedMessageBase64, "base64")),
      Uint8Array.from(Buffer.from(verifyBody.signatureBase64, "base64")),
      kp.publicKey,
    )
    expect(ok).toBe(true)
  })

  it("falls back to signMessage when signIn is missing", async () => {
    const signMessage = phantom({})
    await clickAndWait()
    expect(signMessage).toHaveBeenCalledOnce()
    expect(verifyBody.signedMessageBase64).toBeUndefined()
  })

  it("falls back when signIn errors, but not when the user cancels", async () => {
    const broken = phantom({ signIn: vi.fn(async () => { throw new Error("Method not supported") }) })
    await clickAndWait()
    expect(broken).toHaveBeenCalledOnce()

    const cancelled = phantom({ signIn: vi.fn(async () => { throw new Error("User rejected the request.") }) })
    await clickAndWait()
    expect(cancelled).not.toHaveBeenCalled()
    expect(verifyBody).toBeNull()
  })

  it("refuses a signIn done with another account", async () => {
    const other = nacl.sign.keyPair()
    const signMessage = phantom({
      signIn: vi.fn(async () => ({ address: { toString: () => bs58.encode(other.publicKey) }, signedMessage: new Uint8Array(1), signature: new Uint8Array(64) })),
    })
    await clickAndWait()
    expect(signMessage).not.toHaveBeenCalled()
    expect(verifyBody).toBeNull()
    expect(document.getElementById("status")!.textContent).toMatch(/different account/)
  })
})
