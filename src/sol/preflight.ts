// Pre-broadcast WYSIWYS backstop. Before broadcasting a client-signed tx, we
// SIMULATE it and check the wallet's token balance changes match what was
// stashed (the deal the user reviewed): they should receive the expected
// OUTPUT mint in roughly the expected amount, and spend no more than expected
// of the INPUT mint. This makes autoyield's server — not only Phantom — a
// backstop against a tampered/compromised tx that diverges from the stash.
//
// ROLLOUT: now ENFORCING by default (validated on real SPL + Token-2022 txs).
// Set PREFLIGHT_ENFORCE=false to drop back to SHADOW mode — computes the
// verdict and logs it without blocking — if we ever need to debug delta math
// against a suspected false-reject without taking the backstop offline.
//
// The pure verdict logic (evaluateDeltas) is unit-tested; the RPC/sim shell
// (preflightSignedTx) fails OPEN on any ambiguity (can't derive/decode/sim) —
// we never block a legit tx on our own infra hiccup; we only flag a CLEARLY
// divergent one.

import type { Connection, PublicKey as Web3PublicKey } from "@solana/web3.js"

// Token program ids (hardcoded to avoid an @solana/spl-token dep).
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"

export type PreflightExpectation = {
  wallet: string
  inputMint: string
  outputMint: string
  inputDecimals: number
  outputDecimals: number
  /** Human input amount the user agreed to spend. */
  inputAmount: number
  /** Worst-case output the user accepted (minOut). */
  minOut: number
}

export type PreflightVerdict = {
  /** "sim-error": the simulation itself failed — the tx would fail on-chain.
   *  Distinct from "skip" (our infra couldn't verify) so the caller can fail
   *  CLOSED on it under enforce: blocking a tx that can't land loses nothing,
   *  and it stops an attacker exploiting sim/runtime divergence to slip an
   *  unverified tx through the fail-open path. */
  verdict: "pass" | "violation" | "skip" | "sim-error"
  reason: string
  spent?: number
  received?: number
}

// Loose bounds: legit txs (normal slippage + the priority/ATA-rent SOL, which
// isn't a token leg) never trip these; only gross manipulation does.
const MAX_SPEND_MULT = 1.5 // spending >1.5× the agreed input = clearly wrong
const MIN_RECV_FRACTION = 0.5 // receiving <50% of minOut = clearly wrong
// Native-SOL drain bound. Our swaps never have a SOL leg — the wallet's SOL
// only pays priority fee (~0.0005) + ATA rent (~0.002 each, ≤2). 0.05 SOL is
// >10× that ceiling, so legit txs never trip it, but a tampered tx that ALSO
// siphons the wallet's SOL (which the two-mint delta check is blind to) does.
const MAX_SOL_SPEND_LAMPORTS = 50_000_000 // 0.05 SOL

/**
 * PURE: given the simulated token-balance deltas (input spent, output
 * received, both human units) and the expectation, decide pass/violation.
 * `received` is for the EXPECTED output mint specifically.
 */
export function evaluateDeltas(
  spent: number,
  received: number,
  exp: PreflightExpectation,
): PreflightVerdict {
  if (!(received > 0)) {
    return { verdict: "violation", reason: "received none of the expected output mint", spent, received }
  }
  if (received < exp.minOut * MIN_RECV_FRACTION) {
    return {
      verdict: "violation",
      reason: `received ${received} of ${exp.outputMint} — far below the minimum accepted (${exp.minOut})`,
      spent,
      received,
    }
  }
  if (spent > exp.inputAmount * MAX_SPEND_MULT) {
    return {
      verdict: "violation",
      reason: `spent ${spent} — far above the agreed input (${exp.inputAmount})`,
      spent,
      received,
    }
  }
  return { verdict: "pass", reason: "simulated deltas within expected bounds", spent, received }
}

/** SPL / Token-2022 token-account amount = u64 LE at byte offset 64. */
function decodeTokenAmount(base64Data: string | undefined, decimals: number): number | null {
  if (!base64Data) return 0 // account doesn't exist → 0 balance
  try {
    const buf = Buffer.from(base64Data, "base64")
    if (buf.length < 72) return null
    const raw = buf.readBigUInt64LE(64)
    return Number(raw) / 10 ** decimals
  } catch {
    return null
  }
}

/**
 * Simulate the signed tx and produce a WYSIWYS verdict. Fails OPEN ("skip")
 * on any inability to derive/decode/simulate — never blocks on infra error.
 */
