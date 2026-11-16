/**
 * Login sessions: httpOnly cookie, cross-site protection, CSP, and which
 * tokens count as a login.
 *
 * Before this change the 7-day login token sat in localStorage (readable by
 * any script on the page), and every short-lived token signed with the same
 * secret — the "password OK, 2FA pending" token, the GitHub OAuth state — was
 * accepted as a full login, so 2FA could be skipped with the password alone.
 * A backup code also logged in with no password at all.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import jwt from 'jsonwebtoken'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, generateTwoFactorTempToken, generateRealtimeToken } from '@/lib/auth'
import { generateBackupCodes, hashBackupCodes } from '@/lib/totp'
import { sessionCookieName, requestSource, cookieAuthAllowed } from '@/lib/session'
import { proxy } from '@/proxy'
import * as me from '@/app/api/auth/me/route'
import * as login from '@/app/api/auth/login/route'
import * as logout from '@/app/api/auth/logout/route'
import * as backup from '@/app/api/auth/2fa/verify-backup/route'
import * as realtimeToken from '@/app/api/auth/realtime-token/route'
import * as authorize from '@/app/api/realtime/authorize/route'
import * as sessionUpgrade from '@/app/api/auth/session/route'
import { makeUser, authed, uid } from './helpers'

const HOST = 'panel.example.test'
let reqSeq = 0
const SECRET = process.env.JWT_SECRET!

type U = Awaited<ReturnType<typeof makeUser>>
let alice: U
let bob: U

beforeAll(async () => {
  alice = await makeUser('sess-alice')
  bob = await makeUser('sess-bob')
})

/** A request as the browser would send it to the panel. */
function browserReq(
  path: string,
  opts: { method?: string; site?: string; mode?: string; origin?: string; cookie?: string; auth?: string; body?: unknown } = {}
) {
  // A distinct client IP per request, so the login rate limit isn't what's being tested.
  const headers: Record<string, string> = { host: HOST, 'x-forwarded-for': `10.99.${++reqSeq & 255}.${(reqSeq >> 8) & 255}` }
  if (opts.site) headers['sec-fetch-site'] = opts.site
  if (opts.mode) headers['sec-fetch-mode'] = opts.mode
  if (opts.origin) headers.origin = opts.origin
  if (opts.cookie) headers.cookie = opts.cookie
  if (opts.auth) headers.authorization = opts.auth
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  return new NextRequest(`https://${HOST}${path}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
}

/** What Authorization header the proxy hands to the route (null = none). */
async function authSeenByRoute(req: NextRequest): Promise<string | null> {
  const res = await proxy(req)
  const overridden = (res.headers.get('x-middleware-override-headers') || '').split(',')
  if (!overridden.includes('authorization')) return null
  return res.headers.get('x-middleware-request-authorization')
}

const cookieFor = (token: string) => `${sessionCookieName()}=${token}`

describe('only real session tokens count as a login', () => {
  it('rejects the 2FA-pending token (password alone must not skip 2FA)', async () => {
    const temp = generateTwoFactorTempToken(alice.id)
    const res = await me.GET(authed(temp, '/api/auth/me'))
    expect(res.status).toBe(401)
  })

  it('rejects a GitHub OAuth state token', async () => {
    const state = jwt.sign({ userId: alice.id, kind: 'github-oauth' }, SECRET, { expiresIn: '10m' })
    const res = await me.GET(authed(state, '/api/auth/me'))
    expect(res.status).toBe(401)
  })

  it('rejects the realtime token everywhere except the realtime check', async () => {
    const rt = generateRealtimeToken(alice.id)
    expect((await me.GET(authed(rt, '/api/auth/me'))).status).toBe(401)

    const own = await authorize.POST(
      authed(rt, '/api/realtime/authorize', { method: 'POST', body: JSON.stringify({ room: `user:${alice.id}` }) })
    )
    expect(own.status).toBe(200)
    const other = await authorize.POST(
      authed(rt, '/api/realtime/authorize', { method: 'POST', body: JSON.stringify({ room: `user:${bob.id}` }) })
    )
    expect(other.status).toBe(403)
  })

  it('still accepts a normal login token', async () => {
    expect((await me.GET(authed(alice.token, '/api/auth/me'))).status).toBe(200)
  })

  it('issues a realtime token only to a signed-in user', async () => {
    expect((await realtimeToken.GET(authed(null, '/api/auth/realtime-token'))).status).toBe(401)
    const res = await realtimeToken.GET(authed(alice.token, '/api/auth/realtime-token'))
    expect(res.status).toBe(200)
    expect(typeof (await res.json()).token).toBe('string')
  })
})

describe('login sets an httpOnly session cookie', () => {
  let email: string
  const password = 'Corr3ct-Horse-Battery'

  beforeAll(async () => {
    email = `${uid('login')}@example.test`
    await db.user.create({
      data: { email, name: 'Login', password: await hashPassword(password), role: 'user', emailVerified: true },
    })
  })

  it('sets HttpOnly, SameSite=Lax, Path=/ for a request from the panel', async () => {
    const res = await login.POST(
      browserReq('/api/auth/login', { method: 'POST', site: 'same-origin', origin: `https://${HOST}`, body: { email, password } })
    )
    expect(res.status).toBe(200)
    const cookie = res.headers.get('set-cookie') || ''
    expect(cookie).toContain(`${sessionCookieName()}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
  })

  it('does NOT set the cookie for a login posted from another site (login CSRF)', async () => {
    const res = await login.POST(
      browserReq('/api/auth/login', { method: 'POST', site: 'cross-site', origin: 'https://evil.example', body: { email, password } })
    )
    expect(res.status).toBe(200) // credentials were right…
    expect(res.headers.get('set-cookie')).toBeNull() // …but no session is planted
  })

  it('logout clears the cookie', async () => {
    const res = await logout.POST(authed(alice.token, '/api/auth/logout', { method: 'POST' }))
    const cookie = res.headers.get('set-cookie') || ''
    expect(cookie).toContain(`${sessionCookieName()}=;`)
    expect(cookie).toContain('Max-Age=0')
  })
})

describe('backup codes replace the second factor, not the password', () => {
  let userId: string
  let email: string
  let codes: string[]

  beforeAll(async () => {
    email = `${uid('backup')}@example.test`
    codes = generateBackupCodes(3)
    const u = await db.user.create({
      data: {
        email,
        name: 'Backup',
        password: await hashPassword('irrelevant-123'),
        role: 'user',
        twoFactorEnabled: true,
        twoFactorSecret: 'JBSWY3DPEHPK3PXP',
        twoFactorBackupCodes: await hashBackupCodes(codes),
      },
    })
    userId = u.id
  })

  const post = (body: unknown) =>
    backup.POST(browserReq('/api/auth/2fa/verify-backup', { method: 'POST', site: 'same-origin', body }))

  it('refuses email + backup code without the password step', async () => {
    const res = await post({ email, backupCode: codes[0] })
    expect(res.status).toBe(400)
    // and the code was NOT consumed
    const ok = await post({ tempToken: generateTwoFactorTempToken(userId), backupCode: codes[0] })
    expect(ok.status).toBe(200)
  })

  it('accepts the password-step token + a code, once', async () => {
    const temp = generateTwoFactorTempToken(userId)
    const first = await post({ tempToken: temp, backupCode: codes[1] })
    expect(first.status).toBe(200)
    expect(first.headers.get('set-cookie') || '').toContain('HttpOnly')
    const again = await post({ tempToken: temp, backupCode: codes[1] })
    expect(again.status).toBe(401)
  })

  it('refuses a forged or expired step-one token', async () => {
    const forged = jwt.sign({ userId, kind: '2fa-temp' }, 'not-the-secret', { expiresIn: '5m' })
    expect((await post({ tempToken: forged, backupCode: codes[2] })).status).toBe(401)
  })
})

describe('proxy: session cookie → Authorization, only from the panel itself', () => {
  it('uses the cookie for the panel’s own requests', async () => {
    const auth = await authSeenByRoute(browserReq('/api/hosting', { site: 'same-origin', cookie: cookieFor(alice.token) }))
    expect(auth).toBe(`Bearer ${alice.token}`)
  })

  it('ignores the cookie for a state change from another site', async () => {
    const auth = await authSeenByRoute(
      browserReq('/api/hosting', { method: 'POST', site: 'cross-site', origin: 'https://evil.example', cookie: cookieFor(alice.token) })
    )
    expect(auth).toBeNull()
  })

  it('ignores the cookie for script requests from a customer site on a subdomain', async () => {
    const auth = await authSeenByRoute(
      browserReq('/api/hosting', { method: 'GET', site: 'same-site', mode: 'cors', origin: `https://shop.${HOST}`, cookie: cookieFor(alice.token) })
    )
    expect(auth).toBeNull()
    const post = await authSeenByRoute(
      browserReq('/api/hosting', { method: 'DELETE', site: 'same-site', mode: 'cors', origin: `https://shop.${HOST}`, cookie: cookieFor(alice.token) })
    )
    expect(post).toBeNull()
  })

  it('allows a plain link navigation (e.g. opening an invoice PDF)', async () => {
    const auth = await authSeenByRoute(
      browserReq('/api/invoices/x/pdf', { site: 'same-site', mode: 'navigate', cookie: cookieFor(alice.token) })
    )
    expect(auth).toBe(`Bearer ${alice.token}`)
  })

  it('without Fetch Metadata, requires a matching Origin for state changes', async () => {
    expect(
      await authSeenByRoute(browserReq('/api/hosting', { method: 'POST', origin: `https://${HOST}`, cookie: cookieFor(alice.token) }))
    ).toBe(`Bearer ${alice.token}`)
    expect(
      await authSeenByRoute(browserReq('/api/hosting', { method: 'POST', cookie: cookieFor(alice.token) }))
    ).toBeNull()
  })

  it('an explicit bearer token or API key wins over the cookie', async () => {
    const auth = await authSeenByRoute(
      browserReq('/api/hosting', { site: 'same-origin', auth: `Bearer ${bob.token}`, cookie: cookieFor(alice.token) })
    )
    expect(auth).toBe(`Bearer ${bob.token}`) // the explicit header, untouched
  })

  it('a leftover "Bearer null" from old client code does not shadow the cookie', async () => {
    const auth = await authSeenByRoute(
      browserReq('/api/hosting', { site: 'same-origin', auth: 'Bearer null', cookie: cookieFor(alice.token) })
    )
    expect(auth).toBe(`Bearer ${alice.token}`)
  })
})

