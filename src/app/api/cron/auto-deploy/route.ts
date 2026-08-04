import { NextResponse } from 'next/server'
import { autoDeploySweep } from '@/lib/auto-deploy'
import { reapStaleDeployments } from '@/lib/deploy-guard'
import { requireAdminRole } from '@/lib/auth'

// Same posture as the other sweeps: the cron-key path is disabled entirely
// unless CRON_API_KEY is set to something that is not a placeholder.
const CRON_API_KEY =
  process.env.CRON_API_KEY &&
  !/^deployhub-cron-key$|^replace-with/.test(process.env.CRON_API_KEY)
    ? process.env.CRON_API_KEY
    : null

async function authorise(request: Request): Promise<boolean> {
  const cronKey = request.headers.get('x-cron-key')
  if (CRON_API_KEY && cronKey && cronKey === CRON_API_KEY) return true
  return Boolean(await requireAdminRole(request))
}

/**
 * POST /api/cron/auto-deploy
 *
 * Ask every auto-deploy project's git remote whether its branch has moved, and
 * redeploy the ones that have. Driven by cron; also reaps deployments whose
 * process died, so a panel restart mid-build cannot leave a project stuck.
 */
export async function POST(request: Request) {
  if (!(await authorise(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const reaped = await reapStaleDeployments()
    const result = await autoDeploySweep({
      onLog: (m) => console.log(m),
    })
    return NextResponse.json({
      ok: true,
      reapedStale: reaped,
      ...result,
      at: new Date().toISOString(),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[auto-deploy] sweep failed:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
