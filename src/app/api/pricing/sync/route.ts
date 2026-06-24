/**
 * POST /api/pricing/sync
 * Admin-only. Re-syncs wholesale prices from Dynadot and reapplies the $6.50 markup.
 *
 * REAL MODE (DYNADOT_API_KEY set): performs live bulk searches against Dynadot
 * across all 100+ TLDs and stores the real wholesale prices.
 *
 * DEMO MODE: re-seeds from the hardcoded defaults.
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
        message: `Synced ${result.synced} TLD prices (${result.fetched} live, ${result.fallback} default)`,
        metadata: JSON.stringify({
          synced: result.synced,
          demo: result.demo,
          fetched: result.fetched,
          fallback: result.fallback,
        }),
      },
    })

    return ok(
      {
        synced: result.synced,
        demoMode: result.demo,
        fetchedLive: result.fetched,
        fallback: result.fallback,
        markup: 6.5,
        message: result.demo
          ? 'Prices re-seeded from defaults (demo mode - set DYNADOT_API_KEY for live sync)'
          : `Prices synced live from Dynadot (${result.fetched} live, ${result.fallback} default fallback)`,
      },
      `Price sync completed (${result.synced} TLDs — ${result.fetched} live from Dynadot)`
    )
  } catch (error) {
    console.error('[pricing/sync] error:', error)
    return apiError.serverError()
  }
}
