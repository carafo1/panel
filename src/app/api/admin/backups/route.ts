import { NextResponse } from 'next/server'
import { requireAdminRole, authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import { promises as fs } from 'fs'
import { spawn } from 'child_process'
import path from 'path'

/**
 * Backup visibility.
 *
 * "We have backups" is only true if they exist, are recent, and live
 * somewhere other than the machine being backed up. This reports all three
 * separately so a missing offsite copy is visible rather than assumed —
 * discovering that during a real outage is too late.
 */
const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/apsamo/backups'
const STALE_AFTER_HOURS = 48 // nightly job means >48h without one is broken

interface OffsiteStatus {
  state: string
  detail: string
  archive?: string
  remoteBytes?: number
  at?: string
}

export async function GET(request: Request) {
  try {
    if (!(await requireAdminRole(request))) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    let entries: string[] = []
    try {
      entries = await fs.readdir(BACKUP_DIR)
    } catch {
      return NextResponse.json({
        configured: false,
        message: `Backup directory ${BACKUP_DIR} is not readable from the panel.`,
        archives: [],
        offsite: { state: 'unknown', detail: 'Backup directory unavailable.' },
      })
    }

    const archives = (
      await Promise.all(
        entries
          .filter((f) => f.startsWith('apsamo-backup-') && f.endsWith('.tar.gz'))
          .map(async (name) => {
            try {
              const st = await fs.stat(path.join(BACKUP_DIR, name))
              return { name, bytes: st.size, at: st.mtime.toISOString() }
            } catch {
              return null
            }
          })
      )
    )
      .filter((a): a is { name: string; bytes: number; at: string } => a !== null)
      .sort((a, b) => (a.at < b.at ? 1 : -1))

    const newest = archives[0] || null
    const ageHours = newest
      ? (Date.now() - new Date(newest.at).getTime()) / 3_600_000
      : null

    // Written by apsamo-offsite-backup.sh on every run.
    let offsite: OffsiteStatus = {
      state: 'unknown',
      detail: 'The offsite replication job has never reported a result.',
    }
    try {
      const raw = await fs.readFile(
        path.join(BACKUP_DIR, '.offsite-status.json'),
        'utf8'
      )
      offsite = JSON.parse(raw) as OffsiteStatus
    } catch {
      /* no status file yet — the 'unknown' default above is the honest answer */
    }

    const warnings: string[] = []
    if (!newest) {
      warnings.push('No backup archives found — nothing is being backed up.')
    } else if (ageHours !== null && ageHours > STALE_AFTER_HOURS) {
      warnings.push(
        `Newest backup is ${Math.floor(ageHours)}h old — the nightly job may have stopped.`
      )
    }
    if (offsite.state !== 'ok') {
      warnings.push(
        offsite.state === 'not_configured' || offsite.state === 'disabled'
          ? 'Backups exist only on this VPS. Losing the server loses the backups too.'
          : `Offsite replication is not healthy: ${offsite.detail}`
      )
    }

    return NextResponse.json({
      configured: true,
      directory: BACKUP_DIR,
      archives: archives.slice(0, 20),
      count: archives.length,
      totalBytes: archives.reduce((s, a) => s + a.bytes, 0),
      newest,
      newestAgeHours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
      stale: ageHours !== null && ageHours > STALE_AFTER_HOURS,
      offsite,
      // The single honest answer to "are we protected against losing this box?"
      offsiteProtected: offsite.state === 'ok',
      warnings,
    })
  } catch (error) {
    console.error('[admin/backups] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


const BACKUP_SCRIPT = '/usr/local/bin/apsamo-full-backup.sh'

/**
 * POST /api/admin/backups — take a server backup now.
 *
 * Returns as soon as the job is launched, not when it finishes. Progress is
 * observed by polling GET: a fresh archive appears in the list and
 * newestAgeHours drops. The script appends to /var/log/apsamo-backup.log, which
 * is the authoritative record either way.
 */
async function postHandler(request: Request) {
  if (!(await requireAdminRole(request))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  const user = await authenticateRequest(request)

  try {
    await fs.access(BACKUP_SCRIPT)
  } catch {
    return NextResponse.json(
      {
        error: `The backup script is not installed at ${BACKUP_SCRIPT}.`,
        code: 'script_missing',
      },
      { status: 503 }
    )
  }

  // Detached and fully disowned: if the panel restarts mid-run — which a
  // backup taken before an upgrade makes quite likely — the job must survive
  // rather than leave a half-written snapshot.
  const child = spawn('/bin/bash', [BACKUP_SCRIPT], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  await logAudit({
    userId: user?.userId || 'system',
    action: 'admin.backup.started',
    resource: 'server',
    resourceId: 'full-backup',
    req: request,
    metadata: { script: BACKUP_SCRIPT, pid: child.pid },
  }).catch(() => {})

  return NextResponse.json(
    {
      ok: true,
      started: true,
      pid: child.pid,
      message:
        'Server backup started. It runs in the background — refresh in a minute ' +
        'to see the new archive. Progress is logged to /var/log/apsamo-backup.log.',
    },
    { status: 202 }
  )
}

// A full run is heavy: every tenant database plus the volume archive. Two per
// ten minutes is generous for a human and stops a stuck refresh button from
// queueing a dozen overlapping runs.
export const POST = withRateLimit(postHandler, { limit: 2, windowMs: 600_000 })
