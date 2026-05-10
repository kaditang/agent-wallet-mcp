import "dotenv/config"
import type { Hex } from "viem"
import { buildKernelAtGrantTime } from "./kernel.js"

// One-time script. The user runs this (in production: in-browser, signing with their
// own wallet — never feeding their key to the server). It produces:
//   - the Kernel smart-account address
//   - a signed approval that lets the session key act within policy bounds
//
// Both go into the agent's .env. The owner key is then forgotten by the agent.

const ownerPk = process.env.USER_OWNER_PK as Hex | undefined
const sessionPk = process.env.AGENT_SESSION_PK as Hex | undefined

if (!ownerPk || !sessionPk) {
  console.error("Set USER_OWNER_PK and AGENT_SESSION_PK in .env")
  process.exit(1)
}

const client = await buildKernelAtGrantTime(ownerPk, sessionPk)
const address = client.account.address

const approval = await client.account.kernelPluginManager.getPluginEnableSignature(address)

console.log("KERNEL_ACCOUNT_ADDRESS=", address)
console.log("SESSION_APPROVAL=", approval)
console.log("\nCopy these into .env, then drop USER_OWNER_PK from the agent host.")
