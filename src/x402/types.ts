// Minimal x402 shape — just enough to demo. Real Coinbase x402 has more
// fields (validity windows, signature schemes, multi-asset, facilitator URL).
export type PaymentRequirements = {
  scheme: "exact"
  network: "base-sepolia"
  asset: `0x${string}`
  payTo: `0x${string}`
  amountUsdc: string
  resource: string
  description?: string
}

export type PaymentChallenge = {
  error: "payment_required"
  paymentRequirements: PaymentRequirements
}
