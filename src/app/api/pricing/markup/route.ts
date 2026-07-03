/**
 * GET  /api/pricing/markup       — (admin only) returns the current global markup.
 * POST /api/pricing/markup       — (admin only) updates the global markup.
 *
 * SECURITY: both endpoints are admin-only. The markup value + formula
 * constitute business intelligence (reseller margin) — must not be exposed
 * to customers or anonymous users.
 */
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'
import {
  getGlobalMarkup,
  setGlobalMarkup,
  DEFAULT_MARKUP_USD,
} from '@/lib/pricing'

export async function GET(request: Request) {
  // SECURITY: require admin — was public, leaked reseller margin
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (!isAdmin(user.role)) {
    return apiError.forbidden('Admin access required')
  }
  try {
    const markup = await getGlobalMarkup()
    return ok(
      {
        markup,
        defaultMarkup: DEFAULT_MARKUP_USD,
        currency: 'USD',
        formula: `Selling Price = Wholesale Price + $${markup.toFixed(2)} USD`,
      },
      `Current global markup is $${markup.toFixed(2)} USD`
    )
  } catch (error) {
    console.error('[pricing/markup GET] error:', error)
    return apiError.serverError()
  }
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (!isAdmin(user.role)) {
    return apiError.forbidden('Admin access required')
  }

  try {
    const body = await request.json().catch(() => ({}))
    const raw = body?.markup
    const markup = typeof raw === 'string' ? parseFloat(raw) : raw

    if (typeof markup !== 'number' || !Number.isFinite(markup) || markup < 0) {
      return apiError.badRequest(
        'markup must be a non-negative number (e.g. 8.50)'
      )
    }
    if (markup > 1000) {
      return apiError.badRequest('markup must be less than $1000 USD')
    }

    const previous = await getGlobalMarkup()
    const result = await setGlobalMarkup(markup, user.userId)

    await db.domainLog.create({
      data: {
        userId: user.userId,
        action: 'pricing_markup_update',
        status: 'success',
        message: `Global markup changed from $${previous.toFixed(2)} to $${result.markup.toFixed(2)} (${result.updated} TLDs recalculated)`,
        metadata: JSON.stringify({
          previous,
          next: result.markup,
          updated: result.updated,
        }),
      },
    })

    return ok(
      {
        previousMarkup: previous,
        markup: result.markup,
        updatedTlds: result.updated,
        currency: 'USD',
        formula: `Selling Price = Wholesale Price + $${result.markup.toFixed(2)} USD`,
      },
      `Markup updated to $${result.markup.toFixed(2)} — ${result.updated} TLD prices recalculated`
    )
  } catch (error) {
    console.error('[pricing/markup POST] error:', error)
    return apiError.serverError()
  }
}
