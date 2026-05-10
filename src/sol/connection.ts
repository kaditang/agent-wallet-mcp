import { Connection } from "@solana/web3.js"

// Server-side RPC. Many free RPCs gate getTokenAccountsByOwner. Official
// mainnet-beta works for low volume. Override SOL_RPC env to a Helius/Quicknode
// URL for production.
const RPC = process.env.SOL_RPC ?? "https://api.mainnet-beta.solana.com"

export const solConn = new Connection(RPC, "confirmed")
export const SOL_RPC_URL = RPC
