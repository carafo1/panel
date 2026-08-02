/**
 * /api/admin/backups/offsite — ship the platform's own backup to Google Drive.
 *
 * The customer-facing feature covers customer site backups. This covers the
 * PLATFORM: the panel database, every tenant database dump, the volume archive
 * and the mailcow config — currently 1.4 GB that exists only on this VPS.
 *
 * Reuses the Drive connection a super-admin already made through the panel
 * rather than adding a second credential path. The bash offsite script cannot
 * do this itself: the refresh token is AES-256-GCM encrypted in the database
 * with the app's key, which only the app can decrypt.
 *
 * SECURITY — the panel archive contains .env: JWT_SECRET, ENCRYPTION_KEY,
 * STRIPE_SECRET_KEY, DYNADOT keys, SMTP_PASS. It is encrypted with the offsite
 * passphrase BEFORE upload, exactly as apsamo-offsite-backup.sh does, and this
 * route refuses to run without that passphrase. Never relax that: it would
 * trade a total credential compromise for a little convenience.
 *
 * Callable by a super-admin from the panel, or by cron with x-cron-key.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { uploadBackup, driveConfig } from '@/lib/google-drive'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import os from 'os'

const execFileAsync = promisify(execFile)
const BACKUP_DIR = process.env.BACKUP_DIR || '/opt/apsamo/backups'
const OFFSITE_CONFIG = '/etc/apsamo/offsite.env'

/** Read OFFSITE_PASSPHRASE without pulling the whole file into a response. */
async function offsitePassphrase(): Promise<string | null> {
  try {
    const raw = await fs.readFile(OFFSITE_CONFIG, 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*OFFSITE_PASSPHRASE\s*=\s*(.+)\s*$/)
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, '')
        return v || null
      }
    }
  } catch {
    // Missing config is a "not set up" answer, not an error.
  }
  return null
}

function authorised(request: Request): boolean {
  const key = process.env.CRON_API_KEY
  const sent = request.headers.get('x-cron-key')
  return Boolean(key && sent && sent === key)
}

export async function POST(request: Request) {
  const viaCron = authorised(request)
  if (!viaCron && !(await requireAdminRole(request))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  if (!driveConfig()) {
    return NextResponse.json(
      { error: 'Google Drive is not configured on this platform.', code: 'not_configured' },
      { status: 503 }
    )
  }

  // Whose Drive? The platform's backups go to an operator's account, so only an
  // admin destination qualifies — never a customer's.
  const admins = await db.user.findMany({
    where: { role: { in: ['admin', 'super_admin'] } },
    select: { id: true },
  })
  const dest = await db.backupDestination.findFirst({
    where: {
      userId: { in: admins.map((a) => a.id) },
      provider: 'google_drive',
      enabled: true,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, userId: true, accountEmail: true },
  })
  if (!dest) {
    return NextResponse.json(
      {
        error:
          'No administrator has connected a Google Drive yet. Connect one from ' +
          'a site’s Backups tab, then run this again.',
        code: 'no_destination',
      },
      { status: 400 }
    )
  }

  const passphrase = await offsitePassphrase()
  if (!passphrase) {
    return NextResponse.json(
      {
        error:
          `OFFSITE_PASSPHRASE is not set in ${OFFSITE_CONFIG}. The archive contains ` +
          '.env (JWT_SECRET, ENCRYPTION_KEY, STRIPE_SECRET_KEY, SMTP_PASS) and will ' +
          'not be uploaded unencrypted.',
        code: 'no_passphrase',
      },
      { status: 400 }
    )
  }

  // Newest panel archive.
  let newest: { name: string; full: string; mtime: number } | null = null
  try {
    for (const name of await fs.readdir(BACKUP_DIR)) {
      if (!name.endsWith('.tar.gz')) continue
      const full = path.join(BACKUP_DIR, name)
      const st = await fs.stat(full)
      if (!newest || st.mtimeMs > newest.mtime) newest = { name, full, mtime: st.mtimeMs }
    }
  } catch {
    return NextResponse.json(
      { error: `Backup directory ${BACKUP_DIR} is not readable.`, code: 'unreadable' },
      { status: 500 }
    )
  }
  if (!newest) {
    return NextResponse.json(
      { error: 'There are no backup archives to upload yet.', code: 'no_archives' },
      { status: 400 }
    )
  }

  // Encrypt to a temp file with the same parameters the bash script uses, so
  // either tool can decrypt whatever the other produced.
  const enc = path.join(os.tmpdir(), `${newest.name}.enc`)
  try {
    await execFileAsync('openssl', [
      'enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt',
      '-in', newest.full,
      '-out', enc,
      '-pass', `pass:${passphrase}`,
    ])
  } catch (err) {
    return NextResponse.json(
      { error: `Encryption failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }

  try {
    const content = await fs.readFile(enc)
    const result = await uploadBackup(dest.id, `${newest.name}.enc`, content)

    await logAudit({
      userId: dest.userId,
      action: 'admin.backup.offsite',
      resource: 'server',
      resourceId: newest.name,
      req: request,
      metadata: {
        ok: result.ok,
        bytes: result.bytes,
        account: dest.accountEmail,
        viaCron,
        error: result.error,
      },
    }).catch(() => {})

    if (!result.ok) {
      return NextResponse.json({ error: result.error, archive: newest.name }, { status: 502 })
    }
    return NextResponse.json({
      ok: true,
      archive: `${newest.name}.enc`,
      bytes: result.bytes,
      account: dest.accountEmail,
      message: `Uploaded ${newest.name}.enc to ${dest.accountEmail || 'Google Drive'}.`,
    })
  } finally {
    // The plaintext-adjacent temp file must not linger regardless of outcome.
    await fs.unlink(enc).catch(() => {})
  }
}
