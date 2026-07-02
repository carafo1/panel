/**
 * IP Blocker / Security Module
 * ============================
 *
 * Manages IP-based access rules (deny / allow) for a project. Each rule is
 * stored in the IpBlock Prisma table and (when a real VPS is configured) is
 * materialized as a Caddy `@blocked client_ip` matcher + `respond 403` block
 * (for deny rules) or as an explicit allow matcher (for allow rules).
 *
 * Operations:
 *   - listIpBlocks(projectId)        — list all rules
 *   - createIpBlock(projectId, opts) — validate + create DB row + reload Caddy
 *   - updateIpBlock(blockId, ...)    — update DB row + reload Caddy if enabled
 *   - deleteIpBlock(blockId)         — delete DB row + reload Caddy
 *
 * In DEMO MODE the Caddy reload is simulated; the DB rows are still
 * created/updated/deleted so the UI works end-to-end.
 *
 * IP validation: accepts IPv4 (`192.168.1.5`) or IPv4 CIDR (`10.0.0.0/8`).
 */
import { db } from '@/lib/db'
import { reloadCaddy } from './proxy'
import { isServerInDemoMode } from './ssh'

// ─── Types ───────────────────────────────────────────────────────────────

export interface IpBlockRow {
  id: string
  projectId: string
  ipAddress: string
  action: string // "deny" | "allow"
  reason: string | null
  enabled: boolean
  expiresAt: string | null
  createdAt: string
}

export interface CreateIpBlockInput {
  ipAddress: string
  action?: string
  reason?: string | null
  expiresAt?: Date | null
}

export interface UpdateIpBlockPatch {
  ipAddress?: string
  action?: string
  reason?: string | null
  enabled?: boolean
  expiresAt?: Date | null
}

// ─── Validation ──────────────────────────────────────────────────────────

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/

/**
 * Validate an IP address or CIDR. Accepts IPv4 and IPv4 CIDR (e.g. 10.0.0.0/8).
 * Returns `{ ok, message }`.
 */
export function validateIpAddress(ip: string): { ok: boolean; message: string } {
  const trimmed = (ip || '').trim()
  if (!trimmed) return { ok: false, message: 'IP address is required' }
  if (!IPV4_RE.test(trimmed)) {
    return {
      ok: false,
      message: 'Must be an IPv4 address (e.g. 192.168.1.5) or CIDR (e.g. 10.0.0.0/8)',
    }
  }
  // Validate each octet is 0-255 and (if CIDR) the prefix is 0-32.
  const [ipPart, cidrPart] = trimmed.split('/')
  const octets = ipPart!.split('.')
  for (const o of octets) {
    const n = Number(o)
    if (Number.isNaN(n) || n < 0 || n > 255) {
      return { ok: false, message: `Invalid octet: ${o}` }
    }
  }
  if (cidrPart !== undefined) {
    const n = Number(cidrPart)
    if (Number.isNaN(n) || n < 0 || n > 32) {
      return { ok: false, message: 'CIDR prefix must be 0-32' }
    }
  }
  return { ok: true, message: 'Valid IP address' }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function toRow(r: {
  id: string
  projectId: string
  ipAddress: string
  action: string
  reason: string | null
  enabled: boolean
  expiresAt: Date | null
  createdAt: Date
}): IpBlockRow {
  return {
    id: r.id,
    projectId: r.projectId,
    ipAddress: r.ipAddress,
    action: r.action,
    reason: r.reason,
    enabled: r.enabled,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  }
}

// ─── List ────────────────────────────────────────────────────────────────

export async function listIpBlocks(projectId: string): Promise<IpBlockRow[]> {
  const rows = await db.ipBlock.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'asc' }],
  })
  return rows.map(toRow)
}

// ─── Create ──────────────────────────────────────────────────────────────

export async function createIpBlock(
  projectId: string,
  opts: CreateIpBlockInput
): Promise<IpBlockRow> {
  const ipAddress = (opts.ipAddress || '').trim()
  const v = validateIpAddress(ipAddress)
  if (!v.ok) throw new Error(v.message)
  const action = opts.action === 'allow' ? 'allow' : 'deny'
  const reason =
    typeof opts.reason === 'string' && opts.reason.trim()
      ? opts.reason.trim().slice(0, 500)
      : null
  const expiresAt =
    opts.expiresAt instanceof Date && !Number.isNaN(opts.expiresAt.getTime())
      ? opts.expiresAt
      : null

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  const row = await db.ipBlock.create({
    data: {
      projectId,
      ipAddress,
      action,
      reason,
      enabled: true,
      expiresAt,
    },
  })

  // Best-effort: reload Caddy so the new rule takes effect.
  if (project.serverId && !isServerInDemoMode(project.server)) {
    try {
      await reloadCaddy(project.serverId)
    } catch (err) {
      console.error('[vps-security] failed to reload Caddy on create:', err)
    }
  } else {
    console.log(
      `[demo] ip-block create — would reload Caddy to ${action} ${ipAddress}`
    )
  }

  return toRow(row)
}

// ─── Update ──────────────────────────────────────────────────────────────

export async function updateIpBlock(
  blockId: string,
  patch: UpdateIpBlockPatch
): Promise<IpBlockRow> {
  const existing = await db.ipBlock.findUnique({ where: { id: blockId } })
  if (!existing) throw new Error('IP block not found')

  const data: Record<string, unknown> = {}
  if (patch.ipAddress !== undefined) {
    const ip = patch.ipAddress.trim()
    const v = validateIpAddress(ip)
    if (!v.ok) throw new Error(v.message)
    data.ipAddress = ip
  }
  if (patch.action !== undefined) {
    data.action = patch.action === 'allow' ? 'allow' : 'deny'
  }
  if (patch.reason !== undefined) {
    data.reason =
      typeof patch.reason === 'string' && patch.reason.trim()
        ? patch.reason.trim().slice(0, 500)
        : null
  }
  if (patch.enabled !== undefined) {
    data.enabled = !!patch.enabled
  }
  if (patch.expiresAt !== undefined) {
    data.expiresAt =
      patch.expiresAt instanceof Date && !Number.isNaN(patch.expiresAt.getTime())
        ? patch.expiresAt
        : null
  }

  const updated = await db.ipBlock.update({
    where: { id: blockId },
    data,
  })

  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    include: { server: true },
  })
  if (project?.serverId && !isServerInDemoMode(project.server)) {
    try {
      await reloadCaddy(project.serverId)
    } catch (err) {
      console.error('[vps-security] failed to reload Caddy on update:', err)
    }
  } else {
    console.log(`[demo] ip-block update — would reload Caddy for block ${blockId}`)
  }

  return toRow(updated)
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteIpBlock(blockId: string): Promise<{ ok: boolean }> {
  const existing = await db.ipBlock.findUnique({ where: { id: blockId } })
  if (!existing) return { ok: false }

  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    include: { server: true },
  })

  await db.ipBlock.delete({ where: { id: blockId } })

  if (project?.serverId && !isServerInDemoMode(project.server)) {
    try {
      await reloadCaddy(project.serverId)
    } catch (err) {
      console.error('[vps-security] failed to reload Caddy on delete:', err)
    }
  } else {
    console.log(`[demo] ip-block delete — would reload Caddy for block ${blockId}`)
  }

  return { ok: true }
}
