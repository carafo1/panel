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

export interface InfraReconcileSummary {
  ranAt: string
  containers: ContainerCheck
  certificates: CertificateCheck
  registrar: RegistrarCheck
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
  const summary: InfraReconcileSummary = { ranAt: now.toISOString(), containers, certificates, registrar }
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
