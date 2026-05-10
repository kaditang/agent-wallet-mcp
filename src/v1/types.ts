// V1 — non-custodial scheduled execution bot for tokenized US stocks + USDC yield.
// "Agent does what you wanted to do but were too lazy to."
//
// All money stays in the user's Squads multisig vault.
// Agent acts within Spending Limit (daily USDC cap) and a per-rule whitelist.

export type Frequency = "daily" | "weekly" | "monthly"

/** A DCA rule: spend $N USDC at frequency F, distributed across allocations. */
export type DcaRule = {
  id: string
  userId: string
  enabled: boolean
  amountUsdc: number // per period
  frequency: Frequency
  /** day-of-week (0-6) for weekly, day-of-month (1-28) for monthly */
  schedule: { dow?: number; dom?: number; hourUtc: number }
  /** Allocation must sum to 1.0. Tickers must exist in xStock registry. */
  allocations: { ticker: string; weight: number }[]
  slippageBps: number // default 50 (0.5%)
  createdAt: number
  /** When the next execution should fire (ms epoch). Recomputed after each run. */
  nextRunAt: number
}

/** A yield rule: keep idle USDC > N parked in a lending pool. */
export type YieldRule = {
  id: string
  userId: string
  enabled: boolean
  pool: "kamino-usdc" // V1 supports one pool only
  /** Move USDC into pool whenever vault USDC exceeds this floor. */
  idleFloorUsdc: number
  /** Reserve this much liquid for upcoming DCA runs. */
  reserveUsdc: number
  createdAt: number
}

/** Execution log — every action the agent takes is recorded for the user. */
export type ExecutionLog = {
  id: string
  userId: string
  ruleId: string
  kind: "dca" | "yield-deposit" | "yield-claim" | "rebalance"
  txSignature?: string
  beforeUsdc?: number
  afterUsdc?: number
  notes: string
  ok: boolean
  errorMessage?: string
  createdAt: number
}

/** What the user signed up for, indexed by userId. */
export type V1UserConfig = {
  userId: string
  /** Display name + email (for weekly summary). */
  email?: string
  language: "zh-Hans" | "zh-Hant" | "en"
  /** Tied to the Squads they granted us. Mirrors users.solana but kept here for V1 use. */
  squads: {
    multisigPda: string
    vaultPda: string
    owner: string
    spendingLimitPda?: string
  }
  rules: {
    dca: DcaRule[]
    yield?: YieldRule
  }
}
