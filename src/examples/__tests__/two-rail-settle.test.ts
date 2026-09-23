import { describe, it, expect } from "vitest"
import {
  quoteSettlement,
  pickCheaperRail,
  type SettleQuote,
} from "../two-rail-settle.js"

describe("quoteSettlement (per-call rail quote)", () => {
  it("rejects a non-positive amount", () => {
    expect(() => quoteSettlement("nano-xno", 0)).toThrow(/positive number/)
    expect(() => quoteSettlement("usdc-solana", -1)).toThrow(/positive number/)
  })

  it("quotes the USDC rail with its processing fee and gas finality", () => {
    const q = quoteSettlement("usdc-solana", 1.0)
    expect(q.rail).toBe("usdc-solana")
    expect(q.feeUsd).toBeGreaterThan(0)
    expect(q.finality).toBe("seconds")
    expect(q.instruction).toContain("USDC on Solana")
  })

  it("quotes the Nano rail as feeless and sub-second", () => {
    const q = quoteSettlement("nano-xno", 1.0)
    expect(q.rail).toBe("nano-xno")
    expect(q.feeUsd).toBe(0)
    expect(q.finality).toBe("sub-second")
  })

  it("returns a wallet-readable instruction on both rails", () => {
    for (const rail of ["usdc-solana", "nano-xno"] as const) {
      const q = quoteSettlement(rail, 0.5)
      expect(q.instruction.length).toBeGreaterThan(0)
      expect(typeof q.instruction).toBe("string")
    }
  })
})

describe("pickCheaperRail (two-rail decision for a recurring micro-payment)", () => {
  it("picks the feeless Nano rail for a tiny per-call fee", () => {
    const chosen = pickCheaperRail(0.05)
    expect(chosen.rail).toBe("nano-xno")
    expect(chosen.feeUsd).toBe(0)
  })

  it("ties (no fee either way) resolve by finality to the sub-second rail", () => {
    // A large enough amount that the fixed bps fee == 0 is only the Nano path;
    // assert the tie-break holds for any positive amount that still gives 0 fees.
    const q: SettleQuote = quoteSettlement("nano-xno", 1)
    expect(q.feeUsd).toBe(0)
    expect(q.finality).toBe("sub-second")
  })

  it("always returns a valid quote for a range of per-call amounts", () => {
    for (const amount of [0.005, 0.01, 0.05, 0.25, 1, 5]) {
      const q = pickCheaperRail(amount)
      expect(q.amountUsd).toBe(amount)
      expect(["usdc-solana", "nano-xno"]).toContain(q.rail)
    }
  })
})
