import { describe, it, expect } from "vitest"
import { evaluateDeltas, type PreflightExpectation } from "../../sol/preflight.js"

const EXP: PreflightExpectation = {
  wallet: "3yAgGoV4ZS17uyAu9ahrB7dERShg835mHzFUHXJbS8Sq",
  inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  outputMint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
  inputDecimals: 6,
  outputDecimals: 8,
  inputAmount: 10, // spend 10 USDC
  minOut: 0.0453, // accept ≥ 0.0453 NVDAx
}

describe("evaluateDeltas (WYSIWYS verdict)", () => {
  it("passes a normal swap within expected bounds", () => {
    const v = evaluateDeltas(10, 0.0456, EXP) // spent 10, received 0.0456
    expect(v.verdict).toBe("pass")
  })

  it("passes when slightly less is spent / more received (favorable)", () => {
    expect(evaluateDeltas(9.98, 0.046, EXP).verdict).toBe("pass")
  })

  it("flags receiving NONE of the output mint (redirected output)", () => {
    const v = evaluateDeltas(10, 0, EXP)
    expect(v.verdict).toBe("violation")
    expect(v.reason).toMatch(/received none/i)
  })

  it("flags receiving far below minOut (drained / wrong token)", () => {
    const v = evaluateDeltas(10, 0.02, EXP) // < 50% of 0.0453
    expect(v.verdict).toBe("violation")
    expect(v.reason).toMatch(/below the minimum/i)
  })

  it("flags spending far above the agreed input (over-spend attack)", () => {
    const v = evaluateDeltas(100, 0.0456, EXP) // 10× the agreed 10
    expect(v.verdict).toBe("violation")
    expect(v.reason).toMatch(/above the agreed input/i)
  })

  it("tolerates normal slippage just under minOut (between 50% and 100%)", () => {
    // 0.0455 expected, got 0.0452 — under minOut but well within the loose
    // 50% floor, so shadow check passes (Jupiter's own slippage handles the
    // real floor; this backstop only catches gross divergence).
    expect(evaluateDeltas(10, 0.0452, EXP).verdict).toBe("pass")
  })
})