export async function preflightSignedTx(
  conn: Connection,
  signedTxBase64: string,
  exp: PreflightExpectation,
): Promise<PreflightVerdict> {
  try {
    const { PublicKey, VersionedTransaction } = await import("@solana/web3.js")
    const owner = new PublicKey(exp.wallet)
    const inputMint = new PublicKey(exp.inputMint)
    const outputMint = new PublicKey(exp.outputMint)

    // Resolve each mint's token program (SPL vs Token-2022) from its owner.
    const mintInfos = await conn.getMultipleAccountsInfo([inputMint, outputMint])
    const programFor = (i: number) => {
      const o = mintInfos[i]?.owner?.toBase58()
      if (o === TOKEN_2022_PROGRAM) return new PublicKey(TOKEN_2022_PROGRAM)
      if (o === TOKEN_PROGRAM) return new PublicKey(TOKEN_PROGRAM)
      return null
    }
    const inProg = programFor(0)
    const outProg = programFor(1)
    if (!inProg || !outProg) return { verdict: "skip", reason: "could not resolve token program for a mint" }

    const ata = (mint: Web3PublicKey, prog: Web3PublicKey) =>
      PublicKey.findProgramAddressSync(
        [owner.toBuffer(), prog.toBuffer(), mint.toBuffer()],
        new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
      )[0]
    const ataIn = ata(inputMint, inProg)
    const ataOut = ata(outputMint, outProg)

    // Pre balances (current on-chain = pre, since the tx isn't broadcast yet).
    // The owner account rides along for the native-SOL drain check.
    const pre = await conn.getMultipleAccountsInfo([ataIn, ataOut, owner])
    const preIn = decodeTokenAmount(pre[0]?.data?.toString("base64"), exp.inputDecimals)
    const preOut = decodeTokenAmount(pre[1]?.data?.toString("base64"), exp.outputDecimals)
    if (preIn == null || preOut == null) return { verdict: "skip", reason: "could not decode pre balances" }
    const preSolLamports = pre[2]?.lamports ?? null

    // Simulate, requesting post-state of the two ATAs + the owner (SOL).
    const vtx = VersionedTransaction.deserialize(Buffer.from(signedTxBase64, "base64"))
    const sim = await conn.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      accounts: {
        encoding: "base64",
        addresses: [ataIn.toBase58(), ataOut.toBase58(), owner.toBase58()],
      },
    })
    if (sim.value.err) {
      // The tx itself fails in simulation — it would fail on-chain too, so
      // there is no legit tx to protect by failing open. Surface as its own
      // verdict so the caller can BLOCK under enforce (clearer UX than a
      // doomed broadcast, and closes the sim/runtime-divergence loophole).
      return { verdict: "sim-error", reason: `simulation error: ${JSON.stringify(sim.value.err).slice(0, 80)}` }
    }
    const accs = sim.value.accounts
    if (!accs || accs.length < 2) return { verdict: "skip", reason: "simulation returned no account state" }
    const postIn = decodeTokenAmount(accs[0]?.data?.[0], exp.inputDecimals)
    const postOut = decodeTokenAmount(accs[1]?.data?.[0], exp.outputDecimals)
    if (postIn == null || postOut == null) return { verdict: "skip", reason: "could not decode post balances" }

    const spent = preIn - postIn
    const received = postOut - preOut
    const verdict = evaluateDeltas(spent, received, exp)
    if (verdict.verdict !== "pass") return verdict

    // Native-SOL drain check (best-effort: skipped silently if either side is
    // unavailable — the token-delta verdict above already passed).
    const postSolLamports = accs[2]?.lamports ?? null
    if (preSolLamports != null && postSolLamports != null) {
      const solSpent = preSolLamports - postSolLamports
      if (solSpent > MAX_SOL_SPEND_LAMPORTS) {
        return {
          verdict: "violation",
          reason: `tx drains ${(solSpent / 1e9).toFixed(4)} SOL — far above the fee/rent ceiling (${MAX_SOL_SPEND_LAMPORTS / 1e9} SOL)`,
          spent,
          received,
        }
      }
    }
    return verdict
  } catch (e) {
    return { verdict: "skip", reason: `preflight error: ${(e as Error).message.slice(0, 80)}` }
  }
}

/** Enforce flag — start in shadow (log-only). Flip via env once validated. */
// Default ON: enforce unless explicitly disabled with PREFLIGHT_ENFORCE=false.
// Shadow mode is now opt-in (the rollout is complete and validated on mainnet).
export const PREFLIGHT_ENFORCE = process.env.PREFLIGHT_ENFORCE !== "false"
