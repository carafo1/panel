/**
 * Session revocation: signing out ends a token for real.
 *
 * A login JWT used to stay valid for its full 7 days whatever happened —
 * signing out only deleted the browser's copy, and changing a password left
 * existing logins (including an attacker's) in place. Every login is now a
 * Session row the token points to, and `User.sessionsRevokedAt` cuts off every
 * older token at once.
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { NextRequest } from 'next/server'
import { db } from '@/lib/db'
import { hashPassword, generateToken, generateRealtimeToken, sessionIdOf } from '@/lib/auth'
import { sessionCookieName } from '@/lib/session'
import { issuePasswordResetToken } from '@/lib/password-reset'
import * as me from '@/app/api/auth/me/route'
import * as login from '@/app/api/auth/login/route'
import * as logout from '@/app/api/auth/logout/route'
import * as sessions from '@/app/api/auth/sessions/route'
import * as oneSession from '@/app/api/auth/sessions/[id]/route'
import * as password from '@/app/api/user/password/route'
import * as resetPassword from '@/app/api/auth/reset-password/route'
import * as adminRevoke from '@/app/api/admin/users/[userId]/sessions/route'
import * as adminUsers from '@/app/api/admin/users/route'
import * as impersonate from '@/app/api/admin/impersonate/route'
import * as authorize from '@/app/api/realtime/authorize/route'
import * as hosting from '@/app/api/hosting/route'
import { makeUser, authed, params, uid } from './helpers'

const PASSWORD = 'Sess10n-Test-Pass!'
let loginSeq = 0

/** A real login through the login route; returns the session token. */
async function signIn(email: string, password = PASSWORD, ua = 'Mozilla/5.0 (Windows NT 10.0) Chrome/130') {
  const res = await login.POST(
    new NextRequest('http://panel.test/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': ua,
        'sec-fetch-site': 'same-origin',
        host: 'panel.test',
        // a distinct client per sign-in, so the login rate limit (10/min/IP) isn't the thing under test
        'x-forwarded-for': `10.${(++loginSeq >> 8) & 255}.${loginSeq & 255}.7`,
      },
      body: JSON.stringify({ email, password }),
    })
  )
  expect(res.status).toBe(200)
  return (await res.json()).token as string
}

async function makeAccount(tag: string, role = 'user') {
  const email = `${uid(tag)}@example.test`
  const user = await db.user.create({
    data: { email, name: tag, password: await hashPassword(PASSWORD), role, emailVerified: true },
  })
  return { ...user, email }
}

const status = async (token: string) => (await me.GET(authed(token, '/api/auth/me'))).status

/** The token inside a Set-Cookie header. */
function cookieToken(res: Response): string {
  const m = new RegExp(`${sessionCookieName()}=([^;]+)`).exec(res.headers.get('set-cookie') || '')
  expect(m).not.toBeNull()
  return m![1]
}

describe('signing out ends that session everywhere', () => {
  it('a token stops working after logout, even a copy used elsewhere', async () => {
    const u = await makeAccount('logout')
    const token = await signIn(u.email)
    expect(sessionIdOf(token)).toBeTruthy()
    expect(await status(token)).toBe(200)

    await logout.POST(authed(token, '/api/auth/logout', { method: 'POST' }))

    expect(await status(token)).toBe(401)
    // …including routes that use authenticateRequest (it used to skip all checks)
    expect((await hosting.GET(authed(token, '/api/hosting'))).status).toBe(401)
  })

  it('logging out one device leaves the others signed in', async () => {
    const u = await makeAccount('two-devices')
    const laptop = await signIn(u.email)
    const phone = await signIn(u.email, PASSWORD, 'Mozilla/5.0 (iPhone) Safari/604')
    await logout.POST(authed(laptop, '/api/auth/logout', { method: 'POST' }))
    expect(await status(laptop)).toBe(401)
    expect(await status(phone)).toBe(200)
  })

  it('live-update tokens die with their session', async () => {
    const u = await makeAccount('realtime')
    const token = await signIn(u.email)
    const rt = generateRealtimeToken(u.id, sessionIdOf(token))
    const ask = () =>
      authorize.POST(authed(rt, '/api/realtime/authorize', { method: 'POST', body: JSON.stringify({ room: `user:${u.id}` }) }))
    expect((await ask()).status).toBe(200)
    await logout.POST(authed(token, '/api/auth/logout', { method: 'POST' }))
    expect((await ask()).status).toBe(401)
  })
})

