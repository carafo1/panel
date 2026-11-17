/**
 * Public status page data: platform components, incidents and maintenance.
 *
 * Some components are checked automatically (the panel itself, hosting servers'
 * last health check, the background worker's heartbeats); the rest only change
 * when staff post an incident. The page says which is which, so a green dot
 * never claims more than we actually measured. Nothing here exposes server
 * names, IPs or internal error text.
 */
import { db } from '@/lib/db'

export type ComponentStatus = 'operational' | 'degraded' | 'partial_outage' | 'major_outage' | 'maintenance' | 'unknown'

export const COMPONENTS = [
  { key: 'panel', label: 'Control panel & API', auto: true },
  { key: 'hosting', label: 'Website hosting', auto: true },
  { key: 'deployments', label: 'Deployments & automation', auto: true },
  { key: 'monitoring', label: 'Uptime monitoring', auto: true },
  { key: 'email', label: 'Email hosting', auto: false },
  { key: 'domains', label: 'Domains & DNS', auto: false },
  { key: 'billing', label: 'Billing & payments', auto: false },
] as const
export type ComponentKey = (typeof COMPONENTS)[number]['key']
const COMPONENT_KEYS = COMPONENTS.map((c) => c.key) as string[]

export const IMPACTS = ['minor', 'major', 'critical', 'maintenance'] as const
export const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved'] as const
export const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed'] as const

const RANK: Record<ComponentStatus, number> = {
  operational: 0,
  unknown: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
}
const worst = (a: ComponentStatus, b: ComponentStatus) => (RANK[b] > RANK[a] ? b : a)

const IMPACT_STATUS: Record<string, ComponentStatus> = {
  minor: 'degraded',
  major: 'partial_outage',
  critical: 'major_outage',
  maintenance: 'maintenance',
}

export class StatusError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

export function isFinalStatus(impact: string, status: string) {
  return impact === 'maintenance' ? status === 'completed' : status === 'resolved'
}

function parseComponents(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((k) => COMPONENT_KEYS.includes(k)) : []
  } catch {
    return []
  }
}

/** Automatic checks. Returns 'unknown' when we have nothing to go on. */
async function automaticStatus(): Promise<Partial<Record<ComponentKey, ComponentStatus>>> {
  const out: Partial<Record<ComponentKey, ComponentStatus>> = {}

  // The panel answered this request and the database responded.
  try {
    await db.$queryRaw`SELECT 1`
    out.panel = 'operational'
  } catch {
    out.panel = 'major_outage'
  }

  // Hosting: the last health check of each active server (fresh within 2h).
  const servers = await db.server
    .findMany({ where: { status: 'active' }, select: { healthStatus: true, lastHealthCheckAt: true } })
    .catch(() => [])
  const fresh = servers.filter((s) => s.lastHealthCheckAt && Date.now() - s.lastHealthCheckAt.getTime() < 2 * 3600_000)
  if (fresh.length === 0) out.hosting = 'unknown'
  else {
    const down = fresh.filter((s) => s.healthStatus === 'down').length
    const degraded = fresh.filter((s) => s.healthStatus === 'degraded').length
    out.hosting = down === fresh.length ? 'major_outage' : down > 0 ? 'partial_outage' : degraded > 0 ? 'degraded' : 'operational'
  }

  // Background worker heartbeats (see lib/health.ts for the cadence).
  const beats = await db.heartbeat.findMany({ where: { key: { in: ['jobs', 'monitors'] } } }).catch(() => [])
  const beat = (key: string, maxAgeMs: number): ComponentStatus => {
    const b = beats.find((x) => x.key === key)
    if (!b) return 'unknown'
    if (b.failures > 2) return 'partial_outage'
    if (b.failures > 0) return 'degraded'
    return Date.now() - new Date(b.at).getTime() > maxAgeMs ? 'partial_outage' : 'operational'
  }
  out.deployments = beat('jobs', 15 * 60_000)
  out.monitoring = beat('monitors', 30 * 60_000)
  return out
}

export interface PublicIncident {
  id: string
  title: string
  impact: string
  status: string
  components: string[]
  startedAt: string
  resolvedAt: string | null
  updates: Array<{ id: string; status: string; message: string; createdAt: string }>
}

function toPublic(i: {
  id: string
  title: string
  impact: string
  status: string
  components: string
  startedAt: Date
  resolvedAt: Date | null
  updates: Array<{ id: string; status: string; message: string; createdAt: Date }>
}): PublicIncident {
  return {
    id: i.id,
    title: i.title,
    impact: i.impact,
    status: i.status,
    components: parseComponents(i.components),
    startedAt: i.startedAt.toISOString(),
    resolvedAt: i.resolvedAt?.toISOString() ?? null,
    updates: i.updates.map((u) => ({ id: u.id, status: u.status, message: u.message, createdAt: u.createdAt.toISOString() })),
  }
}

