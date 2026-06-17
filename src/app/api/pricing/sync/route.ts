/**
 * POST /api/pricing/sync
 * Admin-only. Re-syncs wholesale prices from Dynadot and reapplies the $6.50 markup.
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { ok, apiError } from '@/lib/api-response'
import { syncPrices } from '@/lib/pricing'

export async function POST(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (user.role !== 'admin' && user.role !== 'super_admin') return apiError.forbidden(`Admin access required`)

  try {
    const result = await syncPrices(user.userId)

    await db.domainLog.create({
      data: {
        userId: user.userId,
        action: 'pricing_sync',
        status: 'success',
        message: `Synced ${result.synced} TLD prices`,
        metadata: JSON.stringify({ synced: result.synced, demo: result.demo }),
      },
    })

    return ok(
      {
        synced: result.synced,
        demoMode: result.demo,
        markup: 6.5,
        message: result.demo
          ? 'Prices re-seeded from defaults (demo mode - set DYNADOT_API_KEY for live sync)'
          : 'Prices synced from Dynadot wholesale list',
      },
      `Price sync completed (${result.synced} TLDs)`
    )
  } catch (error) {
    console.error('[pricing/sync] error:', error)
    return apiError.serverError()
  }
}
