/**
 * Pick the hosting server a new paid project is placed on.
 *
 * The old selection took the first `status: 'active'` row ordered by RAM in
 * use, so a server that had never had Docker installed, or one a health check
 * had marked down, could receive a paying customer's site — and the deploy
 * then failed minutes later with nobody watching. Now a server must be:
 *
 *   - active, with Docker installed,
 *   - not reported down by its last health check,
 *   - below its RAM capacity (when capacity is recorded),
 *
 * and among those the one with the most free RAM (then the fewest projects)
 * wins. When none qualifies the caller gets null and must fail clearly rather
 * than create a project that can never be deployed.
 */
import { db } from '@/lib/db'

export interface SelectedServer {
  id: string
  name: string
  ip: string
}

export async function selectHostingServer(): Promise<SelectedServer | null> {
  const candidates = await db.server.findMany({
    where: {
      status: 'active',
      dockerInstalled: true,
      healthStatus: { not: 'down' },
    },
    select: {
      id: true,
      name: true,
      ip: true,
      ramGB: true,
      usedRamGB: true,
      healthStatus: true,
      createdAt: true,
      _count: { select: { projects: true } },
    },
  })

  const withCapacity = candidates.filter(
    (s) => !s.ramGB || s.ramGB <= 0 || s.usedRamGB < s.ramGB
  )
  withCapacity.sort((a, b) => {
    // A server a health check has confirmed beats one never checked.
    const ha = a.healthStatus === 'healthy' ? 0 : 1
    const hb = b.healthStatus === 'healthy' ? 0 : 1
    if (ha !== hb) return ha - hb
    const freeA = (a.ramGB || 0) - a.usedRamGB
    const freeB = (b.ramGB || 0) - b.usedRamGB
    if (freeA !== freeB) return freeB - freeA
    const pa = a._count?.projects ?? 0
    const pb = b._count?.projects ?? 0
    if (pa !== pb) return pa - pb
    return a.createdAt.getTime() - b.createdAt.getTime()
  })

  const best = withCapacity[0]
  return best ? { id: best.id, name: best.name, ip: best.ip } : null
}

export const NO_SERVER_MESSAGE =
  'No hosting server is available (needs an active server with Docker installed, not marked down, with free capacity)'
