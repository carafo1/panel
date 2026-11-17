/**
 * src/lib/email-verification.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Email-verification links: random, stored only as a hash, expire in 48 hours,
 * single-use. Same treatment as password-reset links (lib/password-reset.ts).
 *
 * Previously the token sat in plain text in `User.emailVerificationToken`,
 * never expired, and the full link was printed to the server log on every
 * registration and resend.
 * ════════════════════════════════════════════════════════════════════════════
 */
import crypto from 'crypto'
import { db } from '@/lib/db'

export const VERIFICATION_TTL_MS = 48 * 60 * 60 * 1000

const hash = (token: string) => crypto.createHash('sha256').update(token, 'utf8').digest('hex')

/** A new token to email, plus the fields to store for it. */
export function newVerificationToken(): { token: string; data: { emailVerificationToken: string; emailVerificationExpiresAt: Date } } {
  const token = crypto.randomBytes(32).toString('hex')
  return {
    token,
    data: { emailVerificationToken: hash(token), emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_TTL_MS) },
  }
}

export function verificationUrl(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  return `${appUrl}?verify_token=${token}`
}

/**
 * Mark the address verified and use the token up. Returns the user, or a
 * reason it could not be used.
 */
export async function consumeVerificationToken(
  token: string
): Promise<{ ok: true; userId: string } | { ok: false; reason: 'invalid' | 'expired' }> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token.trim())) return { ok: false, reason: 'invalid' }
  const h = hash(token.trim().toLowerCase())
  const user = await db.user.findFirst({
    where: { emailVerificationToken: h },
    select: { id: true, emailVerificationExpiresAt: true },
  })
  if (!user) return { ok: false, reason: 'invalid' }
  if (!user.emailVerificationExpiresAt || user.emailVerificationExpiresAt.getTime() <= Date.now()) {
    await db.user.update({ where: { id: user.id }, data: { emailVerificationToken: null, emailVerificationExpiresAt: null } })
    return { ok: false, reason: 'expired' }
  }
  const { count } = await db.user.updateMany({
    where: { id: user.id, emailVerificationToken: h },
    data: { emailVerified: true, emailVerificationToken: null, emailVerificationExpiresAt: null },
  })
  if (count !== 1) return { ok: false, reason: 'invalid' }
  // Paid before verifying? Their referral can qualify now.
  const paid = await db.invoice.findFirst({ where: { userId: user.id, status: 'paid', amountPaid: { gt: 0 } }, orderBy: { amountPaid: 'desc' }, select: { amountPaid: true } })
  if (paid) {
    const { qualifyReferral } = await import('@/lib/referrals')
    await qualifyReferral(user.id, paid.amountPaid).catch((err) => console.error('[referrals] qualify failed:', err))
  }
  return { ok: true, userId: user.id }
}
