import fs from "node:fs/promises"
import path from "node:path"
import type { Hex } from "viem"

const STORE = path.resolve("data", "users.json")

export type UserRecord = {
  userId: string
  /** EVM smart-account branch (legacy, may be empty if user is Solana-only). */
  accountAddress?: Hex
  approval?: string
  sessionPubkey?: Hex
  /** Solana branch (Squads V4). */
  solana?: {
    owner: string // base58
    multisigPda: string
    vaultPda: string
    spendingLimitPda?: string
    createKey: string
    spendingLimitCreateKey?: string
    txSignature: string // create-multisig tx signature
  }
  createdAt: number
}

async function loadAll(): Promise<Record<string, UserRecord>> {
  try {
    return JSON.parse(await fs.readFile(STORE, "utf8"))
  } catch {
    return {}
  }
}

async function saveAll(data: Record<string, UserRecord>) {
  await fs.mkdir(path.dirname(STORE), { recursive: true })
  await fs.writeFile(STORE, JSON.stringify(data, null, 2))
}

export async function getUser(userId: string): Promise<UserRecord | null> {
  const all = await loadAll()
  return all[userId] ?? null
}

export async function putUser(rec: UserRecord) {
  const all = await loadAll()
  all[rec.userId] = rec
  await saveAll(all)
}

export async function deleteUser(userId: string) {
  const all = await loadAll()
  delete all[userId]
  await saveAll(all)
}
