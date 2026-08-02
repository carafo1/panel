/**
 * /api/backups/google
 *
 *   GET    — is Drive backup available, and is this customer connected?
 *   POST   — start the OAuth flow; returns the URL to send the customer to.
 *   DELETE — disconnect and revoke the grant at Google.
 *
 * Never returns tokens. The refresh token is the entire credential and there
 * is no reason for a browser to ever see it.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { withRateLimit } from '@/lib/rate-limit'
import { logAudit } from '@/lib/audit'
import { driveConfig, authorizeUrl, disconnect } from '@/lib/google-drive'
import { signState } from '@/lib/oauth-state'

async function getHandler(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const configured = driveConfig() !== null
  const dest = await db.backupDestination.findUnique({
    where: { userId_provider: { userId: user.userId, provider: 'google_drive' } },
    // Explicit select: the token columns must not leak into a response by
    // someone later adding `include` or dropping the select.
    select: {
      id: true,
      accountEmail: true,
      folderName: true,
      enabled: true,
      lastStatus: true,
      lastError: true,
      lastSyncAt: true,
      bytesStored: true,
      createdAt: true,
    },
  })

  return NextResponse.json({
    configured,
    reason: configured
      ? undefined
      : 'Google Drive backup has not been set up on this platform yet.',
    connected: Boolean(dest),
    destination: dest
      ? { ...dest, bytesStored: Number(dest.bytesStored) }
      : null,
  })
}

async function postHandler(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  if (!driveConfig()) {
    return NextResponse.json(
      { error: 'Google Drive backup has not been set up on this platform yet.' },
      { status: 503 }
    )
  }

  const url = authorizeUrl(signState(user.userId))
  if (!url) {
    return NextResponse.json({ error: 'Could not build the Google sign-in URL.' }, { status: 500 })
  }
  return NextResponse.json({ url })
}

async function deleteHandler(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })

  const dest = await db.backupDestination.findUnique({
    where: { userId_provider: { userId: user.userId, provider: 'google_drive' } },
    select: { id: true },
  })
  if (!dest) return NextResponse.json({ ok: true, message: 'Nothing was connected.' })

  await disconnect(dest.id)
  await logAudit({
    userId: user.userId,
    action: 'backup.destination.disconnected',
    resource: 'backup_destination',
    resourceId: dest.id,
    req: request,
    metadata: { provider: 'google_drive' },
  }).catch(() => {})

  return NextResponse.json({ ok: true, message: 'Google Drive disconnected.' })
}

export const GET = getHandler
export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })
export const DELETE = withRateLimit(deleteHandler, { limit: 10, windowMs: 60_000 })
