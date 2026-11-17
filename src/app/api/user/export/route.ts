import { NextResponse } from 'next/server'
import { extractTokenFromHeader, verifyTokenFresh } from '@/lib/auth'
import { exportUserData } from '@/lib/account-deletion'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'

/**
 * GET /api/user/export — download everything the panel holds about you, as JSON
 * (no passwords, keys or other secrets). Not available during support access:
 * an admin viewing as a customer must not walk off with their data.
 */
async function getHandler(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  const auth = token ? await verifyTokenFresh(token) : null
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  if (auth.impersonatedBy) {
    return NextResponse.json({ error: 'Not available during support access' }, { status: 403 })
  }

  const data = await exportUserData(auth.userId)
  if (!data) return NextResponse.json({ error: 'Account not found' }, { status: 404 })

  await logAudit({ userId: auth.userId, action: 'user.data_exported', resource: 'user', resourceId: auth.userId, req: request }).catch(() => {})

  const day = new Date().toISOString().slice(0, 10)
  return new NextResponse(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="apsamo-data-${day}.json"`,
      'Cache-Control': 'no-store',
    },
  })
}

export const GET = withRateLimit(getHandler, { limit: 5, windowMs: 60_000 })
