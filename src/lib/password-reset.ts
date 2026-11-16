/**
 * src/lib/password-reset.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Password-reset tokens: random, stored only as a hash, expire, single-use.
 *
 * They used to be kept in plain text in `User.emailVerificationToken` with no
 * expiry, which meant:
 *   - a reset link worked forever (the email's "expires in 1 hour" was false)
 *   - anyone with a copy of the database could reset any password
 *   - the signup verification link — also stored there — reset the password
 *     too, and requesting a reset broke a pending verification link
 * Now each reset has its own fields; only the SHA-256 of the emailed token is
 * stored, it expires after RESET_TOKEN_TTL_MS, and using it clears it.
 * ════════════════════════════════════════════════════════════════════════════
 */
import crypto from 'crypto'
import { db } from '@/lib/db'

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour — what the email promises

export function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Create (or replace) the user's reset token and return the raw value to email. */
export async function issuePasswordResetToken(userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('hex')
  await db.user.update({
    where: { id: userId },
    data: {
      passwordResetTokenHash: hashResetToken(token),
      passwordResetExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  })
  return token
}

/**
 * Validate and USE UP a reset token. Returns the user id, or null when the
 * token is unknown, expired or already used. The clear is conditional on the
 * stored hash, so two simultaneous requests cannot both succeed.
 */
export async function consumePasswordResetToken(token: string): Promise<string | null> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token.trim())) return null
  const hash = hashResetToken(token.trim().toLowerCase())

  const user = await db.user.findFirst({
    where: { passwordResetTokenHash: hash },
    select: { id: true, passwordResetExpiresAt: true },
  })
  if (!user) return null

  const { count } = await db.user.updateMany({
    where: { id: user.id, passwordResetTokenHash: hash },
    data: { passwordResetTokenHash: null, passwordResetExpiresAt: null },
  })
  if (count !== 1) return null // someone else used it first

  if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() <= Date.now()) return null
  return user.id
}
