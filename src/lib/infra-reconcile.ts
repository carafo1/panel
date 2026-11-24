/**
 * Infrastructure reconciliation: does the real world still match the database?
 *
 * Three hourly checks, run from runReconcile (src/lib/reconcile.ts):
 *
 *   - containers:  every 'running' project must have its container on its
 *                  server, and that container must be running. REPORT ONLY —
 *                  a failed `docker ps` must never flip a customer's site.
 *   - certificates: every running project with SSL on gets a verified TLS
 *                  handshake. The result is written ('issued' with the real
 *                  expiry, or 'pending'), so the panel never keeps showing a
 *                  certificate that is no longer served. Expiring-soon and
 *                  not-served certificates are reported.
 *   - registrar:   active Dynadot domains are read back (domain_info, read
 *                  only, a rotating batch per run). A different expiry is
 *                  corrected from the registrar (the registrar is the source
 *                  of truth for expiry); expired or unreadable domains are
 *                  reported, never changed.
 *   - orphans:     deployhub-* containers, dangling volumes and project folders
 *                  that no database row accounts for. REPORT ONLY — removal is
 *                  a manual admin action on one container (removeOrphanContainer).
 *
 * The last result is stored in AppSetting 'reconcile.infra.last' so the admin
 * report can show it without reaching every server again.
 *
 * Every external call is injectable; tests never touch Docker, Caddy or Dynadot.
 */
import { db } from '@/lib/db'
import { getDomainInfo, isDynadotDemoMode } from '@/lib/dynadot'

const DAY = 24 * 60 * 60 * 1000
export const CERT_EXPIRY_WARNING_DAYS = 14
const REGISTRAR_BATCH = 25
const PROJECT_BATCH = 200
export const INFRA_REPORT_KEY = 'reconcile.infra.last'

// ── Dependencies (real implementations below) ─────────────────────────────

export interface ContainerRow {
  id: string
  name: string
  state: string // docker State: running, exited, restarting, ...
}

export interface InfraDeps {
  /** All containers on a server (`docker ps -a`). Throws when Docker cannot be read. */
  listContainers?: (serverId: string) => Promise<ContainerRow[]>
  /**
   * Verified TLS probe for each hostname on a server; writes the project's
   * sslCertStatus / sslCertExpiry. Returns per-project results.
   */
  probeCertificates?: (
    serverId: string,
    projects: Array<{ id: string; hostname: string }>
  ) => Promise<Array<{ projectId: string; ok: boolean; notAfter?: Date }>>
  /** Registrar read-back (domain_info). */
  getDomainInfo?: (domain: string) => Promise<{ status: string; expiry?: string }>
  /**
   * Raw orphan inventory of a server (docker ps / stats / dangling volumes /
   * project folders). The orphan check never runs in a test process without
   * this fake, even with `force`.
   */
  readOrphanInventory?: (serverId: string, ctx: { knownPaths: Set<string> }) => Promise<OrphanInventory>
  /** Run even in a test process (only with injected fakes). */
  force?: boolean
  now?: Date
  /** Start of the registrar batch (default: rotates by hour). For tests. */
  registrarSkip?: number
}

// ── Result shapes ─────────────────────────────────────────────────────────

export interface ContainerCheck {
  skipped?: string
  checked: number
  missing: Array<{ projectId: string; name: string; serverId: string; container: string | null }>
  notRunning: Array<{ projectId: string; name: string; container: string; state: string }>
  serverErrors: Array<{ serverId: string; error: string }>
}

export interface CertificateCheck {
  skipped?: string
  checked: number
  issued: number
  notServed: Array<{ projectId: string; hostname: string; previous: string }>
  expiringSoon: Array<{ projectId: string; hostname: string; expiresAt: string; days: number }>
  serverErrors: Array<{ serverId: string; error: string }>
}

export interface RegistrarCheck {
  skipped?: string
  checked: number
  expiryCorrected: Array<{ domain: string; from: string | null; to: string }>
  expiredAtRegistrar: Array<{ domain: string; expiresAt: string }>
  lookupFailed: Array<{ domain: string; error: string }>
}

export interface OrphanContainer {
  serverId: string
  id: string
  name: string
  state: string
  createdAt: string | null
  /** Resident memory from `docker stats`; null when stopped or unmeasured. */
  memoryBytes: number | null
  /** Named/anonymous volumes mounted by the container. */
  volumes: string[]
}

export interface OrphanVolume {
  serverId: string
  name: string
  sizeBytes: number | null
}

export interface OrphanFolder {
  serverId: string
  path: string
  sizeBytes: number | null
}

