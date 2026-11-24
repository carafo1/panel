/**
 * Capacity report for admins: what each server has left, what each customer
 * site costs it, and what is left over (orphans) that nobody pays for.
 *
 * Every measurement is a read-only command on the server. Nothing that could
 * not be measured is reported as 0: it is null, and the UI shows "—".
 *
 * Collection is injectable (CapacityDeps.collect). In a test process without
 * a fake, servers are reported as "not measured" and no command runs.
 */
import { db } from '@/lib/db'
import {
  PROJECTS_ROOT,
  collectOrphanInventory,
  containerReference,
  detectOrphans,
  loadOrphanReferences,
  parseOrphanPs,
  parseStatsMemory,
  type OrphanContainer,
  type OrphanFolder,
  type OrphanInventory,
  type OrphanReferences,
  type OrphanVolume,
} from '@/lib/infra-reconcile'

export const CAPACITY_CACHE_MS = 60_000
/** Amber below this share of RAM available, red below RAM_RED_PCT. */
export const RAM_AVAILABLE_WARN_PCT = 15
export const RAM_AVAILABLE_RED_PCT = 8
/** Amber above this share of disk used, red above DISK_RED_PCT. */
export const DISK_USED_WARN_PCT = 85
export const DISK_USED_RED_PCT = 95

