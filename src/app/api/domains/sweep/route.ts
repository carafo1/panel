import { NextResponse } from 'next/server'
import { sweepPendingDomains } from '@/lib/custom-domains'
import { requireAdminRole } from '@/lib/auth'
import { recordHeartbeat } from '@/lib/health'

/**
 * Continuous DNS verification for pending custom domains.
 *
 * Called on a worker tick. Without it a customer who adds the required DNS
 * record must come back and press "Verify" by hand — and if they never do,
 * the site stays dark despite correct DNS. This closes the loop: the domain
 * connects on its own once it propagates, Caddy issues the certificate on the
 * first request, and the customer is notified.
 */
const CRON_API_KEY =
  process.env.CRON_API_KEY &&
  !/^deployhub-cron-key$|^replace-with/.test(process.env.CRON_API_KEY)
    ? process.env.CRON_API_KEY
    : null

async function authorise(request: Request): Promise<boolean> {
  const key = request.headers.get('x-cron-key')
  if (CRON_API_KEY && key && key === CRON_API_KEY) return true
  return Boolean(await requireAdminRole(request))
}

export async function POST(request: Request) {
  try {
    if (!(await authorise(request))) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 403 })
    }
    const result = await sweepPendingDomains()
    if (result.connected > 0 || result.failed > 0) {
      console.log('[domain-sweep]', JSON.stringify(result))
    }
    await recordHeartbeat(
      'domains',
      `checked=${result.checked} connected=${result.connected}`
    )
    return NextResponse.json({ success: true, ...result })
  } catch (error) {
    console.error('[domain-sweep] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
