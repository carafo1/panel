/**
 * /api/admin/domain-pricing
 *
 *   GET — the current markups and discount, plus a worked example so the
 *         effect of a change is visible before it is saved.
 *   PUT — update any subset of them.
 *
 * Domain pricing was a single global markup applied identically to
 * registration, renewal and transfer. That forces the same margin on the first
 * year, where resellers usually compete on price, and on renewals, where the
 * margin actually is.
 */
import { NextResponse } from 'next/server'
import { requireAdminRole, authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import {
  getDomainPricingSettings,
  setDomainPricingSettings,
  sellingPrices,
  getAllPrices,
} from '@/lib/pricing'

async function getHandler(request: Request) {
  if (!(await requireAdminRole(request))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const settings = await getDomainPricingSettings()

  // A few real TLDs priced with the current settings. Abstract percentages are
  // hard to sanity-check; "so .com sells at $16.49" is not.
  const all = await getAllPrices()
  const wanted = ['.com', '.net', '.org', '.io', '.ai']
  const examples = wanted
    .map((tld) => all.find((p) => p.tld === tld))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map((p) => ({
      tld: p.tld,
      wholesale: p.wholesale,
      ...sellingPrices(p.wholesale, settings),
    }))

  return NextResponse.json({
    settings,
    examples,
    // So the UI can say what an unset field will fall back to.
    fallbackMarkup: settings.globalMarkup,
  })
}

async function putHandler(request: Request) {
  if (!(await requireAdminRole(request))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
  }

  // Only fields actually present are touched — a form that submits three of
  // four must not reset the fourth to zero.
  const update: Record<string, number> = {}
  for (const k of [
    'registerMarkup',
    'renewMarkup',
    'transferMarkup',
    'discountPercent',
    'registerDiscount',
    'renewDiscount',
    'transferDiscount',
  ]) {
    const v = body[k]
    if (v === undefined || v === null || v === '') continue
    const n = typeof v === 'number' ? v : parseFloat(String(v))
    if (!Number.isFinite(n)) {
      return NextResponse.json({ error: `${k} must be a number.` }, { status: 400 })
    }
    update[k] = n
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })
  }

  const user = await authenticateRequest(request)
  const result = await setDomainPricingSettings(update, user?.userId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  await logAudit({
    userId: user?.userId || 'system',
    action: 'admin.domain_pricing.updated',
    resource: 'pricing',
    resourceId: 'domain',
    req: request,
    metadata: update,
  }).catch(() => {})

  return NextResponse.json({
    ok: true,
    settings: result.settings,
    message: 'Domain pricing updated. It applies to new quotes immediately.',
  })
}

export const GET = getHandler
export const PUT = withRateLimit(putHandler, { limit: 20, windowMs: 60_000 })
