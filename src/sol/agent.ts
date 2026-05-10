import { Keypair, PublicKey } from "@solana/web3.js"
import bs58 from "bs58"

const PUB = process.env.SOL_AGENT_PUBKEY
const SECRET = process.env.SOL_AGENT_SECRET

export const SOL_AGENT_PUBKEY: PublicKey | null = PUB ? new PublicKey(PUB) : null

let _kp: Keypair | null = null
export function getAgentKeypair(): Keypair {
  if (_kp) return _kp
  if (!SECRET) throw new Error("SOL_AGENT_SECRET not set")
  _kp = Keypair.fromSecretKey(bs58.decode(SECRET))
  return _kp
}
