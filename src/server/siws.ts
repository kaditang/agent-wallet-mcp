// Sign-In-with-Solana (SIWS) text, parsing, and the check behind Phantom's native signIn().
//
// With signMessage() the page hands the wallet our exact bytes and the wallet just shows them.
// With signIn() the page hands the wallet the FIELDS (domain, statement, nonce, …); the wallet
// builds the SIWS text itself and — the point of using it — compares `domain` with the site
// actually asking, warning the user on a lookalike. The wallet returns the bytes it signed, so the
// server cannot assume they equal the message it stored: it parses them and requires every field
// to match what it issued for that nonce (timestamps compared as instants, since a wallet may
// re-format them), and the address to be the signing wallet. Anything extra is refused.

export type SignInInput = {
  domain: string
  address?: string
  statement: string
  uri: string
  version: string
  chainId: string
  nonce: string
  issuedAt: string
  expirationTime: string
  requestId?: string
}

const FIELD_ORDER: [keyof SignInInput, string][] = [
  ["uri", "URI"],
  ["version", "Version"],
  ["chainId", "Chain ID"],
  ["nonce", "Nonce"],
  ["issuedAt", "Issued At"],
  ["expirationTime", "Expiration Time"],
  ["requestId", "Request ID"],
]
const KNOWN = new Set(["URI", "Version", "Chain ID", "Nonce", "Issued At", "Expiration Time", "Not Before", "Request ID", "Resources"])
const TIME_FIELDS = new Set(["Issued At", "Expiration Time", "Not Before"])
const HEADER = / wants you to sign in with your Solana account:$/

/** The SIWS text (Solana wallet-standard layout); without an address the address line is omitted. */
export function siwsText(i: SignInInput): string {
  let s = `${i.domain} wants you to sign in with your Solana account:`
  if (i.address) s += `\n${i.address}`
  s += `\n\n${i.statement}`
  const fields = FIELD_ORDER.filter(([k]) => i[k]).map(([k, label]) => `${label}: ${i[k]}`)
  return `${s}\n\n${fields.join("\n")}`
}

type Parsed = { domain: string; address?: string; statement?: string; fields: Map<string, string> }

export function parseSiws(text: string): Parsed | null {
  const lines = text.split("\n")
  const head = lines[0] ?? ""
  if (!HEADER.test(head)) return null
  const domain = head.replace(HEADER, "")
  if (!domain || /\s/.test(domain)) return null
  let i = 1
  let address: string | undefined
  if (lines[i] !== undefined && lines[i] !== "") address = lines[i++]
  let statement: string | undefined
  const isField = (l: string | undefined) => !!l && KNOWN.has(l.split(":")[0])
  if (lines[i] === "" && lines[i + 1] !== undefined && !isField(lines[i + 1])) {
    statement = lines[i + 1]
    i += 2
  }
  const fields = new Map<string, string>()
  if (i < lines.length) {
    if (lines[i] !== "") return null
    i++
  }
  for (; i < lines.length; i++) {
    const l = lines[i]
    const m = /^([A-Za-z ]+): (.*)$/.exec(l)
    if (!m || !KNOWN.has(m[1]) || fields.has(m[1])) return null
    fields.set(m[1], m[2])
  }
  return { domain, address, statement, fields }
}

/**
 * Do the wallet-signed SIWS bytes say exactly what we issued (`stored`), for `pubkey`?
 * We never issue Not Before or Resources, so their presence is a mismatch.
 */
export function siwsMatches(stored: string, signed: string, pubkey: string): boolean {
  const a = parseSiws(stored)
  const b = parseSiws(signed)
  if (!a || !b) return false
  if (b.address !== pubkey || (a.address !== undefined && a.address !== pubkey)) return false
  if (a.domain !== b.domain || a.statement !== b.statement) return false
  if (a.fields.size !== b.fields.size) return false
  for (const [k, v] of a.fields) {
    const w = b.fields.get(k)
    if (w === undefined) return false
    if (TIME_FIELDS.has(k)) {
      const x = Date.parse(v)
      if (Number.isNaN(x) || x !== Date.parse(w)) return false
    } else if (v !== w) return false
  }
  return true
}

/**
 * The bytes the signature must verify over: the stored message (signMessage path), or — when the
 * client sent what the wallet signed via signIn — those bytes, if they match the stored message.
 * null = the signed message does not describe this challenge.
 */
export function bytesToVerify(stored: string, pubkey: string, signedMessageBase64: unknown): Uint8Array | null {
  if (signedMessageBase64 === undefined || signedMessageBase64 === null) return new TextEncoder().encode(stored)
  if (typeof signedMessageBase64 !== "string" || signedMessageBase64.length > 4096) return null
  const bytes = new Uint8Array(Buffer.from(signedMessageBase64, "base64"))
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  return siwsMatches(stored, text, pubkey) ? bytes : null
}
