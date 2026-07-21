/**
 * Tax calculation.
 *
 * Rates are resolved most-specific-first: an exact country+region match beats
 * a country match, which beats the global default. Compound rates are charged
 * on (base + taxes already applied), which is how e.g. Québec QST stacks on GST.
 */
import { db } from '@/lib/db'

export interface TaxLine {
  name: string
  rate: number
  amount: number
}

export interface TaxResult {
  total: number
  lines: TaxLine[]
  /** Human-readable summary for the invoice, e.g. "VAT 20%". */
  label: string | null
  exempt: boolean
}

function round2(n: number) {
  return Math.round(n * 100) / 100
}

/**
 * Work out the tax on a taxable base for a customer.
 * `base` should already have any discount subtracted.
 */
export async function calculateTax(opts: {
  base: number
  userId?: string | null
  country?: string | null
  region?: string | null
}): Promise<TaxResult> {
  const empty: TaxResult = { total: 0, lines: [], label: null, exempt: false }
  if (!opts.base || opts.base <= 0) return empty

  let country = opts.country ?? null
  if (opts.userId) {
    const user = await db.user.findUnique({
      where: { id: opts.userId },
      select: { taxExempt: true, taxCountry: true },
    })
    if (user?.taxExempt) {
      return { ...empty, exempt: true }
    }
    if (!country && user?.taxCountry) country = user.taxCountry
  }

  const rates = await db.taxRate.findMany({
    where: { active: true },
    orderBy: [{ priority: 'asc' }],
  })
  if (rates.length === 0) return empty

  // Most specific match wins: country+region → country → global default.
  const norm = (s: string | null | undefined) =>
    (s || '').trim().toUpperCase() || null
  const c = norm(country)
  const r = norm(opts.region)

  let applicable = rates.filter(
    (t) => norm(t.country) === c && c !== null && norm(t.region) === r && r !== null
  )
  if (applicable.length === 0) {
    applicable = rates.filter((t) => norm(t.country) === c && c !== null && !t.region)
  }
  if (applicable.length === 0) {
    applicable = rates.filter((t) => !t.country)
  }
  if (applicable.length === 0) return empty

  const lines: TaxLine[] = []
  let running = opts.base
  let total = 0
  for (const t of applicable) {
    const chargeBase = t.compound ? running : opts.base
    const amount = round2((chargeBase * t.rate) / 100)
    if (amount <= 0) continue
    lines.push({ name: t.name, rate: t.rate, amount })
    total = round2(total + amount)
    running = round2(running + amount)
  }

  return {
    total,
    lines,
    label: lines.length
      ? lines.map((l) => `${l.name} ${l.rate}%`).join(' + ')
      : null,
    exempt: false,
  }
}
