import {
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js"
import * as multisig from "@sqds/multisig"

export const SQUADS_PROGRAM_ID = multisig.PROGRAM_ID

/**
 * Derive the multisig PDA from a createKey. The createKey is any 32-byte
 * pubkey the user picks (we suggest generating a fresh one per multisig).
 */
export function getMultisigPda(createKey: PublicKey): PublicKey {
  const [pda] = multisig.getMultisigPda({ createKey })
  return pda
}

/** Vault PDA — the address that actually holds tokens. Index 0 is the default vault. */
export function getVaultPda(multisigPda: PublicKey, vaultIndex = 0): PublicKey {
  const [pda] = multisig.getVaultPda({ multisigPda, index: vaultIndex })
  return pda
}

/** Spending Limit PDA — keyed by createKey nested inside the multisig. */
export function getSpendingLimitPda(
  multisigPda: PublicKey,
  spendingLimitCreateKey: PublicKey,
): PublicKey {
  const [pda] = multisig.getSpendingLimitPda({
    multisigPda,
    createKey: spendingLimitCreateKey,
  })
  return pda
}

export const Permission = multisig.types.Permission
export const Permissions = multisig.types.Permissions
export const Period = multisig.types.Period

export type GrantPlan = {
  /** New createKey for the multisig (random) */
  createKey: PublicKey
  /** The owner who will fund and retain control */
  owner: PublicKey
  /** Agent server public key — gets full execute power, gated by off-chain policy + on-chain Spending Limit */
  agent: PublicKey
}

/**
 * Build the instruction list a wallet (user) needs to sign in one tx to:
 *   1. Create a multisig with [user, agent], threshold=1
 *   2. (Optional) Add a Spending Limit for the agent capping USDC outflow
 *
 * The user is the rentPayer + creator. We expose the multisig + vault PDAs
 * so the agent server can store them after the user signs.
 */
export function buildCreateMultisigIxs(opts: {
  plan: GrantPlan
  /** Optional spending limit. If omitted, only the multisig is created. */
  spendingLimit?: {
    createKey: PublicKey
    mint: PublicKey
    amount: bigint
    period: number // Period.Day | Period.Week | Period.OneTime
    destinations: PublicKey[]
  }
  treasury: PublicKey
}): { multisigPda: PublicKey; vaultPda: PublicKey; ixs: TransactionInstruction[] } {
  const multisigPda = getMultisigPda(opts.plan.createKey)
  const vaultPda = getVaultPda(multisigPda)

  const ixs: TransactionInstruction[] = []

  ixs.push(
    multisig.instructions.multisigCreateV2({
      createKey: opts.plan.createKey,
      creator: opts.plan.owner,
      multisigPda,
      configAuthority: null,
      threshold: 1,
      members: [
        {
          key: opts.plan.owner,
          permissions: Permissions.all(),
        },
        {
          key: opts.plan.agent,
          // Agent: full Initiate+Vote+Execute. Hard policy enforcement is
          // off-chain (backend) + the optional Spending Limit below.
          permissions: Permissions.all(),
        },
      ],
      timeLock: 0,
      rentCollector: null,
      memo: "agent-wallet-mcp",
      treasury: opts.treasury,
    }),
  )

  if (opts.spendingLimit) {
    const spendingLimitPda = getSpendingLimitPda(
      multisigPda,
      opts.spendingLimit.createKey,
    )
    ixs.push(
      multisig.instructions.multisigAddSpendingLimit({
        multisigPda,
        configAuthority: opts.plan.owner,
        spendingLimit: spendingLimitPda,
        rentPayer: opts.plan.owner,
        createKey: opts.spendingLimit.createKey,
        vaultIndex: 0,
        mint: opts.spendingLimit.mint,
        amount: opts.spendingLimit.amount,
        period: opts.spendingLimit.period,
        members: [opts.plan.agent],
        destinations: opts.spendingLimit.destinations,
        memo: "agent micropayment lane",
      } as any),
    )
  }

  return { multisigPda, vaultPda, ixs }
}

/** Quick utility: derive the Solana program-config PDA (constant per cluster). */
export function getProgramConfigPda(): PublicKey {
  const [pda] = multisig.getProgramConfigPda({})
  return pda
}

/** Generate a fresh createKey for a new multisig or spending limit. */
export function freshCreateKey(): PublicKey {
  return Keypair.generate().publicKey
}
