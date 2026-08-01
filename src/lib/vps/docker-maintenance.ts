/**
 * Docker housekeeping.
 *
 * Nothing on this platform ever reclaimed Docker space. Measured on the live
 * host: 34 images (10 GB, 1.5 GB reclaimable), 42 volumes (3.6 GB, of which
 * 2.6 GB — 70% — orphaned), 297 MB of build cache and 5 stopped containers.
 * Every deploy adds another layer set and, when a project is torn down, another
 * orphaned volume.
 *
 * Deliberately conservative about what counts as garbage:
 *
 *   - Dangling images only (untagged leftovers of a rebuild). NOT `image prune
 *     -a`, which would delete any tagged image with no running container and so
 *     force a full re-pull of e.g. wordpress:php8.2-apache the next time
 *     someone provisions — slow, and it fails outright if the registry is
 *     unreachable.
 *   - Build cache older than a week, so an active redeploy still gets its cache.
 *   - Stopped containers older than a day, so a container that just exited can
 *     still be inspected for the reason.
 *   - Volumes are NOT pruned automatically. An orphaned volume is
 *     indistinguishable from one belonging to a stopped customer database, and
 *     deleting the wrong one destroys customer data with no way back. They are
 *     reported for a human to confirm.
 */
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  isServerInDemoMode,
  type SshCredentials,
} from './ssh'
import { getServerCredentials } from './provisioner'

export interface DockerCleanupResult {
  ran: boolean
  reclaimedBytes: number
  danglingImages: number
  stoppedContainers: number
  buildCacheBytes: number
  /** Orphaned volumes found — reported, never auto-deleted. */
  orphanVolumes: number
  detail: string
}

/** "1.514GB" / "297.5MB" / "0B" → bytes. */
function parseDockerSize(raw: string): number {
  const m = raw.trim().match(/^([\d.]+)\s*([KMGT]?B)$/i)
  if (!m) return 0
  const n = parseFloat(m[1])
  const unit = m[2].toUpperCase()
  const mult: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  }
  return Math.round(n * (mult[unit] ?? 1))
}

async function reclaimable(client: unknown): Promise<number> {
  const df = await exec(
    client as never,
    "docker system df --format '{{.Type}}|{{.Reclaimable}}' 2>/dev/null",
    { timeoutMs: 30000 }
  )
  let total = 0
  for (const line of df.stdout.split('\n')) {
    const parts = line.split('|')
    if (parts.length < 2) continue
    // Reclaimable reads like "1.514GB (15%)" — take the size, drop the percent.
    total += parseDockerSize(parts[1].replace(/\s*\(.*\)\s*$/, ''))
  }
  return total
}

/**
 * Reclaim safe Docker garbage on one server. Returns what was actually freed,
 * measured before and after rather than estimated.
 */
export async function cleanupDocker(
  serverId: string
): Promise<DockerCleanupResult> {
  const empty: DockerCleanupResult = {
    ran: false,
    reclaimedBytes: 0,
    danglingImages: 0,
    stoppedContainers: 0,
    buildCacheBytes: 0,
    orphanVolumes: 0,
    detail: '',
  }

  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) return { ...empty, detail: 'server not found' }
  if (isServerInDemoMode(server)) return { ...empty, detail: 'demo mode' }

  try {
    const creds: SshCredentials = await getServerCredentials(serverId)
    return await withConnection(creds, async (client) => {
      const before = await reclaimable(client)

      // Untagged leftovers from rebuilds.
      const img = await exec(
        client,
        'docker image prune -f 2>&1 | tail -2',
        { timeoutMs: 120000 }
      )
      const danglingImages = (img.stdout.match(/deleted:/gi) || []).length

      // Containers that exited more than a day ago.
      const cont = await exec(
        client,
        "docker container prune -f --filter 'until=24h' 2>&1 | tail -2",
        { timeoutMs: 60000 }
      )
      const stoppedContainers = (cont.stdout.match(/^[a-f0-9]{12,}/gim) || []).length

      // Build cache older than a week.
      const cache = await exec(
        client,
        "docker builder prune -f --filter 'until=168h' 2>&1 | tail -1",
        { timeoutMs: 120000 }
      )
      const cacheFreed = parseDockerSize(
        (cache.stdout.match(/Total reclaimed space:\s*(.+)$/im) || [])[1] || '0B'
      )

      // Orphaned volumes: counted and reported, never deleted here.
      const vols = await exec(
        client,
        'docker volume ls -qf dangling=true 2>/dev/null | wc -l',
        { timeoutMs: 30000 }
      )
      const orphanVolumes = parseInt(vols.stdout.trim(), 10) || 0

      const after = await reclaimable(client)
      const reclaimedBytes = Math.max(0, before - after)

      return {
        ran: true,
        reclaimedBytes,
        danglingImages,
        stoppedContainers,
        buildCacheBytes: cacheFreed,
        orphanVolumes,
        detail:
          `freed ${(reclaimedBytes / 1024 ** 2).toFixed(0)}MB` +
          (orphanVolumes > 0
            ? ` — ${orphanVolumes} orphaned volume(s) left for manual review`
            : ''),
      }
    })
  } catch (err) {
    return {
      ...empty,
      detail: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Run the cleanup across every active server. Driven by the hourly sweep. */
export async function cleanupAllServers(): Promise<{
  servers: number
  reclaimedBytes: number
  orphanVolumes: number
}> {
  const servers = await db.server.findMany({
    where: { status: 'active' },
    select: { id: true },
  })

  let reclaimedBytes = 0
  let orphanVolumes = 0
  for (const s of servers) {
    const res = await cleanupDocker(s.id).catch(() => null)
    if (!res) continue
    reclaimedBytes += res.reclaimedBytes
    orphanVolumes += res.orphanVolumes
  }
  return { servers: servers.length, reclaimedBytes, orphanVolumes }
}