export interface OrphanCheck {
  skipped?: string
  serversChecked: number
  containers: OrphanContainer[]
  volumes: OrphanVolume[]
  folders: OrphanFolder[]
  /** Sum of memoryBytes over orphan containers that report it. */
  orphanMemoryBytes: number
  serverErrors: Array<{ serverId: string; error: string }>
}

export interface InfraReconcileSummary {
  ranAt: string
  containers: ContainerCheck
  certificates: CertificateCheck
  registrar: RegistrarCheck
  /** Absent in summaries stored before the orphan check existed. */
  orphans?: OrphanCheck
}

function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300)
}

function inTestProcess(deps: InfraDeps): boolean {
  return process.env.NODE_ENV === 'test' && !deps.force
}

/** Servers whose projects can be checked for real (never simulated ones). */
async function realServers(serverIds: string[]): Promise<Set<string>> {
  if (serverIds.length === 0) return new Set()
  const { isServerInDemoMode } = await import('@/lib/vps/ssh')
  const servers = await db.server.findMany({
    where: { id: { in: serverIds } },
    select: { id: true, sshHost: true, sshPrivateKey: true, sshPassword: true },
  })
  return new Set(servers.filter((s) => !isServerInDemoMode(s)).map((s) => s.id))
}

// ── Real implementations ──────────────────────────────────────────────────

async function realListContainers(serverId: string): Promise<ContainerRow[]> {
  const { getServerCredentials } = await import('@/lib/vps/provisioner')
  const { withConnection, exec } = await import('@/lib/vps/ssh')
  const creds = await getServerCredentials(serverId)
  return withConnection(creds, async (client) => {
    const r = await exec(
      client,
      `docker ps -a --no-trunc --format '{{.ID}}\t{{.Names}}\t{{.State}}'`,
      { timeoutMs: 20000 }
    )
    if (r.exitCode !== 0) throw new Error(`docker ps failed: ${r.stderr.trim().slice(0, 200)}`)
    return r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [id = '', name = '', state = ''] = l.split('\t')
        return { id, name, state }
      })
  })
}

async function realProbeCertificates(
  serverId: string,
  projects: Array<{ id: string; hostname: string }>
): Promise<Array<{ projectId: string; ok: boolean; notAfter?: Date }>> {
  const { getServerCredentials } = await import('@/lib/vps/provisioner')
  const { withConnection } = await import('@/lib/vps/ssh')
  const { recordCertificateStatus } = await import('@/lib/vps/ssl')
  const creds = await getServerCredentials(serverId)
  return withConnection(creds, async (client) => {
    const out: Array<{ projectId: string; ok: boolean; notAfter?: Date }> = []
    for (const p of projects) {
      // One attempt: this is a periodic check, not a wait for issuance.
      const cert = await recordCertificateStatus(client, p.id, p.hostname, { attempts: 1 })
      out.push({ projectId: p.id, ok: cert.ok, notAfter: cert.notAfter })
    }
    return out
  })
}

// ── Containers ────────────────────────────────────────────────────────────

/** A container matches by exact name, by id (either may be the short form), or as a compose service of that name. */
export function findContainer(
  rows: ContainerRow[],
  containerName: string | null,
  containerId: string | null
): ContainerRow | null {
  if (containerName) {
    const exact = rows.find((r) => r.name === containerName)
    if (exact) return exact
  }
  if (containerId && containerId.length >= 12) {
    const byId = rows.find((r) => r.id.startsWith(containerId) || containerId.startsWith(r.id))
    if (byId) return byId
  }
  if (containerName) {
    const compose = rows.filter((r) => r.name.startsWith(`${containerName}-`) || r.name.startsWith(`${containerName}_`))
    if (compose.length) return compose.find((r) => r.state === 'running') ?? compose[0]
  }
  return null
}

