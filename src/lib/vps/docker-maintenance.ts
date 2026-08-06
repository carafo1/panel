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
  shellQuote,
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

/**
 * Remove containers and images belonging to projects that no longer exist.
 *
 * cleanupDocker above prunes what Docker itself considers garbage: untagged
 * images, containers stopped for a day, old build cache. That misses the two
 * things a deleted project actually leaves behind, because neither looks like
 * garbage to Docker:
 *
 *   - a database container, which is RUNNING, so container prune skips it;
 *   - the project's built image, which is TAGGED, so image prune skips it.
 *
 * Measured on this host: a MariaDB container holding 172 MB was still running
 * two weeks after its project was deleted, alongside 301 MB of images for
 * projects that no longer existed. Nothing in the system would ever have
 * removed them, and with the panel rows gone nothing pointed at them either.
 *
 * Deleting a live database is not something to get wrong, so every condition
 * must hold before anything is touched:
 *
 *   - the name matches the panel's own `deployhub-` prefix;
 *   - no WebsiteDatabase row references it, by host or by externalRef;
 *   - no live project's slug appears in the name;
 *   - it was created more than `minAgeHours` ago, so a deploy in flight — which
 *     creates the container before it writes the row — is never caught.
 *
 * `dryRun` is the default. The caller has to ask for deletion explicitly.
 */
export interface OrphanReapResult {
  ran: boolean
  dryRun: boolean
  containers: Array<{ name: string; sizeHint: string; removed: boolean }>
  images: Array<{ name: string; removed: boolean }>
  detail: string
}

