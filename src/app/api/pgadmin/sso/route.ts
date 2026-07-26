/**
 * GET /api/pgadmin/sso?token=…
 *
 * Served on the pgAdmin host (Caddy routes `/apsamo-sso` here). Exchanges the
 * panel's short-lived hand-off token for a session cookie scoped to that host,
 * then drops the customer into pgAdmin. From here on, `/api/pgadmin/authorize`
 * is what actually gates every request.
 */
import { NextResponse } from 'next/server'
import { logAudit } from '@/lib/audit'
import {
  verifyHandoffToken,
  mintSessionToken,
  PGADMIN_COOKIE,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/db-engine/pgadmin-sso'

function errorPage(message: string, status: number): NextResponse {
  const safe = message.replace(/[<>&]/g, '')
  const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Session error</title>
<style>body{font:15px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#1E1A47;color:#fff;
display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
.card{max-width:32rem;background:rgba(255,255,255,.06);border:1px solid rgba(136,136,255,.35);
border-radius:14px;padding:28px;text-align:center}h1{font-size:1.15rem;margin:0 0 .5rem}
p{margin:.4rem 0;color:#d7d6f0}a{display:inline-block;margin-top:.75rem;background:#706FD3;color:#fff;
padding:.5rem 1rem;border-radius:8px;text-decoration:none;font-weight:600}a:hover{background:#8888FF}</style>
<div class="card"><h1>Could not open pgAdmin</h1><p>${safe}</p>
<p>Please return to the panel and click <strong>Open pgAdmin</strong> again.</p>
<a href="${process.env.APP_URL || 'https://panel.apsamo.com'}">Back to Apsamo Panel</a></div>`
  return new NextResponse(html, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get('token') || ''
  if (!token) return errorPage('This link is missing its session token.', 400)

  const payload = verifyHandoffToken(token)
  if (!payload) {
    return errorPage('This session link has expired. Links are valid for 60 seconds.', 401)
  }

  await logAudit({
    userId: payload.uid,
    action: 'db.pgadmin.session',
    resource: 'database',
    req: request,
    metadata: { pgAdminUser: payload.pu },
  })

  const session = mintSessionToken(payload.pu, payload.uid)
  // A RELATIVE redirect on purpose: this route is proxied onto the pgAdmin
  // host, so building an absolute URL from `request.url` would send the
  // customer to the panel's internal address instead of staying on pgAdmin.
  const res = new NextResponse(null, {
    status: 302,
    headers: { Location: '/browser/' },
  })
  // Secure is driven by the actual scheme: production always serves pgAdmin
  // over HTTPS (so the flag is set), while a plain-HTTP dev host would silently
  // drop a Secure cookie and break the hand-off.
  const proto =
    request.headers.get('x-forwarded-proto') || new URL(request.url).protocol.replace(':', '')
  res.cookies.set(PGADMIN_COOKIE, session, {
    httpOnly: true,
    secure: proto === 'https',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
  res.headers.set('Cache-Control', 'no-store')
  return res
}