export async function checkContainers(deps: InfraDeps = {}): Promise<ContainerCheck> {
  if (inTestProcess(deps)) {
    return { skipped: 'test run', checked: 0, missing: [], notRunning: [], serverErrors: [] }
  }
  const list = deps.listContainers ?? realListContainers
  const projects = await db.project.findMany({
    where: { status: 'running', serverId: { not: null } },
    select: { id: true, name: true, serverId: true, containerId: true, containerName: true },
    take: PROJECT_BATCH,
  })
  const real = deps.listContainers ? null : await realServers([...new Set(projects.map((p) => p.serverId!))])
  const byServer = new Map<string, typeof projects>()
  for (const p of projects) {
    if (real && !real.has(p.serverId!)) continue
    byServer.set(p.serverId!, [...(byServer.get(p.serverId!) ?? []), p])
  }

  const result: ContainerCheck = { checked: 0, missing: [], notRunning: [], serverErrors: [] }
  for (const [serverId, group] of byServer) {
    let rows: ContainerRow[]
    try {
      rows = await list(serverId)
    } catch (err) {
      // Docker unreadable: say so, conclude nothing about the projects.
      result.serverErrors.push({ serverId, error: errText(err) })
      continue
    }
    for (const p of group) {
      result.checked++
      const c = findContainer(rows, p.containerName, p.containerId)
      if (!c) {
        result.missing.push({
          projectId: p.id,
          name: p.name,
          serverId,
          container: p.containerName ?? p.containerId ?? null,
        })
      } else if (c.state !== 'running') {
        result.notRunning.push({ projectId: p.id, name: p.name, container: c.name, state: c.state })
      }
    }
  }
  return result
}

// ── Certificates ──────────────────────────────────────────────────────────

export async function checkCertificates(deps: InfraDeps = {}): Promise<CertificateCheck> {
  if (inTestProcess(deps)) {
    return { skipped: 'test run', checked: 0, issued: 0, notServed: [], expiringSoon: [], serverErrors: [] }
  }
  const now = deps.now ?? new Date()
  const probe = deps.probeCertificates ?? realProbeCertificates
  const projects = await db.project.findMany({
    where: { status: 'running', sslEnabled: true, serverId: { not: null } },
    select: { id: true, serverId: true, customDomain: true, subdomain: true, sslCertStatus: true },
    take: PROJECT_BATCH,
  })
  const real = deps.probeCertificates ? null : await realServers([...new Set(projects.map((p) => p.serverId!))])
  const byServer = new Map<string, typeof projects>()
  for (const p of projects) {
    if (real && !real.has(p.serverId!)) continue
    byServer.set(p.serverId!, [...(byServer.get(p.serverId!) ?? []), p])
  }

  const result: CertificateCheck = { checked: 0, issued: 0, notServed: [], expiringSoon: [], serverErrors: [] }
  for (const [serverId, group] of byServer) {
    const hosts = group.map((p) => ({ id: p.id, hostname: p.customDomain || p.subdomain }))
    let probes: Awaited<ReturnType<NonNullable<InfraDeps['probeCertificates']>>>
    try {
      probes = await probe(serverId, hosts)
    } catch (err) {
      result.serverErrors.push({ serverId, error: errText(err) })
      continue
    }
    for (const r of probes) {
      const p = group.find((x) => x.id === r.projectId)
      if (!p) continue
      const hostname = p.customDomain || p.subdomain
      result.checked++
      if (!r.ok) {
        result.notServed.push({ projectId: p.id, hostname, previous: p.sslCertStatus })
        continue
      }
      result.issued++
      if (r.notAfter) {
        const days = Math.floor((r.notAfter.getTime() - now.getTime()) / DAY)
        if (days < CERT_EXPIRY_WARNING_DAYS) {
          // Caddy renews ~30 days before expiry; this close means renewal is failing.
          result.expiringSoon.push({ projectId: p.id, hostname, expiresAt: r.notAfter.toISOString(), days })
        }
      }
    }
  }
  return result
}

// ── Registrar drift ───────────────────────────────────────────────────────