const SITE_PATH_RE = /^\/opt\/deployhub\/[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/

export interface CapacityRaw {
  /** `free -m` */
  free: string
  /** `df -P -B1 /` */
  df: string
  /** `nproc` */
  nproc: string
  orphan: OrphanInventory
  /** One `path<TAB>bytes` line per site path (bytes may be empty). */
  siteDu: string
}

export interface CapacityDeps {
  collect?: (
    serverId: string,
    ctx: { sitePaths: string[]; knownPaths: Set<string> }
  ) => Promise<CapacityRaw>
  now?: Date
}

export type WarningLevel = 'amber' | 'red'

export interface CapacitySite {
  projectId: string
  name: string
  slug: string
  status: string
  deployPath: string | null
  containers: string[]
  containerMemoryBytes: number | null
  diskBytes: number | null
  databaseContainers: string[]
  databaseMemoryBytes: number | null
}

export interface CapacityServer {
  id: string
  name: string
  ip: string
  demo: boolean
  error: string | null
  ram: { totalMB: number; usedMB: number; availableMB: number; availablePct: number } | null
  disk: { totalBytes: number; usedBytes: number; availableBytes: number; usedPct: number } | null
  cpuCount: number | null
  runningContainers: number | null
  warnings: Array<{ level: WarningLevel; kind: 'ram' | 'disk'; message: string }>
  sites: CapacitySite[]
  orphans: {
    containers: OrphanContainer[]
    volumes: OrphanVolume[]
    folders: OrphanFolder[]
    memoryBytes: number
  } | null
}

export interface CapacityReport {
  generatedAt: string
  thresholds: {
    ramAvailableWarnPct: number
    ramAvailableRedPct: number
    diskUsedWarnPct: number
    diskUsedRedPct: number
  }
  servers: CapacityServer[]
}

// ── Parsers ───────────────────────────────────────────────────────────────

export function parseFree(out: string): CapacityServer['ram'] {
  const line = out.split('\n').find((l) => /^Mem:/.test(l.trim()))
  if (!line) return null
  const n = line.trim().split(/\s+/).slice(1).map(Number)
  const totalMB = n[0] ?? NaN
  const usedMB = n[1] ?? NaN
  // `available` is column 6; very old procps lacks it, fall back to free.
  const availableMB = Number.isFinite(n[5]) ? n[5]! : (n[2] ?? NaN)
  if (![totalMB, usedMB, availableMB].every(Number.isFinite) || totalMB <= 0) return null
  return {
    totalMB,
    usedMB,
    availableMB,
    availablePct: Math.round((availableMB / totalMB) * 1000) / 10,
  }
}

export function parseDf(out: string): CapacityServer['disk'] {
  const lines = out.trim().split('\n')
  if (lines.length < 2) return null
  const p = lines[lines.length - 1]!.trim().split(/\s+/)
  const totalBytes = Number(p[1])
  const usedBytes = Number(p[2])
  const availableBytes = Number(p[3])
  if (![totalBytes, usedBytes, availableBytes].every(Number.isFinite) || totalBytes <= 0) return null
  // Same definition as df's own Use%: used / (used + available).
  const usedPct = Math.round((usedBytes / Math.max(1, usedBytes + availableBytes)) * 1000) / 10
  return { totalBytes, usedBytes, availableBytes, usedPct }
}

export function capacityWarnings(
  ram: CapacityServer['ram'],
  disk: CapacityServer['disk']
): CapacityServer['warnings'] {
  const w: CapacityServer['warnings'] = []
  if (ram && ram.availablePct < RAM_AVAILABLE_WARN_PCT) {
    w.push({
      level: ram.availablePct < RAM_AVAILABLE_RED_PCT ? 'red' : 'amber',
      kind: 'ram',
      message: `Only ${ram.availablePct}% of RAM available (${ram.availableMB} MB)`,
    })
  }
  if (disk && disk.usedPct > DISK_USED_WARN_PCT) {
    w.push({
      level: disk.usedPct > DISK_USED_RED_PCT ? 'red' : 'amber',
      kind: 'disk',
      message: `Disk ${disk.usedPct}% used`,
    })
  }
  return w
}

// ── Collection ────────────────────────────────────────────────────────────

async function realCollect(
  serverId: string,
  ctx: { sitePaths: string[]; knownPaths: Set<string> }
): Promise<CapacityRaw> {
  const { getServerCredentials } = await import('@/lib/vps/provisioner')
  const { withConnection, exec, shellQuote } = await import('@/lib/vps/ssh')
  const creds = await getServerCredentials(serverId)
  return withConnection(creds, async (client) => {
    const [free, df, nproc] = await Promise.all([
      exec(client, 'free -m', { timeoutMs: 10000 }),
      exec(client, 'df -P -B1 /', { timeoutMs: 10000 }),
      exec(client, 'nproc', { timeoutMs: 10000 }),
    ])
    // Docker stats walks every container; run it alone, then du.
    const orphan = await collectOrphanInventory(client, ctx.knownPaths)
    const paths = ctx.sitePaths.filter((p) => SITE_PATH_RE.test(p) && !p.includes('..'))
    let siteDu = ''
    if (paths.length) {
      const r = await exec(
        client,
        `for p in ${paths.map(shellQuote).join(' ')}; do [ -d "$p" ] && printf '%s\\t%s\\n' "$p" "$(timeout 20 du -sb -- "$p" 2>/dev/null | cut -f1)"; done; true`,
        { timeoutMs: 180000 }
      )
      siteDu = r.stdout
    }
    return { free: free.stdout, df: df.stdout, nproc: nproc.stdout, orphan, siteDu }
  })
}

type SiteRow = {
  id: string
  name: string
  slug: string
  status: string
  serverId: string | null
  containerName: string | null
  containerId: string | null
  deployPath: string | null
  websiteDatabases: Array<{ host: string; externalRef: string | null }>
}

const sitePath = (p: SiteRow) => (p.deployPath || `${PROJECTS_ROOT}/${p.slug}`).replace(/\/+$/, '')

/** References of ONE project, to attribute containers to it. */
function siteRefs(p: SiteRow): OrphanReferences {
  const names = [p.containerName, `deployhub-${p.slug}`].filter((n): n is string => !!n)
  const path = sitePath(p)
  const compose = (path.split('/').pop() ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '')
  return {
    names: new Set(names),
    namePrefixes: names.flatMap((n) => [`${n}-`, `${n}_`]),
    ids: p.containerId && p.containerId.length >= 12 ? [p.containerId] : [],
    composeProjects: new Set(compose ? [compose] : []),
    paths: new Set([path]),
  }
}

function measureServer(
  serverId: string,
  raw: CapacityRaw,
  sites: SiteRow[],
  refs: OrphanReferences
): Omit<CapacityServer, 'id' | 'name' | 'ip' | 'demo' | 'error'> {
  const ram = parseFree(raw.free)
  const disk = parseDf(raw.df)
  const cpu = parseInt(raw.nproc.trim(), 10)
  const containers = parseOrphanPs(raw.orphan.containers)
  const mem = parseStatsMemory(raw.orphan.stats)
  const du = new Map<string, number>()
  for (const line of raw.siteDu.split('\n')) {
    const [path = '', bytes = ''] = line.replace(/\r$/, '').split('\t')
    const n = parseInt(bytes.trim(), 10)
    if (path.trim() && Number.isFinite(n)) du.set(path.trim().replace(/\/+$/, ''), n)
  }
  const sumMem = (names: string[]) => {
    const known = names.filter((n) => mem.has(n))
    return known.length ? known.reduce((s, n) => s + mem.get(n)!, 0) : null
  }

  const outSites: CapacitySite[] = sites.map((p) => {
    const dbNames = [...new Set(p.websiteDatabases.flatMap((d) => [d.host, d.externalRef]))].filter(
      (n): n is string => !!n && containers.some((c) => c.name === n)
    )
    const own = siteRefs(p)
    const appNames = containers
      .filter((c) => !dbNames.includes(c.name) && containerReference(c, own) !== null)
      .map((c) => c.name)
    return {
      projectId: p.id,
      name: p.name,
      slug: p.slug,
      status: p.status,
      deployPath: p.deployPath,
      containers: appNames,
      containerMemoryBytes: sumMem(appNames),
      diskBytes: du.get(sitePath(p)) ?? null,
      databaseContainers: dbNames,
      databaseMemoryBytes: sumMem(dbNames),
    }
  })
  const found = detectOrphans(serverId, raw.orphan, refs)
  return {
    ram,
    disk,
    cpuCount: Number.isFinite(cpu) && cpu > 0 ? cpu : null,
    runningContainers: containers.filter((c) => c.state === 'running').length,
    warnings: capacityWarnings(ram, disk),
    sites: outSites,
    orphans: {
      ...found,
      memoryBytes: found.containers.reduce((s, c) => s + (c.memoryBytes ?? 0), 0),
    },
  }
}

export async function buildCapacityReport(deps: CapacityDeps = {}): Promise<CapacityReport> {
  const now = deps.now ?? new Date()
  const { isServerInDemoMode } = await import('@/lib/vps/ssh')
  const [servers, projects, refs] = await Promise.all([
    db.server.findMany({
      select: { id: true, name: true, ip: true, sshHost: true, sshPrivateKey: true, sshPassword: true },
      orderBy: { createdAt: 'asc' },
    }),
    db.project.findMany({
      where: { serverId: { not: null } },
      select: {
        id: true, name: true, slug: true, status: true, serverId: true,
        containerName: true, containerId: true, deployPath: true,
        websiteDatabases: { select: { host: true, externalRef: true } },
      },
      orderBy: { name: 'asc' },
    }),
    loadOrphanReferences(),
  ])
  const testRun = process.env.NODE_ENV === 'test' && !deps.collect
  const collect = deps.collect ?? realCollect

  const out = await Promise.all(
    servers.map(async (s): Promise<CapacityServer> => {
      const base = {
        id: s.id,
        name: s.name,
        ip: s.ip,
        demo: false,
        error: null as string | null,
        ram: null,
        disk: null,
        cpuCount: null,
        runningContainers: null,
        warnings: [],
        sites: [] as CapacitySite[],
        orphans: null,
      }
      const sites = projects.filter((p) => p.serverId === s.id)
      if (!deps.collect && isServerInDemoMode(s)) return { ...base, demo: true }
      if (testRun) return { ...base, error: 'not measured in a test run' }
      try {
        const raw = await collect(s.id, { sitePaths: sites.map(sitePath), knownPaths: refs.paths })
        return { ...base, ...measureServer(s.id, raw, sites, refs) }
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 200)
        console.error('[admin/capacity] server', s.id, 'failed:', message)
        return { ...base, error: message }
      }
    })
  )
  return {
    generatedAt: now.toISOString(),
    thresholds: {
      ramAvailableWarnPct: RAM_AVAILABLE_WARN_PCT,
      ramAvailableRedPct: RAM_AVAILABLE_RED_PCT,
      diskUsedWarnPct: DISK_USED_WARN_PCT,
      diskUsedRedPct: DISK_USED_RED_PCT,
    },
    servers: out,
  }
}

// ── 60 s cache, with concurrent requests sharing one collection ───────────

let cached: { at: number; report: CapacityReport } | null = null
let inflight: Promise<CapacityReport> | null = null

export async function getCapacityReport(opts: { refresh?: boolean } = {}): Promise<{
  report: CapacityReport
  cached: boolean
}> {
  if (!opts.refresh && cached && Date.now() - cached.at < CAPACITY_CACHE_MS) {
    return { report: cached.report, cached: true }
  }
  if (!inflight) {
    inflight = buildCapacityReport()
      .then((report) => {
        cached = { at: Date.now(), report }
        return report
      })
      .finally(() => {
        inflight = null
      })
  }
  return { report: await inflight, cached: false }
}

export function invalidateCapacityCache(): void {
  cached = null
}
