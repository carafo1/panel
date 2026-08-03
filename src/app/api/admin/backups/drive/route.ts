/**
 * /api/admin/backups/drive
 *
 *   GET    — what is actually sitting in the connected Google Drive
 *   DELETE — remove one file from it (body: { fileId })
 *
 * The panel could upload to Drive and never show it again, so "is my backup
 * really there?" meant opening Drive in another tab. It also left no way to
 * clear the empty 105-byte archives produced before the createLocalBackup fix.
 *
 * Scoped to the ADMIN's destination, matching the offsite upload route: the
 * platform's archives go to an operator's account and this lists that same
 * account, never a customer's.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole, authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listFiles, deleteFile, driveConfig } from '@/lib/google-drive'

async function adminDestination() {
  const admins = await db.user.findMany({
    where: { role: { in: ['admin', 'super_admin'] } },
    select: { id: true },
  })
  return db.backupDestination.findFirst({
    where: {
      userId: { in: admins.map((a) => a.id) },
      provider: 'google_drive',
      enabled: true,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, accountEmail: true, folderName: true },
  })
}

export async function GET(request: Request) {
  if (!(await requireAdminRole(request))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }
  if (!driveConfig()) {
    return NextResponse.json({ configured: false, connected: false, files: [] })
  }

  const dest = await adminDestination()
  if (!dest) {
    return NextResponse.json({ configured: true, connected: false, files: [] })
  }

  const result = await listFiles(dest.id)
  return NextResponse.json({
    configured: true,
    connected: true,
    account: dest.accountEmail,
    folder: dest.folderName,
    // A listing failure is reported, not swallowed into an empty array — an
    // empty list and "we could not ask" mean very different things when the
    // question is whether backups exist.
    ok: result.ok,
    error: result.error,
    files: result.files,
    totalBytes: result.files.reduce((s, f) => s + f.bytes, 0),
  })
}

export async function DELETE(request: Request) {
  if (!(await requireAdminRole(request))) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = (await request.json().catch(() => null)) as { fileId?: string } | null
  if (!body || typeof body.fileId !== 'string' || !body.fileId.trim()) {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 })
  }

  const dest = await adminDestination()
  if (!dest) {
    return NextResponse.json({ error: 'No Google Drive is connected.' }, { status: 400 })
  }

  const result = await deleteFile(dest.id, body.fileId.trim())
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  const user = await authenticateRequest(request)
  await logAudit({
    userId: user?.userId || 'system',
    action: 'admin.backup.drive_deleted',
    resource: 'drive_file',
    resourceId: body.fileId.trim(),
    req: request,
    metadata: { account: dest.accountEmail },
  }).catch(() => {})

  return NextResponse.json({
    ok: true,
    message: 'Moved to the Google Drive bin — recoverable there for 30 days.',
  })
}