export async function checkRegistrar(deps: InfraDeps = {}): Promise<RegistrarCheck> {
  const empty = { checked: 0, expiryCorrected: [], expiredAtRegistrar: [], lookupFailed: [] }
  if (!deps.getDomainInfo && (isDynadotDemoMode() || process.env.NODE_ENV === 'test')) {
    return { skipped: 'registrar lookups disabled (no registrar key, or a test run)', ...empty }
  }
  const now = deps.now ?? new Date()
  const getInfo = deps.getDomainInfo ?? getDomainInfo
  const where = { provider: 'dynadot', status: 'active' }
  const total = await db.domain.count({ where })
  if (total === 0) return { ...empty }
  // Rotate through all active domains, one batch per hourly run.
  const hourIndex = Math.floor(now.getTime() / (60 * 60 * 1000))
  const skip =
    deps.registrarSkip ?? (total <= REGISTRAR_BATCH ? 0 : (hourIndex * REGISTRAR_BATCH) % total)
  const domains = await db.domain.findMany({
    where,
    select: { id: true, name: true, userId: true, expiresAt: true },
    orderBy: { name: 'asc' },
    skip,
    take: REGISTRAR_BATCH,
  })

  const result: RegistrarCheck = { checked: 0, expiryCorrected: [], expiredAtRegistrar: [], lookupFailed: [] }
  for (const d of domains) {
    result.checked++
    let expiry: Date | null = null
    try {
      const info = await getInfo(d.name)
      expiry = info.expiry ? new Date(info.expiry) : null
      if (expiry && Number.isNaN(expiry.getTime())) expiry = null
    } catch (err) {
      // Not in our registrar account, or the API failed: we cannot tell which,
      // so report it and change nothing.
      result.lookupFailed.push({ domain: d.name, error: errText(err) })
      continue
    }
    if (!expiry) {
      result.lookupFailed.push({ domain: d.name, error: 'registrar returned no expiry' })
      continue
    }
    if (expiry.getTime() <= now.getTime()) {
      result.expiredAtRegistrar.push({ domain: d.name, expiresAt: expiry.toISOString() })
    }
    const local = d.expiresAt?.getTime() ?? null
    if (local === null || Math.abs(local - expiry.getTime()) > DAY) {
      await db.domain.update({ where: { id: d.id }, data: { expiresAt: expiry } })
      await db.domainLog
        .create({
          data: {
            domainId: d.id,
            userId: d.userId,
            action: 'reconcile_expiry',
            status: 'success',
            message: `Expiry corrected from the registrar: ${d.expiresAt?.toISOString() ?? 'none'} -> ${expiry.toISOString()}`,
          },
        })
        .catch(() => {})
      result.expiryCorrected.push({
        domain: d.name,
        from: d.expiresAt?.toISOString() ?? null,
        to: expiry.toISOString(),
      })
    }
  }
  return result
}

// ── Orphaned resources ────────────────────────────────────────────────────
//
// REPORT ONLY. Lists, per real server, what Docker / the filesystem holds that
// no database row accounts for:
//
//   - containers named deployhub-* that no Project (containerName, containerId,
//     compose label, or the deployer's derived name) and no WebsiteDatabase
//     (host / externalRef) refers to;
//   - dangling volumes (attached to no container), Mailcow's excluded;
//   - folders under /opt/deployhub/projects that no project's deploy path is.
//
// Matching is deliberately generous: anything that MIGHT belong to a project
// counts as referenced. A false "orphan" invites someone to delete a
// customer's database; a missed orphan only costs some RAM until noticed.
// Removal is a separate, manual, single-container action
// (removeOrphanContainer below).

export const PROJECTS_ROOT = '/opt/deployhub/projects'
const ORPHAN_PREFIX = 'deployhub-'
/** Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]+. Ours must also carry the prefix. */
export const ORPHAN_CONTAINER_NAME_RE = /^deployhub-[A-Za-z0-9][A-Za-z0-9_.-]{0,200}$/
/** Docker volume names (named or 64-hex anonymous). */
export const VOLUME_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/
const PROJECT_DIR_RE = /^\/opt\/deployhub\/projects\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
const MAILCOW_VOLUME_RE = /^mailcowdockerized_/
/** A container younger than this may belong to a deploy still writing its row. */
export const ORPHAN_MIN_AGE_MS = 30 * 60 * 1000

/** Raw command output for one server. Parsed by detectOrphans. */
export interface OrphanInventory {
  /** `docker ps -a --no-trunc` with ORPHAN_PS_FORMAT. Required. */
  containers: string
  /** `docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'`; may be ''. */
  stats: string
  /** Dangling volumes, one per line: `name<TAB>bytes` (bytes may be empty). */
  danglingVolumes: string
  /** Project folders, one per line: `path<TAB>bytes` (bytes may be empty). */
  projectDirs: string
}

export const ORPHAN_PS_FORMAT =
  `{{.ID}}\t{{.Names}}\t{{.State}}\t{{.CreatedAt}}\t{{.Label "com.docker.compose.project"}}\t{{.Mounts}}`

export interface OrphanReferences {
  names: Set<string>
  namePrefixes: string[]
  ids: string[]
  composeProjects: Set<string>
  paths: Set<string>
}

export interface ParsedContainer {
  id: string
  name: string
  state: string
  createdAt: string | null
  composeProject: string
  volumes: string[]
}

const trimSlash = (p: string) => p.replace(/\/+$/, '')

/** Same derivation as composeProjectName in vps/deploy-safety.ts (kept local: no SSH import here). */
function composeProjectOf(deployPath: string): string {
  const base = trimSlash(deployPath).split('/').pop() ?? ''
  return base.toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^[_-]+/, '')
}

