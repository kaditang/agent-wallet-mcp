import { describe, expect, it } from "vitest"
import {
  effectiveMultiplier,
  parseScaledUiCfg,
  rawToShares,
  sharesToRaw,
} from "../../sol/share-multiplier.js"

// Real on-chain values read 2026-09-10 (SPYx mint XsoCS1Tf…).
const SPYX_INFO = {
  decimals: 8,
  extensions: [
    { extension: "transferHook", state: {} },
    {
      extension: "scaledUiAmountConfig",
      state: {
        authority: "x",
        multiplier: "1.003909",
        newMultiplier: "1.005714560286254",
        newMultiplierEffectiveTimestamp: 1781755200, // 2026-06-18
      },
    },
  ],
}

describe("parseScaledUiCfg", () => {
  it("reads multiplier / newMultiplier / effective timestamp", () => {
    expect(parseScaledUiCfg(SPYX_INFO)).toEqual({
      multiplier: 1.003909,
      newMultiplier: 1.005714560286254,
      effectiveTs: 1781755200,
    })
  })

  it("returns null when the mint has no scaled-UI extension (plain SPL / non-dividend)", () => {
    expect(parseScaledUiCfg({ decimals: 6 })).toBeNull()
    expect(parseScaledUiCfg({ extensions: [{ extension: "transferHook", state: {} }] })).toBeNull()
  })

  const ext = (m: string) => ({ extensions: [{ extension: "scaledUiAmountConfig", state: { multiplier: m, newMultiplier: m } }] })

  it("an unusable value is INVALID — never collapsed into 'no extension = 1.0'", () => {
    for (const m of ["0", "1e30", "NaN", "-1"]) expect(parseScaledUiCfg(ext(m))).toBe("invalid")
    // extension present but state missing → also invalid, not "none"
    expect(parseScaledUiCfg({ extensions: [{ extension: "scaledUiAmountConfig" }] })).toBe("invalid")
  })

  it("accepts real corporate actions: a 10:1 split and a 1:10 reverse split", () => {
    // xStocks apply splits through this same multiplier. The first version of
    // this parser used a (0.5, 2) band and would have reported a split as 1.0.
    expect(parseScaledUiCfg(ext("10.0571"))).toMatchObject({ multiplier: 10.0571 })
    expect(parseScaledUiCfg(ext("0.1005"))).toMatchObject({ multiplier: 0.1005 })
  })
})

describe("effectiveMultiplier", () => {
  const cfg = { multiplier: 1.003909, newMultiplier: 1.005714560286254, effectiveTs: 1781755200 }
  it("uses the OLD multiplier before the switch-over", () => {
    expect(effectiveMultiplier(cfg, 1781755199)).toBe(1.003909)
  })
  it("uses the NEW multiplier at and after the switch-over", () => {
    expect(effectiveMultiplier(cfg, 1781755200)).toBe(1.005714560286254)
    expect(effectiveMultiplier(cfg, 1789079417)).toBe(1.005714560286254)
  })
  it("no scheduled change (ts 0) → the current multiplier", () => {
    expect(effectiveMultiplier({ multiplier: 1, newMultiplier: 1, effectiveTs: 0 }, 1789079417)).toBe(1)
  })
})

describe("share ↔ raw conversion (the bug this module fixes)", () => {
  const m = 1.005714560286254
  it("selling the displayed SHARE balance maps back to exactly the RAW balance", () => {
    // Measured wallet: raw 1168.41646506, displayed (uiAmountString) 1175.09345138.
    const raw = 1168.41646506
    const shown = 1175.09345138
    expect(sharesToRaw(shown, m)).toBeCloseTo(raw, 6)
    // The old code sold `shown` raw tokens — 0.57% more than the wallet holds.
    expect(shown / raw - 1).toBeGreaterThan(0.005)
  })
  it("round-trips", () => {
    expect(rawToShares(sharesToRaw(12.345, m), m)).toBeCloseTo(12.345, 12)
  })
  it("a per-raw-token price overstates the per-share price by the multiplier", () => {
    const perShare = 758.15
    const perRaw = perShare * m // what Jupiter's raw outAmount implies
    expect((perRaw / perShare - 1) * 10000).toBeCloseTo(57.1, 1) // bps — the false "premium"
  })
})