describe('upgrading a browser that still has a pre-cookie token', () => {
  it('trades a valid token for the cookie, from the panel only', async () => {
    const ok = await sessionUpgrade.POST(
      browserReq('/api/auth/session', { method: 'POST', site: 'same-origin', auth: `Bearer ${alice.token}` })
    )
    expect(ok.status).toBe(200)
    expect(ok.headers.get('set-cookie') || '').toContain('HttpOnly')

    const foreign = await sessionUpgrade.POST(
      browserReq('/api/auth/session', { method: 'POST', site: 'cross-site', auth: `Bearer ${alice.token}` })
    )
    expect(foreign.status).toBe(403)

    const bad = await sessionUpgrade.POST(
      browserReq('/api/auth/session', { method: 'POST', site: 'same-origin', auth: 'Bearer not-a-token' })
    )
    expect(bad.status).toBe(401)
  })
})

describe('Content-Security-Policy on pages', () => {
  it('sends a nonce-based policy and hands the nonce to the renderer', async () => {
    const res = await proxy(browserReq('/', { site: 'none', mode: 'navigate' }))
    const csp = res.headers.get('content-security-policy') || ''
    const nonce = res.headers.get('x-middleware-request-x-nonce')
    expect(nonce).toBeTruthy()
    expect(csp).toContain(`'nonce-${nonce}'`)
    expect(csp).toContain("'strict-dynamic'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'self'")
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  })

  it('uses a fresh nonce for every request', async () => {
    const a = (await proxy(browserReq('/'))).headers.get('x-middleware-request-x-nonce')
    const b = (await proxy(browserReq('/'))).headers.get('x-middleware-request-x-nonce')
    expect(a).not.toBe(b)
  })
})

describe('requestSource / cookieAuthAllowed edge cases', () => {
  const r = (h: Record<string, string>, method = 'GET') => ({ headers: new Headers({ host: HOST, ...h }), method })
  it('treats Origin "null" (sandboxed frame, file://) as foreign', () => {
    expect(requestSource(r({ origin: 'null' }))).toBe('foreign')
  })
  it('a typed URL / bookmark (no metadata) may read but not change state', () => {
    expect(cookieAuthAllowed(r({}, 'GET'))).toBe(true)
    expect(cookieAuthAllowed(r({}, 'POST'))).toBe(false)
  })
})