/** Everything in the database that can own a container or a folder. */
export async function loadOrphanReferences(): Promise<OrphanReferences> {
  const [projects, databases] = await Promise.all([
    // Every project, whatever its status: a stopped site still owns its container.
    db.project.findMany({
      select: { slug: true, containerName: true, containerId: true, deployPath: true },
    }),
    db.websiteDatabase.findMany({ select: { host: true, externalRef: true } }),
  ])
  const refs: OrphanReferences = {
    names: new Set(),
    namePrefixes: [],
    ids: [],
    composeProjects: new Set(),
    paths: new Set(),
  }
  const addName = (n: string | null | undefined) => {
    if (!n) return
    refs.names.add(n)
    refs.namePrefixes.push(`${n}-`, `${n}_`)
  }
  for (const p of projects) {
    addName(p.containerName)
    // The deployer falls back to this name before containerName is persisted.
    addName(`${ORPHAN_PREFIX}${p.slug}`)
    if (p.containerId && p.containerId.length >= 12) refs.ids.push(p.containerId)
    const defaultPath = `${PROJECTS_ROOT}/${p.slug}`
    refs.paths.add(defaultPath)
    refs.composeProjects.add(composeProjectOf(defaultPath))
    if (p.deployPath) {
      refs.paths.add(trimSlash(p.deployPath))
      refs.composeProjects.add(composeProjectOf(p.deployPath))
    }
  }
  for (const d of databases) {
    if (d.host) refs.names.add(d.host)
    if (d.externalRef) refs.names.add(d.externalRef)
  }
  refs.composeProjects.delete('')
  return refs
}

/** Why a container is referenced, or null when nothing refers to it. */
export function containerReference(
  c: { id?: string; name: string; composeProject?: string },
  refs: OrphanReferences
): string | null {
  if (refs.names.has(c.name)) return 'name'
  if (refs.namePrefixes.some((p) => c.name.startsWith(p))) return 'compose service name'
  if (c.id && c.id.length >= 12 && refs.ids.some((id) => c.id!.startsWith(id) || id.startsWith(c.id!))) {
    return 'container id'
  }
  if (c.composeProject && refs.composeProjects.has(c.composeProject)) return 'compose project'
  return null
}

/** "2026-11-24 10:00:00 +0000 UTC" → ISO string, or null. */
export function parseDockerCreatedAt(raw: string): string | null {
  const m = raw.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-])(\d{2})(\d{2})/)
  if (!m) return null
  const d = new Date(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** "123.4MiB / 3.82GiB" (or "12.5MB") → bytes of the first figure, or null. */
export function parseMemUsage(raw: string): number | null {
  const m = raw.trim().match(/^([\d.]+)\s*([KMGT]?i?B)/i)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return null
  const unit = m[2].toLowerCase()
  const pow: Record<string, number> = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4 }
  const base = unit.includes('i') ? 1024 : 1000
  return Math.round(n * base ** (pow[unit] ?? 0))
}

export function parseOrphanPs(out: string): ParsedContainer[] {
  return out
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim())
    .map((l) => {
      const [id = '', name = '', state = '', created = '', compose = '', mounts = ''] = l.split('\t')
      return {
        id: id.trim(),
        // `docker ps` can list several names; the first is the container's own.
        name: name.trim().split(',')[0] ?? '',
        state: state.trim(),
        createdAt: parseDockerCreatedAt(created),
        composeProject: compose.trim(),
        volumes: mounts
          .split(',')
          .map((v) => v.trim())
          .filter((v) => VOLUME_NAME_RE.test(v)),
      }
    })
}

/** `name<TAB>memusage` lines → name → bytes. */
export function parseStatsMemory(out: string): Map<string, number> {
  const mem = new Map<string, number>()
  for (const line of out.split('\n')) {
    const [name = '', usage = ''] = line.replace(/\r$/, '').split('\t')
    const bytes = parseMemUsage(usage)
    if (name.trim() && bytes !== null) mem.set(name.trim(), bytes)
  }
  return mem
}

function parseSizedLines(out: string): Array<{ key: string; bytes: number | null }> {
  return out
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim())
    .map((l) => {
      const [key = '', bytes = ''] = l.split('\t')
      const n = parseInt(bytes.trim(), 10)
      return { key: key.trim(), bytes: Number.isFinite(n) ? n : null }
    })
}

