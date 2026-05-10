import type { Request, Response, NextFunction } from "express"
import type { Hex } from "viem"
import { verifyPaymentTx } from "./verify.js"
import { USDC } from "../config.js"

export function x402(opts: {
  amountUsdc: string
  payTo: Hex
  description?: string
}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const proof = req.header("x-payment-tx") as Hex | undefined
    if (!proof) {
      res.status(402).json({
        error: "payment_required",
        paymentRequirements: {
          scheme: "exact",
          network: "base-sepolia",
          asset: USDC,
          payTo: opts.payTo,
          amountUsdc: opts.amountUsdc,
          resource: req.originalUrl,
          description: opts.description,
        },
      })
      return
    }
    const v = await verifyPaymentTx({
      txHash: proof,
      expectedTo: opts.payTo,
      expectedAmountUsdc: opts.amountUsdc,
    })
    if (!v.ok) {
      res.status(402).json({ error: "payment_invalid", reason: v.reason })
      return
    }
    next()
  }
}
