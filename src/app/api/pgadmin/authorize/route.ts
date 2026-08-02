/**
 * GET /api/pgadmin/authorize
 *
 * Caddy `forward_auth` target for the pgAdmin host. Caddy replays each incoming
 * request here; a 2xx means "let it through" and Caddy copies `X-Remote-User`
 * onto the upstream request, which is what pgAdmin's webserver auth trusts.
 * Anything else is returned to the client as-is.
 *
 * This endpoint is the ONLY thing that decides a pgAdmin identity, so the
 * header must never be honoured from the client — Caddy sets it from this
 * response, replacing whatever the client sent.
 */
import { NextResponse } from 'next/server'
import { verifySessionToken, PGADMIN_COOKIE } from '@/lib/db-engine/pgadmin-sso'

export async function GET(request: Request) {
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${PGADMIN_COOKIE}=`))
    ?.slice(PGADMIN_COOKIE.length + 1)

  const payload = cookie ? verifySessionToken(decodeURIComponent(cookie)) : null

  if (!payload) {
    // No valid session: send the customer back to the panel rather than
    // showing pgAdmin's own login form (which they have no credentials for).
    const panel = process.env.APP_URL || 'https://panel.apsamo.com'
    return NextResponse.json(
      { error: 'pgAdmin session expired' },
      {
        status: 302,
        headers: { Location: `${panel}/dashboard`, 'Cache-Control': 'no-store' },
      }
    )
  }

  return new NextResponse(null, {
    status: 200,
    headers: {
      'X-Remote-User': payload.pu,
      'Cache-Control': 'no-store',
    },
  })
}