/** Pure detection over one server's raw inventory. */
export function detectOrphans(
  serverId: string,
  inv: OrphanInventory,
  refs: OrphanReferences
): Pick<OrphanCheck, 'containers' | 'volumes' | 'folders'> {
  const mem = parseStatsMemory(inv.stats)
  const containers: OrphanContainer[] = parseOrphanPs(inv.containers)
    .filter((c) => c.name.startsWith(ORPHAN_PREFIX) && ORPHAN_CONTAINER_NAME_RE.test(c.name))
    .filter((c) => containerReference(c, refs) === null)
    .map((c) => ({
      serverId,
      id: c.id,
      name: c.name,
      state: c.state,
      createdAt: c.createdAt,
      memoryBytes: mem.get(c.name) ?? null,
      volumes: c.volumes.filter((v) => !MAILCOW_VOLUME_RE.test(v)),
    }))
  const volumes: OrphanVolume[] = parseSizedLines(inv.danglingVolumes)
    .filter((v) => VOLUME_NAME_RE.test(v.key) && !MAILCOW_VOLUME_RE.test(v.key))
    .map((v) => ({ serverId, name: v.key, sizeBytes: v.bytes }))
  const folders: OrphanFolder[] = parseSizedLines(inv.projectDirs)
    .map((f) => ({ ...f, key: trimSlash(f.key) }))
    .filter((f) => f.key.startsWith(`${PROJECTS_ROOT}/`) && !refs.paths.has(f.key))
    .map((f) => ({ serverId, path: f.key, sizeBytes: f.bytes }))
  return { containers, volumes, folders }
}

type ExecClient = Parameters<typeof import('@/lib/vps/ssh').exec>[0]

/**
 * Read the raw orphan inventory over an open connection. Read-only commands;
 * the only interpolated values are project paths that passed PROJECT_DIR_RE
 * and are shell-quoted.
 */
export async function collectOrphanInventory(
  client: ExecClient,
  knownPaths: Set<string>
): Promise<OrphanInventory> {
  const { exec, shellQuote } = await import('@/lib/vps/ssh')
  const ps = await exec(client, `docker ps -a --no-trunc --format '${ORPHAN_PS_FORMAT}'`, { timeoutMs: 20000 })
  if (ps.exitCode !== 0) throw new Error(`docker ps failed: ${ps.stderr.trim().slice(0, 200)}`)
  const [stats, vols, dirs] = await Promise.all([
    exec(client, `docker stats --no-stream --format '{{.Name}}\t{{.MemUsage}}'`, { timeoutMs: 30000 }),
    exec(
      client,
      // Volume names come from Docker itself and stay inside "$v".
      `docker volume ls -qf dangling=true 2>/dev/null | grep -v '^mailcowdockerized_' | while IFS= read -r v; do ` +
        `m=$(docker volume inspect -f '{{.Mountpoint}}' "$v" 2>/dev/null); s=''; ` +
        `[ -n "$m" ] && s=$(timeout 20 du -sb -- "$m" 2>/dev/null | cut -f1); ` +
        `printf '%s\\t%s\\n' "$v" "$s"; done`,
      { timeoutMs: 120000 }
    ),
    exec(client, `find ${PROJECTS_ROOT} -mindepth 1 -maxdepth 1 -type d 2>/dev/null`, { timeoutMs: 20000 }),
  ])
  // Size only the folders nothing refers to: du over every site is not cheap.
  const unknown = dirs.stdout
    .split('\n')
    .map((l) => trimSlash(l.trim()))
    .filter((p) => p && !knownPaths.has(p))
  const sizable = unknown.filter((p) => PROJECT_DIR_RE.test(p))
  let sized = ''
  if (sizable.length) {
    const r = await exec(
      client,
      `for p in ${sizable.map(shellQuote).join(' ')}; do printf '%s\\t%s\\n' "$p" "$(timeout 20 du -sb -- "$p" 2>/dev/null | cut -f1)"; done`,
      { timeoutMs: 120000 }
    )
    sized = r.stdout
  }
  const unsized = unknown.filter((p) => !PROJECT_DIR_RE.test(p)).map((p) => `${p}\t`)
  return {
    containers: ps.stdout,
    stats: stats.exitCode === 0 ? stats.stdout : '',
    danglingVolumes: vols.stdout,
    projectDirs: [sized.trim(), ...unsized].filter(Boolean).join('\n'),
  }
}

async function realReadOrphanInventory(
  serverId: string,
  ctx: { knownPaths: Set<string> }
): Promise<OrphanInventory> {
  const { getServerCredentials } = await import('@/lib/vps/provisioner')
  const { withConnection } = await import('@/lib/vps/ssh')
  const creds = await getServerCredentials(serverId)
  return withConnection(creds, (client) => collectOrphanInventory(client, ctx.knownPaths))
}

