/**
 * Admin 2FA requirement, expiring email-verification links, data export and
 * account deletion.
 */
import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { hashPassword, issueSession, invalidateUserAuthCache } from '@/lib/auth'
import * as me from '@/app/api/auth/me/route'
import * as adminUsers from '@/app/api/admin/users/route'
import * as register from '@/app/api/auth/register/route'
import * as verifyEmail from '@/app/api/auth/verify-email/route'
import * as exportData from '@/app/api/user/export/route'
import * as deleteAccount from '@/app/api/user/delete-account/route'
import { makeUser, makeProject, authed, uid } from './helpers'

let ip = 0
const fromPanel = (token: string | null, path: string, init: RequestInit = {}) =>
  authed(token, path, {
    ...init,
    headers: { 'sec-fetch-site': 'same-origin', host: 'localhost', 'x-forwarded-for': `10.55.${++ip & 255}.${(ip >> 8) & 255}`, ...(init.headers as Record<string, string>) },
  })

describe('administrators must use 2FA', () => {
  const saved = process.env.REQUIRE_ADMIN_2FA
  beforeAll(() => {
    process.env.REQUIRE_ADMIN_2FA = 'true'
  })
  afterAll(() => {
    process.env.REQUIRE_ADMIN_2FA = saved
    invalidateUserAuthCache()
  })

  it('an admin without 2FA is treated as a regular user until they turn it on', async () => {
    const admin = await makeUser('admin-no2fa', 'admin')
    invalidateUserAuthCache(admin.id)

    expect((await adminUsers.GET(authed(admin.token, '/api/admin/users'))).status).toBe(403)
    const who = await (await me.GET(authed(admin.token, '/api/auth/me'))).json()
    expect(who.user.role).toBe('user')
    expect(who.user.adminTwoFactorRequired).toBe(true)

    await db.user.update({ where: { id: admin.id }, data: { twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP' } })
    invalidateUserAuthCache(admin.id)
    expect((await adminUsers.GET(authed(admin.token, '/api/admin/users'))).status).toBe(200)
    const after = await (await me.GET(authed(admin.token, '/api/auth/me'))).json()
    expect(after.user.role).toBe('admin')
    expect(after.user.adminTwoFactorRequired).toBe(false)
  })

  it('regular customers are unaffected', async () => {
    const c = await makeUser('plain-customer')
    const who = await (await me.GET(authed(c.token, '/api/auth/me'))).json()
    expect(who.user.role).toBe('user')
    expect(who.user.adminTwoFactorRequired).toBe(false)
  })
})

describe('email verification links', () => {
  async function registerAndCaptureLink(email: string) {
    const log = spyOn(console, 'log')
    try {
      const res = await register.POST(fromPanel(null, '/api/auth/register', { method: 'POST', body: JSON.stringify({ name: 'V', email, password: 'Verify-Pass-123' }) }))
      expect(res.status).toBeLessThan(300)
      const printed = log.mock.calls.map((c) => c.join(' ')).join('\n')
      const m = /verify_token=([a-f0-9]{64})/.exec(printed)
      expect(m).not.toBeNull()
      return m![1]
    } finally {
      log.mockRestore()
    }
  }
  const verify = (token: string) => verifyEmail.GET(fromPanel(null, `/api/auth/verify-email?token=${token}`))

  it('stores only a hash, expires in 48h, works once', async () => {
    const email = `${uid('verify')}@example.test`
    const token = await registerAndCaptureLink(email)
    const row = await db.user.findUnique({ where: { email } })
    expect(row!.emailVerificationToken).not.toBe(token)
    expect(row!.emailVerificationToken).toBe(crypto.createHash('sha256').update(token).digest('hex'))
    const ttl = row!.emailVerificationExpiresAt!.getTime() - Date.now()
    expect(ttl).toBeGreaterThan(47 * 3600_000)

    expect((await verify(token)).status).toBe(200)
    expect((await db.user.findUnique({ where: { email } }))!.emailVerified).toBe(true)
    expect((await verify(token)).status).toBe(400)
  })

  it('refuses an expired link and says so', async () => {
    const email = `${uid('verify-old')}@example.test`
    const token = await registerAndCaptureLink(email)
    await db.user.update({ where: { email }, data: { emailVerificationExpiresAt: new Date(Date.now() - 1000) } })
    const res = await verify(token)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/expired/i)
    expect((await db.user.findUnique({ where: { email } }))!.emailVerified).toBe(false)
  })
})

describe('data export', () => {
  it('downloads the account’s data without secrets', async () => {
    const u = await makeUser('exporter')
    await makeProject(u.id)
    const res = await exportData.GET(fromPanel(u.token, '/api/user/export'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('attachment')
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.account.email).toBe(u.email)
    expect(body.websites.length).toBe(1)
    expect(text).not.toMatch(/"password"|twoFactorSecret|passwordResetTokenHash/)
  })
})

describe('account deletion', () => {
  const PASSWORD = 'Delete-Me-Pass-1'
  async function account(tag: string, extra: Record<string, unknown> = {}) {
    const email = `${uid(tag)}@example.test`
    const u = await db.user.create({ data: { email, name: 'Del', password: await hashPassword(PASSWORD), role: 'user', emailVerified: true, ...extra } })
    const token = await issueSession({ userId: u.id, email, role: u.role })
    return { ...u, token }
  }
  const del = (token: string, body: unknown) =>
    deleteAccount.POST(fromPanel(token, '/api/user/delete-account', { method: 'POST', body: JSON.stringify(body) }))

  it('needs the password and the word DELETE', async () => {
    const u = await account('del-guard')
    expect((await del(u.token, { password: PASSWORD })).status).toBe(400)
    expect((await del(u.token, { password: 'wrong', confirm: 'DELETE' })).status).toBe(400)
  })

  it('lists what must be settled first: unpaid invoices and registered domains', async () => {
    const u = await account('del-blocked')
    await db.invoice.create({ data: { userId: u.id, number: uid('INV'), status: 'unpaid', total: 10, subtotal: 10, items: '[]' } as never })
    await db.domain.create({ data: { userId: u.id, name: `${uid('keep')}.test`, status: 'active', registrar: 'dynadot' } })
    const blockers = (await (await deleteAccount.GET(fromPanel(u.token, '/api/user/delete-account'))).json()).blockers as string[]
    expect(blockers.some((b) => /unpaid invoice/.test(b))).toBe(true)
    expect(blockers.some((b) => /registered through us/.test(b))).toBe(true)
    expect((await del(u.token, { password: PASSWORD, confirm: 'DELETE' })).status).toBe(409)
  })

  it('refuses for administrators', async () => {
    const a = await account('del-admin', { role: 'admin' })
    const blockers = (await (await deleteAccount.GET(fromPanel(a.token, '/api/user/delete-account'))).json()).blockers as string[]
    expect(blockers.some((b) => /administrator/.test(b))).toBe(true)
  })

  it('deletes websites, erases the person, ends every login, keeps invoices', async () => {
    const u = await account('del-ok')
    const p = await makeProject(u.id)
    await db.invoice.create({ data: { userId: u.id, number: uid('INV'), status: 'paid', total: 5, subtotal: 5, items: '[]' } as never })

    const res = await del(u.token, { password: PASSWORD, confirm: 'DELETE' })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie') || '').toContain('Max-Age=0')

    expect(await db.project.findUnique({ where: { id: p.id } })).toBeNull()
    const row = await db.user.findUnique({ where: { id: u.id } })
    expect(row!.email).not.toBe(u.email)
    expect(row!.email).toEndWith('@deleted.invalid')
    expect(row!.name).toBe('Deleted account')
    expect(row!.status).toBe('closed')
    expect(await db.invoice.count({ where: { userId: u.id } })).toBe(1)
    expect((await me.GET(authed(u.token, '/api/auth/me'))).status).toBe(401)
  })

  it('asks for the authenticator code when 2FA is on', async () => {
    const u = await account('del-2fa', { twoFactorEnabled: true, twoFactorSecret: 'JBSWY3DPEHPK3PXP' })
    const res = await del(u.token, { password: PASSWORD, confirm: 'DELETE' })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/authenticator/i)
  })
})
