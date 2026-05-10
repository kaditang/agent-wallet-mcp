import type { Hex } from "viem"
import { simulateBundle } from "./tenderly.js"
import { checkAddressRisk } from "./goplus.js"
import { blockaidScan } from "./blockaid.js"
import { isSanctioned } from "./ofac.js"
import { decodeCall, type DecodedCall } from "./decode.js"

export type Severity = "info" | "warn" | "block"
export type Verdict = "pass" | "warn" | "block"

export type Reason = {
  severity: Severity
  source: "tenderly" | "goplus" | "blockaid" | "ofac" | "decode"
  message: string
}

export type PreflightResult = {
  verdict: Verdict
  reasons: Reason[]
  decodedCalls: DecodedCall[]
  details: {
    simulations: unknown
    addressRisk: unknown
    blockaid: unknown
  }
}

export type CallInput = { to: Hex; data: Hex; value?: bigint }

// Single source of truth for risk decisions. Both the public paid endpoint
// and our internal propose_* tools call this so they stay in sync.
export async function runPreflight(opts: {
  from: Hex
  calls: CallInput[]
  chainId: number
}): Promise<PreflightResult> {
  const reasons: Reason[] = []
  const decodedCalls = opts.calls.map(decodeCall)

  // 1. Decode-level flags
  for (const dc of decodedCalls) {
    for (const f of dc.flags) {
      reasons.push({ severity: f.severity, source: "decode", message: `${dc.function ?? dc.selector}: ${f.message}` })
    }
  }

  // 2. OFAC sanctions on every `to` and any decoded recipient args
  for (const c of opts.calls) {
    if (isSanctioned(c.to)) {
      reasons.push({
        severity: "block",
        source: "ofac",
        message: `target ${c.to} is on the sanctions list`,
      })
    }
  }
  for (const dc of decodedCalls) {
    if (Array.isArray(dc.args)) {
      for (const arg of dc.args) {
        if (typeof arg === "string" && /^0x[a-fA-F0-9]{40}$/.test(arg) && isSanctioned(arg as Hex)) {
          reasons.push({
            severity: "block",
            source: "ofac",
            message: `decoded recipient ${arg} is on the sanctions list`,
          })
        }
      }
    }
  }

  // 3. Run paid/external probes in parallel
  const [sims, goplusOnTargets, blockaids] = await Promise.all([
    simulateBundle({ from: opts.from, calls: opts.calls, chainId: opts.chainId }),
    Promise.all(opts.calls.map((c) => checkAddressRisk(opts.chainId, c.to))),
    Promise.all(
      opts.calls.map((c) =>
        blockaidScan({ from: opts.from, to: c.to, data: c.data, value: c.value, chainId: opts.chainId }),
      ),
    ),
  ])

  // 4. Tenderly: revert is a hard block
  for (let i = 0; i < sims.length; i++) {
    const s = sims[i]
    if (!s.skipped && !s.success) {
      reasons.push({
        severity: "block",
        source: "tenderly",
        message: `call[${i}] simulation reverted${s.errorMessage ? `: ${s.errorMessage}` : ""}`,
      })
    }
  }

  // 5. GoPlus on targets
  goplusOnTargets.forEach((g, i) => {
    if (!g.ok && g.hits.length > 0) {
      reasons.push({
        severity: "block",
        source: "goplus",
        message: `target[${i}] flagged: ${g.hits.join(", ")}`,
      })
    }
  })

  // 6. Blockaid
  blockaids.forEach((b, i) => {
    if (b.skipped) return
    if (b.severity === "block") {
      reasons.push({ severity: "block", source: "blockaid", message: `call[${i}]: ${b.reason ?? "malicious"}` })
    } else if (b.severity === "warn") {
      reasons.push({ severity: "warn", source: "blockaid", message: `call[${i}]: ${b.reason ?? "warning"}` })
    }
  })

  // Verdict: any block → block; else any warn → warn; else pass.
  const hasBlock = reasons.some((r) => r.severity === "block")
  const hasWarn = reasons.some((r) => r.severity === "warn")
  const verdict: Verdict = hasBlock ? "block" : hasWarn ? "warn" : "pass"

  return {
    verdict,
    reasons,
    decodedCalls,
    details: { simulations: sims, addressRisk: goplusOnTargets, blockaid: blockaids },
  }
}
