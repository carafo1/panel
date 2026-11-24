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
 *   - createRedirect(projectId, opts) — validate + create DB row + regenerate Caddyfile
 *   - updateRedirect(redirectId, ...) — update DB row + regenerate Caddyfile
 *   - deleteRedirect(redirectId)      — delete DB row + regenerate Caddyfile
 *
 * Enforcement is two-layer:
 *   1. Next.js middleware (src/middleware.ts) — matches the request path
 *      against active Redirect rows (cached 10s) and returns
 *      NextResponse.redirect(...) on match. Works everywhere, including
 *      the sandbox (no Caddy required).
 *   2. Caddyfile generation (src/lib/vps/proxy.ts:generateCaddyBlock) —
 *      injects `redir <from> <to> <code>` directives into the project's
 *      Caddy site block. Applied on real VPS hosts via configureProjectProxy.
 *
 * Validation:
 *   - fromPath must start with "/"
 *   - statusCode must be 301 or 302
 */
import { db } from '@/lib/db'
import { configureProjectProxy } from './proxy'

export interface ProxyApplyResult {
  /** False when the change is saved but the live web server was not updated. */
  applied: boolean
  applyMessage?: string
}

/**
 * Regenerate the proxy and say honestly whether it worked. configureProjectProxy
 * reports most failures as { ok: false } rather than throwing; that used to be
 * ignored, so the customer saw success while Caddy never got the change.
 */
async function applyProxy(projectId: string, what: string): Promise<ProxyApplyResult> {
  const r = await configureProjectProxy(projectId).catch((err: unknown) => ({
    ok: false,
    message: err instanceof Error ? err.message : String(err),
  }))
  if (r.ok) return { applied: true }
  console.error(`[vps-redirects] failed to regenerate Caddyfile on ${what}:`, r.message)
  return {
    applied: false,
    applyMessage: 'Saved, but the web server could not be updated yet. Try again in a minute.',
  }
}
import {
  RedirectValidationError,
  redirectFromPathError,
  redirectToUrlError,
  redirectStatusError,
} from './redirect-rules'

export { RedirectValidationError }

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
): Promise<RedirectRow & ProxyApplyResult> {
  // These values are written into the Caddyfile every tenant shares; see
  // redirect-rules for why trimming alone was not enough.
  const fromErr = redirectFromPathError(opts.fromPath)
  if (fromErr) throw new RedirectValidationError(fromErr)
  const toErr = redirectToUrlError(opts.toUrl)
  if (toErr) throw new RedirectValidationError(toErr)
  const fromPath = opts.fromPath.trim()
  const toUrl = opts.toUrl.trim()
  const statusCode =
    opts.statusCode === 302 ? 302 : opts.statusCode === 301 ? 301 : 301
  const matchQuery =
    typeof opts.matchQuery === 'string' && opts.matchQuery.trim()
      ? opts.matchQuery.trim()
      : null
  const enabled = opts.enabled !== false // default true

  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { serverId: true },
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

  // Regenerate the project's Caddy site block so the new `redir` directive is
  // injected. Best-effort: failures don't roll back the DB row. The Next.js
  // middleware (Layer 1) enforces the redirect in real-time regardless.
  const apply = project.serverId ? await applyProxy(projectId, 'create') : { applied: true }
  return { ...toRow(row), ...apply }
}

// ─── Update ──────────────────────────────────────────────────────────────

export async function updateRedirect(
  redirectId: string,
  patch: UpdateRedirectPatch
): Promise<RedirectRow & ProxyApplyResult> {
  const existing = await db.redirect.findUnique({ where: { id: redirectId } })
  if (!existing) throw new Error('Redirect not found')

  const data: Record<string, unknown> = {}
  if (patch.fromPath !== undefined) {
    const err = redirectFromPathError(patch.fromPath)
    if (err) throw new RedirectValidationError(err)
    data.fromPath = patch.fromPath.trim()
  }
  if (patch.toUrl !== undefined) {
    const err = redirectToUrlError(patch.toUrl)
    if (err) throw new RedirectValidationError(err)
    data.toUrl = patch.toUrl.trim()
  }
  if (patch.statusCode !== undefined) {
    const err = redirectStatusError(patch.statusCode)
    if (err) throw new RedirectValidationError(err)
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

  // Regenerate the Caddy site block so the updated `redir` directive (or its
  // removal when disabled) takes effect. Best-effort.
  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    select: { serverId: true },
  })
  const apply = project?.serverId ? await applyProxy(existing.projectId, 'update') : { applied: true }
  return { ...toRow(updated), ...apply }
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteRedirect(redirectId: string): Promise<{ ok: boolean } & Partial<ProxyApplyResult>> {
  const existing = await db.redirect.findUnique({ where: { id: redirectId } })
  if (!existing) return { ok: false }

  const projectId = existing.projectId
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { serverId: true },
  })

  await db.redirect.delete({ where: { id: redirectId } })

  // Regenerate the Caddy site block so the deleted `redir` directive is removed.
  // Best-effort.
  const apply = project?.serverId ? await applyProxy(projectId, 'delete') : { applied: true }
  return { ok: true, ...apply }
}
