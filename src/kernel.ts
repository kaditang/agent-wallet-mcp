import { createPublicClient, http, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
  createKernelAccount,
  createKernelAccountClient,
  createZeroDevPaymasterClient,
} from "@zerodev/sdk"
import { getEntryPoint, KERNEL_V3_1 } from "@zerodev/sdk/constants"
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator"
import {
  toPermissionValidator,
  deserializePermissionAccount,
} from "@zerodev/permissions"
import { toECDSASigner } from "@zerodev/permissions/signers"
import {
  chain,
  transport,
  bundlerUrl,
  paymasterUrl,
} from "./config.js"
import { sessionPolicies } from "./policies.js"

export const entryPoint = getEntryPoint("0.7")
export const kernelVersion = KERNEL_V3_1

export const publicClient = createPublicClient({ chain, transport })

export async function buildOwnerValidator(ownerPk: Hex) {
  return signerToEcdsaValidator(publicClient, {
    signer: privateKeyToAccount(ownerPk),
    entryPoint,
    kernelVersion,
  })
}

export async function buildSessionValidator(sessionPk: Hex) {
  const signer = await toECDSASigner({ signer: privateKeyToAccount(sessionPk) })
  return toPermissionValidator(publicClient, {
    entryPoint,
    kernelVersion,
    signer,
    policies: sessionPolicies,
  })
}

export function paymaster() {
  if (!paymasterUrl) return undefined
  return createZeroDevPaymasterClient({ chain, transport: http(paymasterUrl) })
}

// At grant time the user is online: owner + session both present, owner signs the
// permission-enable. We export the resulting Kernel address and an "approval" blob
// that the agent uses later WITHOUT the owner key.
export async function buildKernelAtGrantTime(ownerPk: Hex, sessionPk: Hex) {
  const sudo = await buildOwnerValidator(ownerPk)
  const regular = await buildSessionValidator(sessionPk)

  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion,
    plugins: { sudo, regular },
  })

  return createKernelAccountClient({
    account,
    chain,
    bundlerTransport: http(bundlerUrl),
    paymaster: paymaster(),
  })
}

// Runtime: agent only has its own session key + the previously stored approval
// blob (base64 from serializePermissionAccount). The owner key is not on this server.
export async function buildKernelAsAgent(opts: {
  sessionPk: Hex
  accountAddress: Hex
  approval: string
}) {
  const sessionSigner = await toECDSASigner({
    signer: privateKeyToAccount(opts.sessionPk),
  })

  const account = await deserializePermissionAccount(
    publicClient,
    entryPoint,
    kernelVersion,
    opts.approval,
    sessionSigner,
  )

  return createKernelAccountClient({
    account,
    chain,
    bundlerTransport: http(bundlerUrl),
    paymaster: paymaster(),
  })
}
