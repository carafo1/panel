/**
 * Redirects Module
 * ================
 *
 * Manages URL redirects (301 / 302) for a project. Each redirect is stored
 * in the Redirect Prisma table and (when a real VPS is configured) is
 * materialized as a `redir` directive in the project's Caddy site block.
 *
 * Operations:
 *   - listRedirects(projectId)        — list all redirects
 *   - createRedirect(projectId, opts) — validate + create DB row + reload Caddy
 *   - updateRedirect(redirectId, ...) — update DB row + reload Caddy if enabled
 *   - deleteRedirect(redirectId)      — delete DB row + reload Caddy
 *
 * In DEMO MODE the Caddy reload is simulated; the DB rows are still
 * created/updated/deleted so the UI works end-to-end.
 *
 * Validation:
 *   - fromPath must start with "/"
 *   - statusCode must be 301 or 302
 */
import { db } from '@/lib/db'
import { reloadCaddy } from './proxy'
import { isServerInDemoMode } from './ssh'

// ─── Types ───────────────────────────────────────────────────────────────

export interface RedirectRow {
  id: string
  projectId: string
  fromPath: string
  toUrl: string
  statusCode: number
  matchQuery: string | null
  enabled: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateRedirectInput {
  fromPath: string
  toUrl: string
  statusCode?: number
  matchQuery?: string | null
  enabled?: boolean
}

export interface UpdateRedirectPatch {
  fromPath?: string
  toUrl?: string
  statusCode?: number
  matchQuery?: string | null
  enabled?: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function toRow(r: {
  id: string
  projectId: string
  fromPath: string
  toUrl: string
  statusCode: number
  matchQuery: string | null
  enabled: boolean
  createdAt: Date
  updatedAt: Date
}): RedirectRow {
  return {
    id: r.id,
    projectId: r.projectId,
    fromPath: r.fromPath,
    toUrl: r.toUrl,
    statusCode: r.statusCode,
    matchQuery: r.matchQuery,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

// ─── List ────────────────────────────────────────────────────────────────

export async function listRedirects(projectId: string): Promise<RedirectRow[]> {
  const rows = await db.redirect.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'asc' }],
  })
  return rows.map(toRow)
}

// ─── Create ──────────────────────────────────────────────────────────────

export async function createRedirect(
  projectId: string,
  opts: CreateRedirectInput
): Promise<RedirectRow> {
  const fromPath = (opts.fromPath || '').trim()
  if (!fromPath) throw new Error('From path is required')
  if (!fromPath.startsWith('/')) {
    throw new Error('From path must start with "/"')
  }
  const toUrl = (opts.toUrl || '').trim()
  if (!toUrl) throw new Error('To URL is required')
  const statusCode =
    opts.statusCode === 302 ? 302 : opts.statusCode === 301 ? 301 : 301
  const matchQuery =
    typeof opts.matchQuery === 'string' && opts.matchQuery.trim()
      ? opts.matchQuery.trim()
      : null
  const enabled = opts.enabled !== false // default true

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  const row = await db.redirect.create({
    data: {
      projectId,
      fromPath,
      toUrl,
      statusCode,
      matchQuery,
      enabled,
    },
  })

  // Best-effort: reload Caddy so the new redirect takes effect.
  if (project.serverId && !isServerInDemoMode(project.server)) {
    try {
      await reloadCaddy(project.serverId)
    } catch (err) {
      console.error('[vps-redirects] failed to reload Caddy on create:', err)
    }
  } else {
    console.log(
      `[demo] redirect create — would reload Caddy for ${fromPath} -> ${toUrl} (${statusCode})`
    )
  }

  return toRow(row)
}

// ─── Update ──────────────────────────────────────────────────────────────

export async function updateRedirect(
  redirectId: string,
  patch: UpdateRedirectPatch
): Promise<RedirectRow> {
  const existing = await db.redirect.findUnique({ where: { id: redirectId } })
  if (!existing) throw new Error('Redirect not found')

  const data: Record<string, unknown> = {}
  if (patch.fromPath !== undefined) {
    const p = patch.fromPath.trim()
    if (!p) throw new Error('From path cannot be empty')
    if (!p.startsWith('/')) throw new Error('From path must start with "/"')
    data.fromPath = p
  }
  if (patch.toUrl !== undefined) {
    const u = patch.toUrl.trim()
    if (!u) throw new Error('To URL cannot be empty')
    data.toUrl = u
  }
  if (patch.statusCode !== undefined) {
    if (patch.statusCode !== 301 && patch.statusCode !== 302) {
      throw new Error('Status code must be 301 or 302')
    }
    data.statusCode = patch.statusCode
  }
  if (patch.matchQuery !== undefined) {
    data.matchQuery =
      typeof patch.matchQuery === 'string' && patch.matchQuery.trim()
        ? patch.matchQuery.trim()
        : null
  }
  if (patch.enabled !== undefined) {
    data.enabled = !!patch.enabled
  }

  const updated = await db.redirect.update({
    where: { id: redirectId },
    data,
  })

  // Best-effort: reload Caddy if the redirect is (still) enabled.
  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    include: { server: true },
  })
  if (project?.serverId && !isServerInDemoMode(project.server)) {
    try {
      await reloadCaddy(project.serverId)
    } catch (err) {
      console.error('[vps-redirects] failed to reload Caddy on update:', err)
    }
  } else {
    console.log(`[demo] redirect update — would reload Caddy for redirect ${redirectId}`)
  }

  return toRow(updated)
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteRedirect(redirectId: string): Promise<{ ok: boolean }> {
  const existing = await db.redirect.findUnique({ where: { id: redirectId } })
  if (!existing) return { ok: false }

  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    include: { server: true },
  })

  await db.redirect.delete({ where: { id: redirectId } })

  if (project?.serverId && !isServerInDemoMode(project.server)) {
    try {
      await reloadCaddy(project.serverId)
    } catch (err) {
      console.error('[vps-redirects] failed to reload Caddy on delete:', err)
    }
  } else {
    console.log(`[demo] redirect delete — would reload Caddy for redirect ${redirectId}`)
  }

  return { ok: true }
}
