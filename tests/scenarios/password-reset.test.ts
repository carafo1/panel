/**
 * Password reset links: single-use, expire in an hour, stored only as a hash,
 * and separate from email verification.
 *
 * They used to sit in plain text in `emailVerificationToken` with no expiry:
 * a reset link worked forever, a database copy could reset any password, a
 * signup-verification link could reset the password too, and the link was
 * written to the server log on every request.
 */
import { describe, it, expect, spyOn, afterEach } from 'bun:test'
import { db } from '@/lib/db'
import { hashPassword, verifyPassword } from '@/lib/auth'
import { hashResetToken, issuePasswordResetToken } from '@/lib/password-reset'
import { sendEmail } from '@/lib/email'
import * as forgot from '@/app/api/auth/forgot-password/route'
import * as reset from '@/app/api/auth/reset-password/route'
import { authed, uid } from './helpers'

let ipSeq = 0
const req = (path: string, body: unknown) =>
  authed(null, path, {
    method: 'POST',
    // distinct client per call so the per-IP rate limits aren't under test
    headers: { 'x-forwarded-for': `10.77.${++ipSeq & 255}.${(ipSeq >> 8) & 255}` },
    body: JSON.stringify(body),
  })

async function makeAccount(extra: Record<string, unknown> = {}) {
  const email = `${uid('reset')}@example.test`
  return db.user.create({
    data: { email, name: 'R', password: await hashPassword('Old-Password-1'), role: 'user', ...extra },
  })
}

/** Ask for a reset through the real route and capture the link from the (dev) email. */
async function requestResetLink(email: string): Promise<string> {
  const log = spyOn(console, 'log')
  try {
    const res = await forgot.POST(req('/api/auth/forgot-password', { email }))
    expect(res.status).toBe(200)
    const printed = log.mock.calls.map((c) => c.join(' ')).join('\n')
    const m = /reset_token=([a-f0-9]{64})/.exec(printed)
    expect(m).not.toBeNull()
    return m![1]
  } finally {
    log.mockRestore()
  }
}

const doReset = (token: string, newPassword = 'Brand-New-Pass-9') =>
  reset.POST(req('/api/auth/reset-password', { token, newPassword }))

afterEach(() => {
  process.env.NODE_ENV = 'test'
})

describe('password reset links', () => {
  it('stores only a hash, with a 1-hour expiry', async () => {
    const u = await makeAccount()
    const token = await requestResetLink(u.email)
    const row = await db.user.findUnique({ where: { id: u.id } })
    expect(row!.passwordResetTokenHash).toBe(hashResetToken(token))
    expect(row!.passwordResetTokenHash).not.toContain(token)
    const ttl = row!.passwordResetExpiresAt!.getTime() - Date.now()
    expect(ttl).toBeGreaterThan(55 * 60_000)
    expect(ttl).toBeLessThanOrEqual(60 * 60_000)
  })

  it('works once: the emailed link sets the password, then is dead', async () => {
    const u = await makeAccount()
    const token = await requestResetLink(u.email)
    expect((await doReset(token)).status).toBe(200)
    const row = await db.user.findUnique({ where: { id: u.id } })
    expect(await verifyPassword('Brand-New-Pass-9', row!.password)).toBe(true)
    expect(row!.passwordResetTokenHash).toBeNull()
    expect((await doReset(token, 'Another-Pass-77')).status).toBe(400)
  })

  it('refuses an expired link', async () => {
    const u = await makeAccount()
    const token = await issuePasswordResetToken(u.id)
    await db.user.update({ where: { id: u.id }, data: { passwordResetExpiresAt: new Date(Date.now() - 1000) } })
    expect((await doReset(token)).status).toBe(400)
    const row = await db.user.findUnique({ where: { id: u.id } })
    expect(await verifyPassword('Old-Password-1', row!.password)).toBe(true)
  })

  it('a newer request replaces the older link', async () => {
    const u = await makeAccount()
    const first = await issuePasswordResetToken(u.id)
    const second = await issuePasswordResetToken(u.id)
    expect((await doReset(first)).status).toBe(400)
    expect((await doReset(second)).status).toBe(200)
  })

  it('an email-verification token cannot reset the password', async () => {
    const verify = 'a'.repeat(64)
    const u = await makeAccount({ emailVerificationToken: verify })
    expect((await doReset(verify)).status).toBe(400)
  })

  it('asking for a reset leaves a pending verification link working', async () => {
    const verify = `verify-${uid('v')}`
    const u = await makeAccount({ emailVerificationToken: verify })
    await requestResetLink(u.email)
    const row = await db.user.findUnique({ where: { id: u.id } })
    expect(row!.emailVerificationToken).toBe(verify)
  })

  it('a too-short new password does not use up the link', async () => {
    const u = await makeAccount()
    const token = await issuePasswordResetToken(u.id)
    expect((await doReset(token, 'short')).status).toBe(400)
    expect((await doReset(token)).status).toBe(200)
  })

  it('following the link confirms the email address', async () => {
    const u = await makeAccount({ emailVerified: false })
    const token = await issuePasswordResetToken(u.id)
    await doReset(token)
    expect((await db.user.findUnique({ where: { id: u.id } }))!.emailVerified).toBe(true)
  })

  it('gives the same answer for unknown emails (no account discovery)', async () => {
    const known = await makeAccount()
    const a = await (await forgot.POST(req('/api/auth/forgot-password', { email: known.email }))).json()
    const b = await (await forgot.POST(req('/api/auth/forgot-password', { email: `${uid('nobody')}@example.test` }))).json()
    expect(a.message).toBe(b.message)
  })

  it('rejects garbage tokens without touching the database', async () => {
    expect((await doReset('not-a-token')).status).toBe(400)
    expect((await doReset('')).status).toBe(400)
  })
})

describe('emails in production without a provider', () => {
  it('are reported as NOT sent and their contents are never logged', async () => {
    const saved = { ...process.env }
    delete process.env.EMAIL_PROVIDER
    delete process.env.EMAIL_API_KEY
    delete process.env.RESEND_API_KEY
    delete process.env.SMTP_HOST
    process.env.NODE_ENV = 'production'
    const log = spyOn(console, 'log')
    const err = spyOn(console, 'error')
    try {
      const secretLink = `https://panel.test/?reset_token=${'b'.repeat(64)}`
      const result = await sendEmail({ to: 'x@example.test', subject: 'Reset', html: `<a href="${secretLink}">reset</a>` })
      expect(result.success).toBe(false)
      const everything = [...log.mock.calls, ...err.mock.calls].map((c) => c.join(' ')).join('\n')
      expect(everything).not.toContain('reset_token')
      expect(everything).toContain('NOT sent')
    } finally {
      log.mockRestore()
      err.mockRestore()
      Object.assign(process.env, saved)
    }
  })
})
