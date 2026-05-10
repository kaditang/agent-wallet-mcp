// SEC EDGAR free, official. Requires a User-Agent header per their fair-access policy.
// https://www.sec.gov/os/accessing-edgar-data

const UA = "agent-wallet-mcp research@example.com"
const TICKER_DB = "https://www.sec.gov/files/company_tickers.json"

let cikCache: Map<string, string> | null = null

async function loadCikMap() {
  if (cikCache) return cikCache
  const r = await fetch(TICKER_DB, { headers: { "User-Agent": UA } })
  const j = (await r.json()) as Record<string, { cik_str: number; ticker: string; title: string }>
  const m = new Map<string, string>()
  for (const v of Object.values(j)) {
    m.set(v.ticker.toUpperCase(), String(v.cik_str).padStart(10, "0"))
  }
  cikCache = m
  return m
}

export type Filing = {
  form: string
  filedAt: string
  accession: string
  primaryDoc: string
  url: string
}

export async function getRecentFilings(ticker: string, forms = ["10-K", "10-Q", "8-K"], limit = 5): Promise<Filing[]> {
  const map = await loadCikMap()
  const cik = map.get(ticker.toUpperCase())
  if (!cik) return []
  const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: { "User-Agent": UA },
  })
  const j = (await r.json()) as any
  const recent = j.filings?.recent
  if (!recent) return []

  const out: Filing[] = []
  const N = recent.form.length
  for (let i = 0; i < N && out.length < limit; i++) {
    const form = recent.form[i] as string
    if (!forms.includes(form)) continue
    const accession = (recent.accessionNumber[i] as string).replace(/-/g, "")
    const primaryDoc = recent.primaryDocument[i] as string
    out.push({
      form,
      filedAt: recent.filingDate[i] as string,
      accession,
      primaryDoc,
      url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${accession}/${primaryDoc}`,
    })
  }
  return out
}
