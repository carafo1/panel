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
 *   - createIpBlock(projectId, opts) — validate + create DB row + regenerate Caddyfile
 *   - updateIpBlock(blockId, ...)    — update DB row + regenerate Caddyfile
 *   - deleteIpBlock(blockId)         — delete DB row + regenerate Caddyfile
 *
 * Enforcement is two-layer:
 *   1. Next.js middleware (src/middleware.ts) — checks the request IP against
 *      active IpBlock rows (cached 10s) and returns 403 Forbidden on match.
 *      Deny rules block matching IPs; allow rules enable whitelist mode (only
 *      listed IPs are admitted). Works everywhere, including the sandbox.
 *   2. Caddyfile generation (src/lib/vps/proxy.ts:generateCaddyBlock) —
 *      injects `@blocked { client_ip ... }` + `respond @blocked 403` directives
 *      into the project's Caddy site block (deny rules only). Applied on
 *      real VPS hosts via configureProjectProxy.
 *
 * IP validation: accepts IPv4 (`192.168.1.5`) or IPv4 CIDR (`10.0.0.0/8`).
 */
import { db } from '@/lib/db'
import { configureProjectProxy } from './proxy'

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
    select: { serverId: true },
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

  // Regenerate the project's Caddy site block so the new `@blocked` matcher is
  // injected (deny rules only; allow rules are middleware-enforced). Best-effort:
  // failures don't roll back the DB row. The Next.js middleware (Layer 1)
  // enforces the rule in real-time regardless.
  if (project.serverId) {
    try {
      await configureProjectProxy(projectId)
    } catch (err) {
      console.error('[vps-security] failed to regenerate Caddyfile on create:', err)
    }
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

  // Regenerate the Caddy site block so the updated rule (or its removal when
  // disabled) takes effect. Best-effort.
  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    select: { serverId: true },
  })
  if (project?.serverId) {
    try {
      await configureProjectProxy(existing.projectId)
    } catch (err) {
      console.error('[vps-security] failed to regenerate Caddyfile on update:', err)
    }
  }

  return toRow(updated)
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteIpBlock(blockId: string): Promise<{ ok: boolean }> {
  const existing = await db.ipBlock.findUnique({ where: { id: blockId } })
  if (!existing) return { ok: false }

  const projectId = existing.projectId
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { serverId: true },
  })

  await db.ipBlock.delete({ where: { id: blockId } })

  // Regenerate the Caddy site block so the deleted rule is removed.
  // Best-effort.
  if (project?.serverId) {
    try {
      await configureProjectProxy(projectId)
    } catch (err) {
      console.error('[vps-security] failed to regenerate Caddyfile on delete:', err)
    }
  }

  return { ok: true }
}