export async function getStatusPage() {
  const now = new Date()
  const [auto, open, recent] = await Promise.all([
    automaticStatus(),
    db.incident.findMany({
      where: { resolvedAt: null },
      orderBy: { startedAt: 'desc' },
      include: { updates: { orderBy: { createdAt: 'desc' } } },
    }),
    db.incident.findMany({
      where: { resolvedAt: { gte: new Date(now.getTime() - 14 * 86400_000) } },
      orderBy: { startedAt: 'desc' },
      take: 30,
      include: { updates: { orderBy: { createdAt: 'desc' } } },
    }),
  ])

  // Maintenance that hasn't started yet is "upcoming", not affecting anything.
  const upcoming = open.filter((i) => i.impact === 'maintenance' && i.startedAt > now)
  const active = open.filter((i) => !upcoming.includes(i))

  const components = COMPONENTS.map((c) => {
    let status: ComponentStatus = auto[c.key] ?? 'operational'
    for (const i of active) {
      if (parseComponents(i.components).includes(c.key)) status = worst(status, IMPACT_STATUS[i.impact] || 'degraded')
    }
    return { key: c.key, label: c.label, auto: c.auto, status }
  })
  const overall = components.reduce<ComponentStatus>((acc, c) => worst(acc, c.status), 'operational')

  return {
    overall,
    components,
    active: active.map(toPublic),
    upcoming: upcoming.map(toPublic),
    recent: recent.map(toPublic),
    updatedAt: now.toISOString(),
  }
}

// ── Staff ─────────────────────────────────────────────────────────────

function cleanText(v: unknown, label: string, min: number, max: number) {
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length < min) throw new StatusError(`${label} is required.`)
  if (s.length > max) throw new StatusError(`${label} must be at most ${max} characters.`)
  return s
}

function cleanComponents(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const keys = v.filter((k): k is string => typeof k === 'string' && COMPONENT_KEYS.includes(k))
  return [...new Set(keys)]
}

export async function createIncident(
  createdById: string,
  input: { title?: unknown; impact?: unknown; status?: unknown; message?: unknown; components?: unknown; startsAt?: unknown }
) {
  const title = cleanText(input.title, 'Title', 3, 160)
  const message = cleanText(input.message, 'First update', 1, 5000)
  const impact = IMPACTS.includes(input.impact as never) ? (input.impact as string) : 'minor'
  const allowed: readonly string[] = impact === 'maintenance' ? MAINTENANCE_STATUSES : INCIDENT_STATUSES
  const status = allowed.includes(input.status as string) ? (input.status as string) : allowed[0]
  if (isFinalStatus(impact, status)) throw new StatusError('A new incident cannot start resolved.')
  const components = cleanComponents(input.components)
  if (components.length === 0) throw new StatusError('Choose at least one affected component.')
  let startedAt = new Date()
  if (input.startsAt) {
    const d = new Date(String(input.startsAt))
    if (Number.isNaN(d.getTime())) throw new StatusError('Invalid start time.')
    startedAt = d
  }

  return db.incident.create({
    data: {
      title,
      impact,
      status,
      components: JSON.stringify(components),
      startedAt,
      createdById,
      updates: { create: { status, message } },
    },
    include: { updates: true },
  })
}

/** Post an update; reaching the final status resolves the incident. */
export async function addIncidentUpdate(id: string, input: { status?: unknown; message?: unknown; components?: unknown }) {
  const inc = await db.incident.findUnique({ where: { id } })
  if (!inc) throw new StatusError('Incident not found.', 404)
  if (inc.resolvedAt) throw new StatusError('This incident is already resolved.')
  const allowed: readonly string[] = inc.impact === 'maintenance' ? MAINTENANCE_STATUSES : INCIDENT_STATUSES
  const status = cleanText(input.status, 'Status', 1, 40)
  if (!allowed.includes(status)) throw new StatusError(`Status must be one of: ${allowed.join(', ')}.`)
  const message = cleanText(input.message, 'Message', 1, 5000)
  const components = input.components === undefined ? undefined : cleanComponents(input.components)
  if (components && components.length === 0) throw new StatusError('Choose at least one affected component.')

  const final = isFinalStatus(inc.impact, status)
  await db.incident.update({
    where: { id },
    data: {
      status,
      ...(components ? { components: JSON.stringify(components) } : {}),
      ...(final ? { resolvedAt: new Date() } : {}),
      updates: { create: { status, message } },
    },
  })
  return { ok: true, resolved: final }
}

export async function listIncidentsForStaff() {
  const rows = await db.incident.findMany({
    orderBy: [{ resolvedAt: { sort: 'desc', nulls: 'first' } }, { startedAt: 'desc' }],
    take: 100,
    include: { updates: { orderBy: { createdAt: 'desc' } } },
  })
  return rows.map(toPublic)
}
