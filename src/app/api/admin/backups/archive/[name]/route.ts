/**
 * /api/admin/backups/archive/[name]
 *
 *   GET    — download one server archive
 *   DELETE — remove one server archive
 *
 * The admin page could list archives and do nothing with them, which makes a
 * backup you cannot retrieve — decoration with a filesize next to it.
 *
 * SECURITY — the name arrives from the URL and is used to build a filesystem
 * path, so it is the obvious traversal target: `..%2f..%2fetc%2fpasswd` would
 * otherwise read anything the panel user can. Two independent checks, because
 * one of them being subtly wrong is exactly how these get through:
 *
 *   1. The name must match a strict allowlist pattern — no separators, no
 *      dots beyond the extension.
 *   2. The RESOLVED absolute path must still sit inside BACKUP_DIR. Belt and
 *      braces: check 1 should make check 2 unreachable, and check 2 is what
 *      actually holds if check 1 is ever loosened.
 *
 * Deliberately NOT offering restore. Restoring the panel database while the
 * panel is running on it corrupts both; that is an operation to do over SSH
 * with the service stopped, and a one-click button would invite doing it
 * wrong at the worst possible moment.
 */
import { NextResponse } from 'next/server'
import { requireAdminRole, authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { promises as fs } from 'fs'
import path from 'path'

const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/apsamo/backups'

/** Exactly the shape the backup scripts produce. Nothing else is servable. */
const SAFE_NAME = /^[A-Za-z0-9._-]+\.(tar\.gz|sql\.gz|tar|gz|enc)$/

function resolveArchive(raw: string): string | null {
  const name = decodeURIComponent(raw || '')
  if (!name || !SAFE_NAME.test(name)) return null
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null

  const full = path.resolve(BACKUP_DIR, name)
  const root = path.resolve(BACKUP_DIR)
  // path.resolve collapses any traversal; if the result escaped the root, the
  // name was hostile regardless of what the pattern allowed.
  if (full !== path.join(root, path.basename(full))) return null
  if (!full.startsWith(root + path.sep)) return null
  return full
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ name: string }> }
) {
  if (!(await requireAdminRole(request))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const { name } = await ctx.params
  const full = resolveArchive(name)
  if (!full) {
    return NextResponse.json({ error: 'Invalid archive name' }, { status: 400 })
  }

  let data: Buffer
  try {
    data = await fs.readFile(full)
  } catch {
    return NextResponse.json({ error: 'Archive not found' }, { status: 404 })
  }

  const user = await authenticateRequest(request)
  await logAudit({
    userId: user?.userId || 'system',
    action: 'admin.backup.downloaded',
    resource: 'server_backup',
    resourceId: path.basename(full),
    req: request,
    metadata: { bytes: data.length },
  }).catch(() => {})

  return new NextResponse(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': 'application/gzip',
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${path.basename(full)}"`,
      // These contain .env and every database. Never let a proxy or the
      // browser keep a copy.
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    },
  })
}

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ name: string }> }
) {
  if (!(await requireAdminRole(request))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const { name } = await ctx.params
  const full = resolveArchive(name)
  if (!full) {
    return NextResponse.json({ error: 'Invalid archive name' }, { status: 400 })
  }

  // Refuse to delete the only copy. Someone tidying up should not be able to
  // leave the platform with no backup at all in two clicks.
  try {
    const remaining = (await fs.readdir(BACKUP_DIR)).filter((f) => f.endsWith('.tar.gz'))
    if (remaining.length <= 1) {
      return NextResponse.json(
        {
          error:
            'This is the only backup archive. Take a new one before deleting it.',
          code: 'last_archive',
        },
        { status: 409 }
      )
    }
  } catch {
    return NextResponse.json({ error: 'Backup directory unreadable' }, { status: 500 })
  }

  let bytes = 0
  try {
    bytes = (await fs.stat(full)).size
    await fs.unlink(full)
  } catch {
    return NextResponse.json({ error: 'Archive not found' }, { status: 404 })
  }

  const user = await authenticateRequest(request)
  await logAudit({
    userId: user?.userId || 'system',
    action: 'admin.backup.deleted',
    resource: 'server_backup',
    resourceId: path.basename(full),
    req: request,
    metadata: { bytes },
  }).catch(() => {})

  return NextResponse.json({ ok: true, deleted: path.basename(full), bytes })
}
