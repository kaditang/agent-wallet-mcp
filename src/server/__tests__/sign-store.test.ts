import "./setup.js"
import { afterEach, describe, expect, it } from "vitest"
import {
  BroadcastLockError,
  RebuildCapError,
  REBUILD_CAP_PER_ID,
  recordSignature,
  reserveRebuild,
  stashSignableTx,
  withBroadcastLock,
} from "../../sol/sign-store.js"

const FAKE_TX = "AAAAAA=="
const FAKE_WALLET = "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq"

function newStash() {
  return stashSignableTx({
    kind: "deposit_yield",
    wallet: FAKE_WALLET,
    inputAmount: 1,
    inputSymbol: "USDC",
    unsignedTxBase64: FAKE_TX,
  })
}

describe("sign-store", () => {
  describe("withBroadcastLock", () => {
    it("rejects second submit with BroadcastLockError(already-broadcast) once a signature is recorded", async () => {
      const id = newStash()
      // First broadcast resolves and records.
      await withBroadcastLock(id, async () => {
        recordSignature(id, "fake-sig")
        return "fake-sig"
      })
      // Second attempt should reject before fn runs.
      await expect(
        withBroadcastLock(id, async () => {
          throw new Error("should-not-run")
        }),
      ).rejects.toBeInstanceOf(BroadcastLockError)
    })

    it("rejects parallel submit with BroadcastLockError(in-flight)", async () => {
      const id = newStash()
      // Start a slow broadcast that resolves only after we trigger #2.
      let release!: () => void
      const slow = withBroadcastLock(id, () => {
        return new Promise<string>((res) => {
          release = () => res("ok")
        })
      })
      // Concurrent attempt: should reject immediately because broadcastingAt
      // is set synchronously inside withBroadcastLock.
      await expect(
        withBroadcastLock(id, async () => "second"),
      ).rejects.toBeInstanceOf(BroadcastLockError)
      release()
      await slow
    })
  })

  describe("reserveRebuild", () => {
    it("counts up to the cap and then throws RebuildCapError", () => {
      const id = newStash()
      for (let i = 1; i <= REBUILD_CAP_PER_ID; i++) {
        const next = reserveRebuild(id)
        expect(next).toBe(i)
      }
      expect(() => reserveRebuild(id)).toThrow(RebuildCapError)
    })

    it("returns 0 (no-op) for an unknown id", () => {
      expect(reserveRebuild("does-not-exist")).toBe(0)
    })
  })
})