export async function reapOrphanedProjectResources(
  serverId: string,
  opts: { dryRun?: boolean; minAgeHours?: number } = {}
): Promise<OrphanReapResult> {
  const dryRun = opts.dryRun !== false
  const minAgeHours = opts.minAgeHours ?? 24
  const out: OrphanReapResult = {
    ran: false,
    dryRun,
    containers: [],
    images: [],
    detail: '',
  }

  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) return { ...out, detail: 'server not found' }
  if (isServerInDemoMode(server)) return { ...out, detail: 'demo mode' }

  // What the panel still knows about. Slugs guard the app containers and
  // images; the database rows guard the database containers by their real
  // names, which do not always contain the slug.
  const projects = await db.project.findMany({ select: { slug: true } })
  const slugs = projects.map((p) => p.slug).filter(Boolean)
  const dbRows = await db.websiteDatabase.findMany({
    select: { host: true, externalRef: true },
  })
  const referenced = new Set(
    dbRows.flatMap((d) => [d.host, d.externalRef]).filter((x): x is string => !!x)
  )

  /**
   * Exact matching, deliberately.
   *
   * A substring test is wrong in both directions here. `deployhub-db-edmaapsa-
   * 9a262558` contains the live slug `edma`, so `includes` treated a genuinely
   * orphaned 172 MB database as belonging to a live project and skipped it —
   * the very resource this function exists to remove. Loose matching in the
   * other direction is worse: it would delete something live.
   *
   * Containers the panel creates are named `deployhub-<slug>`; databases carry
   * generated names and are recognised only by the row that references them.
   * Images are `<slug>-app`.
   */
  const liveContainerNames = new Set(slugs.map((s) => `deployhub-${s}`))
  const liveImageRepos = new Set(slugs.map((s) => `${s}-app`))
  const containerBelongsToLiveProject = (name: string) =>
    referenced.has(name) || liveContainerNames.has(name)
  const imageBelongsToLiveProject = (repo: string) => liveImageRepos.has(repo)

  try {
    const creds: SshCredentials = await getServerCredentials(serverId)
    return await withConnection(creds, async (client) => {
      const cutoffMs = Date.now() - minAgeHours * 3600_000

      // ── containers ────────────────────────────────────────────────────
      const list = await exec(
        client,
        `docker ps -a --filter name=^deployhub- --format '{{.Names}}' 2>/dev/null`,
        { timeoutMs: 30000 }
      )
      const names = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean)

      // SANITY GUARD — refuse to act on a host this database does not describe.
      //
      // This function decides what to destroy by asking the panel's database
      // what still exists. Point it at the wrong database and everything on the
      // host looks orphaned. That is not hypothetical: the first dry run was
      // executed from the development tree, whose DATABASE_URL is a different
      // SQLite file listing different projects, and it duly proposed deleting
      // the live customer's database container and application image.
      //
      // If the database knows of projects but not one of them has a container
      // here, the two are describing different worlds and nothing should be
      // removed on the strength of it.
      if (slugs.length > 0 && names.length > 0) {
        const intersects = names.some(
          (n) => liveContainerNames.has(n) || referenced.has(n)
        )
        if (!intersects) {
          return {
            ...out,
            ran: false,
            detail:
              `refusing to reap: this database lists ${slugs.length} project(s) ` +
              `(${slugs.slice(0, 3).join(', ')}) and none of them has a container ` +
              `on this host — it is almost certainly not the database this server runs on`,
          }
        }
      }
      for (const name of names) {
        if (containerBelongsToLiveProject(name)) continue
        const info = await exec(
          client,
          `docker inspect ${shellQuote(name)} --format '{{.Created}}' 2>/dev/null`,
          { timeoutMs: 15000 }
        )
        const created = Date.parse(info.stdout.trim())
        if (Number.isFinite(created) && created > cutoffMs) continue // too new

        const sz = await exec(
          client,
          `docker ps -a --filter name=^${shellQuote(name)}$ --format '{{.Size}}' 2>/dev/null`,
          { timeoutMs: 15000 }
        )
        const entry = { name, sizeHint: sz.stdout.trim() || 'unknown', removed: false }
        if (!dryRun) {
          const rm = await exec(
            client,
            `docker rm -f -v ${shellQuote(name)} 2>&1`,
            { timeoutMs: 60000 }
          )
          entry.removed = rm.exitCode === 0
        }
        out.containers.push(entry)
      }

      // ── images ────────────────────────────────────────────────────────
      const imgs = await exec(
        client,
        `docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E -- '-app:' || true`,
        { timeoutMs: 30000 }
      )
      for (const ref of imgs.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
        const repo = ref.split(':')[0]
        if (imageBelongsToLiveProject(repo)) continue
        const entry = { name: ref, removed: false }
        if (!dryRun) {
          const rm = await exec(client, `docker rmi -f ${shellQuote(ref)} 2>&1`, {
            timeoutMs: 60000,
          })
          entry.removed = rm.exitCode === 0
        }
        out.images.push(entry)
      }

      out.ran = true
      out.detail = dryRun
        ? `${out.containers.length} container(s) and ${out.images.length} image(s) orphaned — dry run, nothing removed`
        : `removed ${out.containers.filter((c) => c.removed).length} container(s), ` +
          `${out.images.filter((i) => i.removed).length} image(s)`
      return out
    })
  } catch (err) {
    return { ...out, detail: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Reap orphans on every active server. Driven by the same hourly sweep as
 * cleanupAllServers.
 *
 * A seven-day age floor rather than the one-day default: this removes a
 * customer's database container, and a week is long enough that anything
 * deleted by mistake is noticed while the nightly backups still hold it. The
 * resources it touches have no row in the panel at all, so nothing in the
 * product can reach them either way.
 */
export async function reapOrphansAllServers(): Promise<{
  servers: number
  containers: number
  images: number
  refused: number
}> {
  const servers = await db.server.findMany({
    where: { status: 'active' },
    select: { id: true, name: true },
  })
  let containers = 0
  let images = 0
  let refused = 0
  for (const s of servers) {
    const r = await reapOrphanedProjectResources(s.id, {
      dryRun: false,
      minAgeHours: 168,
    }).catch(() => null)
    if (!r) continue
    if (!r.ran) {
      refused++
      console.warn(`[orphan-reap] ${s.name}: ${r.detail}`)
      continue
    }
    containers += r.containers.filter((c) => c.removed).length
    images += r.images.filter((i) => i.removed).length
    if (r.containers.length || r.images.length) {
      console.warn(`[orphan-reap] ${s.name}: ${r.detail}`)
    }
  }
  return { servers: servers.length, containers, images, refused }
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

/**
 * Restart containers Docker reports as unhealthy.
 *
 * `restart: unless-stopped` only reacts to a process that EXITS. A container
 * that is still running but wedged — a deadlocked PHP-FPM pool, a database
 * refusing connections — stays "Up" indefinitely and serves errors, which is
 * why healthchecks were added to the compose templates. This is the half that
 * acts on them.
 *
 * Deliberately narrow:
 *   - Only containers this platform manages (deployhub-* prefix). Restarting a
 *     Mailcow or panel container from here would fight whatever supervises it.
 *   - One restart per pass. If a container is unhealthy because the app itself
 *     is broken, restarting it every minute turns a broken site into a crash
 *     loop that also burns CPU. Repeated failures are surfaced, not hammered.
 */
export async function restartUnhealthyContainers(
  serverId: string
): Promise<{ checked: number; restarted: string[]; stillUnhealthy: string[] }> {
  const empty = { checked: 0, restarted: [], stillUnhealthy: [] }

  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server || isServerInDemoMode(server)) return empty

  try {
    const creds: SshCredentials = await getServerCredentials(serverId)
    return await withConnection(creds, async (client) => {
      const list = await exec(
        client,
        "docker ps --filter health=unhealthy --filter name=deployhub- --format '{{.Names}}' 2>/dev/null",
        { timeoutMs: 30000 }
      )
      const unhealthy = list.stdout
        .split('\n')
        .map((n) => n.trim())
        .filter(Boolean)

      const restarted: string[] = []
      const stillUnhealthy: string[] = []

      for (const name of unhealthy) {
        // Skip one that was already restarted recently — see the crash-loop
        // note above. Docker records the last start time.
        const started = await exec(
          client,
          `docker inspect --format '{{.State.StartedAt}}' ${name} 2>/dev/null`,
          { timeoutMs: 15000 }
        )
        const startedAt = new Date(started.stdout.trim()).getTime()
        const minutesUp = Number.isFinite(startedAt)
          ? (Date.now() - startedAt) / 60000
          : Infinity

        if (minutesUp < 10) {
          stillUnhealthy.push(name)
          console.warn(
            `[docker-health] ${name} unhealthy ${minutesUp.toFixed(0)}min after a restart — not restarting again`
          )
          continue
        }

        const res = await exec(client, `docker restart ${name} 2>&1`, {
          timeoutMs: 60000,
        })
        if (res.exitCode === 0) {
          restarted.push(name)
          console.warn(`[docker-health] restarted unhealthy container ${name}`)
        } else {
          stillUnhealthy.push(name)
        }
      }

      return { checked: unhealthy.length, restarted, stillUnhealthy }
    })
  } catch (err) {
    console.error('[docker-health] check failed:', err)
    return empty
  }
}

/** Health recovery pass across every active server. */
export async function recoverUnhealthyAllServers(): Promise<{
  restarted: number
  stillUnhealthy: number
}> {
  const servers = await db.server.findMany({
    where: { status: 'active' },
    select: { id: true },
  })
  let restarted = 0
  let stillUnhealthy = 0
  for (const s of servers) {
    const r = await restartUnhealthyContainers(s.id).catch(() => null)
    if (!r) continue
    restarted += r.restarted.length
    stillUnhealthy += r.stillUnhealthy.length
  }
  return { restarted, stillUnhealthy }
}