export async function checkOrphans(deps: InfraDeps = {}): Promise<OrphanCheck> {
  const empty: OrphanCheck = {
    serversChecked: 0, containers: [], volumes: [], folders: [], orphanMemoryBytes: 0, serverErrors: [],
  }
  // Stricter than the other checks: `force` alone is not enough, because the
  // real reader would run docker on a localhost test server.
  if (process.env.NODE_ENV === 'test' && !deps.readOrphanInventory) {
    return { ...empty, skipped: 'test run' }
  }
  const read = deps.readOrphanInventory ?? realReadOrphanInventory
  const servers = await db.server.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } })
  const real = deps.readOrphanInventory ? null : await realServers(servers.map((s) => s.id))
  const refs = await loadOrphanReferences()
  const result: OrphanCheck = { ...empty, containers: [], volumes: [], folders: [], serverErrors: [] }
  for (const { id: serverId } of servers) {
    if (real && !real.has(serverId)) continue
    let inv: OrphanInventory
    try {
      inv = await read(serverId, { knownPaths: refs.paths })
    } catch (err) {
      result.serverErrors.push({ serverId, error: errText(err) })
      continue
    }
    result.serversChecked++
    const found = detectOrphans(serverId, inv, refs)
    result.containers.push(...found.containers)
    result.volumes.push(...found.volumes)
    result.folders.push(...found.folders)
  }
  result.orphanMemoryBytes = result.containers.reduce((s, c) => s + (c.memoryBytes ?? 0), 0)
  return result
}

// ── Manual removal of ONE orphan container ────────────────────────────────

export interface LiveContainer {
  id: string
  name: string
  state: string
  createdAt: string | null
  composeProject: string
  volumes: string[]
}

export interface OrphanRemovalOps {
  /** The container with exactly this name, or null. Read-only. */
  inspect: (serverId: string, name: string) => Promise<LiveContainer | null>
  /** Force-remove the container, then try each volume (Docker refuses volumes still in use). */
  remove: (
    serverId: string,
    name: string,
    volumes: string[]
  ) => Promise<{ volumesRemoved: string[]; volumesKept: string[] }>
}

export type OrphanRemovalResult =
  | {
      ok: true
      container: string
      volumesRemoved: string[]
      volumesKept: string[]
    }
  | {
      ok: false
      status: 400 | 404 | 409 | 503
      code: string
      error: string
    }

async function realInspect(serverId: string, name: string): Promise<LiveContainer | null> {
  const { getServerCredentials } = await import('@/lib/vps/provisioner')
  const { withConnection, exec, shellQuote } = await import('@/lib/vps/ssh')
  const creds = await getServerCredentials(serverId)
  return withConnection(creds, async (client) => {
    // Exact-name filter: Docker's name filter is a regex, so anchor it.
    const filter = `name=^/?${name.replace(/[.]/g, '\\.')}$`
    const r = await exec(
      client,
      `docker ps -a --no-trunc --filter ${shellQuote(filter)} --format '${ORPHAN_PS_FORMAT}'`,
      { timeoutMs: 20000 }
    )
    if (r.exitCode !== 0) throw new Error(`docker ps failed: ${r.stderr.trim().slice(0, 200)}`)
    return parseOrphanPs(r.stdout).find((c) => c.name === name) ?? null
  })
}

async function realRemove(
  serverId: string,
  name: string,
  volumes: string[]
): Promise<{ volumesRemoved: string[]; volumesKept: string[] }> {
  const { getServerCredentials } = await import('@/lib/vps/provisioner')
  const { withConnection, exec, shellQuote } = await import('@/lib/vps/ssh')
  const creds = await getServerCredentials(serverId)
  return withConnection(creds, async (client) => {
    const rm = await exec(client, `docker rm -f ${shellQuote(name)}`, { timeoutMs: 60000 })
    if (rm.exitCode !== 0) throw new Error(`docker rm failed: ${rm.stderr.trim().slice(0, 200)}`)
    const volumesRemoved: string[] = []
    const volumesKept: string[] = []
    for (const v of volumes) {
      // No -f: Docker refuses a volume another container still uses, which is
      // exactly the protection wanted here.
      const r = await exec(client, `docker volume rm ${shellQuote(v)}`, { timeoutMs: 30000 })
      ;(r.exitCode === 0 ? volumesRemoved : volumesKept).push(v)
    }
    return { volumesRemoved, volumesKept }
  })
}

/**
 * Remove one orphan container (and the volumes it mounted) — only if, at this
 * moment, it is still a deployhub-* container that nothing refers to.
 *
 * Order matters: the name is validated and checked against the database
 * BEFORE any connection is made, then the live container is inspected and
 * checked again by id / compose label, then the references are re-read right
 * before removal.
 */