describe('Settings → Active sessions', () => {
  it('lists my devices and marks the current one', async () => {
    const u = await makeAccount('list')
    const a = await signIn(u.email)
    await signIn(u.email, PASSWORD, 'Mozilla/5.0 (iPhone) Safari/604')
    const res = await sessions.GET(authed(a, '/api/auth/sessions'))
    const body = await res.json()
    expect(body.sessions).toHaveLength(2)
    expect(body.sessions.filter((s: { current: boolean }) => s.current)).toHaveLength(1)
    expect(body.sessions.some((s: { userAgent: string }) => s.userAgent.includes('iPhone'))).toBe(true)
  })

  it('signs out one chosen device; cannot touch another user’s session', async () => {
    const u = await makeAccount('pick')
    const a = await signIn(u.email)
    const b = await signIn(u.email)
    const sidB = sessionIdOf(b)!
    const res = await oneSession.DELETE(authed(a, `/api/auth/sessions/${sidB}`, { method: 'DELETE' }), params({ id: sidB }))
    expect(res.status).toBe(200)
    expect(await status(b)).toBe(401)
    expect(await status(a)).toBe(200)

    const stranger = await makeAccount('stranger')
    const s = await signIn(stranger.email)
    const sidA = sessionIdOf(a)!
    const foreign = await oneSession.DELETE(authed(s, `/api/auth/sessions/${sidA}`, { method: 'DELETE' }), params({ id: sidA }))
    expect(foreign.status).toBe(404)
    expect(await status(a)).toBe(200)
  })

  it('"sign out all other devices" keeps this device on a fresh session and ends everything else — including pre-session tokens', async () => {
    const u = await makeAccount('everywhere')
    const current = await signIn(u.email)
    const other = await signIn(u.email)
    const legacy = generateToken({ userId: u.id, email: u.email, role: u.role }) // no sid, like tokens from before this change
    await new Promise((r) => setTimeout(r, 1100)) // tokens above are from an earlier second than the cutoff
    expect(await status(legacy)).toBe(200)

    const res = await sessions.DELETE(authed(current, '/api/auth/sessions', { method: 'DELETE' }))
    expect(res.status).toBe(200)
    const fresh = cookieToken(res)

    expect(await status(fresh)).toBe(200)
    expect(await status(current)).toBe(401)
    expect(await status(other)).toBe(401)
    expect(await status(legacy)).toBe(401)
  })
})

describe('password changes end other logins', () => {
  it('changing the password signs out every other device, keeps this one', async () => {
    const u = await makeAccount('pwchange')
    const here = await signIn(u.email)
    const attacker = await signIn(u.email)
    const res = await password.PATCH(
      authed(here, '/api/user/password', {
        method: 'PATCH',
        headers: { 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'A-brand-new-Pass-42' }),
      })
    )
    expect(res.status).toBe(200)
    expect(await status(attacker)).toBe(401)
    expect(await status(cookieToken(res))).toBe(200)
  })

  it('a password reset signs out every device', async () => {
    const u = await makeAccount('pwreset')
    const token = await signIn(u.email)
    await new Promise((r) => setTimeout(r, 1100))
    const resetToken = await issuePasswordResetToken(u.id)
    const res = await resetPassword.POST(
      authed(null, '/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token: resetToken, newPassword: 'Reset-Pass-1234' }),
      })
    )
    expect(res.status).toBe(200)
    expect(await status(token)).toBe(401)
  })
})

describe('admin actions', () => {
  let admin: Awaited<ReturnType<typeof makeUser>>
  let superAdmin: Awaited<ReturnType<typeof makeUser>>
  beforeAll(async () => {
    admin = await makeUser('sess-admin', 'admin')
    superAdmin = await makeUser('sess-super', 'super_admin')
  })

  it('an admin can sign a customer out everywhere', async () => {
    const u = await makeAccount('victim')
    const token = await signIn(u.email)
    const res = await adminRevoke.POST(authed(admin.token, `/api/admin/users/${u.id}/sessions`, { method: 'POST' }), params({ userId: u.id }))
    expect(res.status).toBe(200)
    expect(await status(token)).toBe(401)
  })

  it('only a super admin can sign out another admin; customers cannot use it', async () => {
    const otherAdmin = await makeAccount('other-admin', 'admin')
    const asAdmin = await adminRevoke.POST(
      authed(admin.token, `/api/admin/users/${otherAdmin.id}/sessions`, { method: 'POST' }),
      params({ userId: otherAdmin.id })
    )
    expect(asAdmin.status).toBe(403)
    const asSuper = await adminRevoke.POST(
      authed(superAdmin.token, `/api/admin/users/${otherAdmin.id}/sessions`, { method: 'POST' }),
      params({ userId: otherAdmin.id })
    )
    expect(asSuper.status).toBe(200)

    const customer = await makeAccount('nosy')
    const ct = await signIn(customer.email)
    const asCustomer = await adminRevoke.POST(
      authed(ct, `/api/admin/users/${otherAdmin.id}/sessions`, { method: 'POST' }),
      params({ userId: otherAdmin.id })
    )
    expect(asCustomer.status).toBe(403)
  })

  it('suspending an account ends its logins for good — reactivating does not revive them', async () => {
    const u = await makeAccount('suspend')
    const token = await signIn(u.email)
    const patch = (s: string) =>
      adminUsers.PATCH(authed(superAdmin.token, '/api/admin/users', { method: 'PATCH', body: JSON.stringify({ userId: u.id, status: s, reason: 'test' }) }))
    expect((await patch('suspended')).status).toBe(200)
    expect((await patch('active')).status).toBe(200)
    expect(await status(token)).toBe(401)
  })

  it('support access is a real 1-hour session the customer can see and end', async () => {
    const u = await makeAccount('impersonated')
    const own = await signIn(u.email)
    const res = await impersonate.POST(
      authed(superAdmin.token, '/api/admin/impersonate', { method: 'POST', body: JSON.stringify({ userId: u.id, reason: 'ticket 42' }) })
    )
    expect(res.status).toBe(200)
    const support = (await res.json()).token as string
    expect(await status(support)).toBe(200)

    const list = await (await sessions.GET(authed(own, '/api/auth/sessions'))).json()
    const row = list.sessions.find((s: { supportAccess: boolean }) => s.supportAccess)
    expect(row).toBeDefined()
    const exp = new Date(row.expiresAt).getTime() - Date.now()
    expect(exp).toBeLessThanOrEqual(3600_000)

    await oneSession.DELETE(authed(own, `/api/auth/sessions/${row.id}`, { method: 'DELETE' }), params({ id: row.id }))
    expect(await status(support)).toBe(401)
  })
})
