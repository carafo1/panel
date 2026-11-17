import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { extractTokenFromHeader, verifyTokenFresh, verifyPassword } from '@/lib/auth'
import { verifyToken as verifyTotp } from '@/lib/totp'
import { deletionBlockers, deleteAccount } from '@/lib/account-deletion'
import { logAudit } from '@/lib/audit'
import { sendEmail } from '@/lib/email'
import { clearSession, clearSupportReturn, requestSource } from '@/lib/session'
import { withRateLimit } from '@/lib/rate-limit'

/**
 * GET  /api/user/delete-account   what would stop deletion right now
 * POST /api/user/delete-account   { password, code?, confirm: "DELETE" }
 *
 * Permanently deletes the signed-in account (lib/account-deletion). Requires
 * the password — and the 2FA code when 2FA is on — so a stolen session alone
 * cannot do it. Only from the panel itself, never during support access.
 */

async function current(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  return token ? verifyTokenFresh(token) : null
}

export async function GET(request: Request) {
  const auth = await current(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  return NextResponse.json({ blockers: await deletionBlockers(auth.userId) }, { headers: { 'Cache-Control': 'no-store' } })
}

async function postHandler(request: Request) {
  const auth = await current(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  if (auth.impersonatedBy) return NextResponse.json({ error: 'Not available during support access' }, { status: 403 })
  if (requestSource(request) === 'foreign') return NextResponse.json({ error: 'Not allowed' }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as { password?: string; code?: string; confirm?: string }
  if (body.confirm !== 'DELETE') {
    return NextResponse.json({ error: 'Type DELETE to confirm.' }, { status: 400 })
  }

  const user = await db.user.findUnique({
    where: { id: auth.userId },
    select: { email: true, name: true, password: true, twoFactorEnabled: true, twoFactorSecret: true },
  })
  if (!user) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  if (!body.password || !(await verifyPassword(body.password, user.password))) {
    await logAudit({ userId: auth.userId, action: 'user.account_delete_failed', resource: 'user', resourceId: auth.userId, req: request, status: 'failure', metadata: { reason: 'bad_password' } }).catch(() => {})
    return NextResponse.json({ error: 'Your password is incorrect.' }, { status: 400 })
  }
  if (user.twoFactorEnabled && user.twoFactorSecret) {
    // Same check as the 2FA sign-in step (api/auth/2fa/login-verify).
    if (!body.code || !verifyTotp(body.code, user.twoFactorSecret)) {
      return NextResponse.json({ error: 'Enter the 6-digit code from your authenticator app.' }, { status: 400 })
    }
  }

  const blockers = await deletionBlockers(auth.userId)
  if (blockers.length) return NextResponse.json({ error: blockers[0], blockers }, { status: 409 })

  // Tell them before the address is erased.
  await sendEmail({
    to: user.email,
    subject: 'Your Apsamo account has been deleted',
    html: `<p>Hello ${user.name.replace(/[<>&]/g, '')},</p><p>Your account and its websites, email hosting and personal details have been deleted, as you asked. Invoices are kept, without your name, because financial records must be retained.</p><p>If you did not do this, contact support immediately.</p>`,
  }).catch(() => {})

  const { warnings } = await deleteAccount(auth.userId)

  await logAudit({
    userId: auth.userId,
    action: 'user.account_deleted',
    resource: 'user',
    resourceId: auth.userId,
    req: request,
    metadata: { cleanupWarnings: warnings.slice(0, 20) },
  }).catch(() => {})

  return clearSupportReturn(clearSession(NextResponse.json({ deleted: true })))
}

export const POST = withRateLimit(postHandler, { limit: 5, windowMs: 60_000 })