export async function removeOrphanContainer(
  input: { serverId: string; name: string },
  deps: { ops?: OrphanRemovalOps; now?: Date } = {}
): Promise<OrphanRemovalResult> {
  const { serverId, name } = input
  if (!ORPHAN_CONTAINER_NAME_RE.test(name)) {
    return { ok: false, status: 400, code: 'INVALID_NAME', error: 'Only deployhub-* container names can be removed' }
  }
  const server = await db.server.findUnique({
    where: { id: serverId },
    select: { id: true, sshHost: true, sshPrivateKey: true, sshPassword: true },
  })
  if (!server) return { ok: false, status: 404, code: 'SERVER_NOT_FOUND', error: 'Server not found' }

  const refused = (why: string): OrphanRemovalResult => ({
    ok: false, status: 409, code: 'REFERENCED', error: `Container is referenced (${why}); not removed`,
  })
  const byName = containerReference({ name }, await loadOrphanReferences())
  if (byName) return refused(byName)

  if (!deps.ops) {
    if (process.env.NODE_ENV === 'test') {
      return { ok: false, status: 503, code: 'UNAVAILABLE', error: 'Docker is not reachable in a test run' }
    }
    const { isServerInDemoMode } = await import('@/lib/vps/ssh')
    if (isServerInDemoMode(server)) {
      return { ok: false, status: 409, code: 'DEMO_SERVER', error: 'Server is simulated; nothing to remove' }
    }
  }
  const ops = deps.ops ?? { inspect: realInspect, remove: realRemove }

  const live = await ops.inspect(serverId, name)
  if (!live) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Container not found on this server' }
  const liveRef = containerReference(live, await loadOrphanReferences())
  if (liveRef) return refused(liveRef)
  const now = deps.now ?? new Date()
  if (!live.createdAt || now.getTime() - new Date(live.createdAt).getTime() < ORPHAN_MIN_AGE_MS) {
    return {
      ok: false, status: 409, code: 'TOO_RECENT',
      error: 'Container is too new (or its age is unknown); a deploy may still be recording it',
    }
  }
  // Last look, as close to the removal as possible.
  const lastRef = containerReference(live, await loadOrphanReferences())
  if (lastRef) return refused(lastRef)

  const volumes = live.volumes.filter((v) => VOLUME_NAME_RE.test(v) && !MAILCOW_VOLUME_RE.test(v))
  const out = await ops.remove(serverId, name, volumes)
  return { ok: true, container: name, ...out }
}

// ── Orchestration ─────────────────────────────────────────────────────────

export async function runInfraReconcile(deps: InfraDeps = {}): Promise<InfraReconcileSummary> {
  const now = deps.now ?? new Date()
  const guard = <T extends object>(p: Promise<T>, fallback: (e: string) => T) =>
    p.catch((err) => fallback(errText(err)))
  const containers = await guard(checkContainers(deps), (e) => ({
    skipped: `container check failed: ${e}`, checked: 0, missing: [], notRunning: [], serverErrors: [],
  }))
  const certificates = await guard(checkCertificates({ ...deps, now }), (e) => ({
    skipped: `certificate check failed: ${e}`, checked: 0, issued: 0, notServed: [], expiringSoon: [], serverErrors: [],
  }))
  const registrar = await guard(checkRegistrar({ ...deps, now }), (e) => ({
    skipped: `registrar check failed: ${e}`, checked: 0, expiryCorrected: [], expiredAtRegistrar: [], lookupFailed: [],
  }))
  const orphans = await guard(checkOrphans(deps), (e) => ({
    skipped: `orphan check failed: ${e}`, serversChecked: 0, containers: [], volumes: [], folders: [],
    orphanMemoryBytes: 0, serverErrors: [],
  }))
  const summary: InfraReconcileSummary = {
    ranAt: now.toISOString(), containers, certificates, registrar, orphans,
  }
  await db.appSetting
    .upsert({
      where: { key: INFRA_REPORT_KEY },
      create: { key: INFRA_REPORT_KEY, value: JSON.stringify(summary), updatedBy: 'reconcile' },
      update: { value: JSON.stringify(summary), updatedBy: 'reconcile' },
    })
    .catch(() => {})
  return summary
}

/** Last stored infrastructure summary (for the admin report), or null. */
export async function lastInfraReport(): Promise<InfraReconcileSummary | null> {
  const row = await db.appSetting.findUnique({ where: { key: INFRA_REPORT_KEY } }).catch(() => null)
  if (!row) return null
  try {
    return JSON.parse(row.value) as InfraReconcileSummary
  } catch {
    return null
  }
}
