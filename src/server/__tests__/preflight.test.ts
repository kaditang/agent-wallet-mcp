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

// 2026-10-15: the preflight runs on two RPC endpoints; one bad endpoint must not decide alone.
import { combineVerdicts, preflightQuorum, type PreflightVerdict } from "../../sol/preflight.js"

const V = (verdict: PreflightVerdict["verdict"], reason = verdict): PreflightVerdict => ({ verdict, reason })

describe("combineVerdicts (multi-RPC preflight)", () => {
  it("any violation wins — one honest node stops a tampered tx another node passes", () => {
    expect(combineVerdicts([V("pass"), V("violation", "received none")]).verdict).toBe("violation")
    expect(combineVerdicts([V("violation"), V("pass")]).verdict).toBe("violation")
    expect(combineVerdicts([V("skip"), V("violation")]).reason).toContain("[rpc 1]")
  })
  it("pass beside a sim-error passes (a real failure moves nothing on-chain; a lagging node must not block)", () => {
    const v = combineVerdicts([V("sim-error", "AccountNotFound"), V("pass")])
    expect(v.verdict).toBe("pass")
    expect(v.reason).toContain("other endpoints: sim-error")
  })
  it("sim-error only when no node passed", () => {
    expect(combineVerdicts([V("sim-error"), V("skip")]).verdict).toBe("sim-error")
    expect(combineVerdicts([V("sim-error"), V("sim-error")]).verdict).toBe("sim-error")
  })
  it("all skip (or nothing) fails open as before", () => {
    expect(combineVerdicts([V("skip"), V("skip")]).verdict).toBe("skip")
    expect(combineVerdicts([]).verdict).toBe("skip")
  })
  it("a single endpoint behaves exactly as before (no [rpc i] tag)", () => {
    expect(combineVerdicts([V("pass", "ok")])).toEqual(V("pass", "ok"))
  })
})

describe("preflightQuorum", () => {
  const fakeEach = (results: PromiseSettledResult<PreflightVerdict>[]) => async () => results
  it("a thrown/timed-out endpoint counts as skip, the other still decides", async () => {
    const v = await preflightQuorum("AA==", EXP, fakeEach([
      { status: "rejected", reason: new Error("RPC call timeout after 8000ms") },
      { status: "fulfilled", value: V("violation", "drain") },
    ]))
    expect(v.verdict).toBe("violation")
  })
  it("asks for the configured quorum", async () => {
    let asked = 0
    await preflightQuorum("AA==", EXP, async (n) => { asked = n; return [] }, 2)
    expect(asked).toBe(2)
  })
})
