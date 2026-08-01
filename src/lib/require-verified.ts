/**
 * Email-verification gate for actions that spend money or consume resources.
 *
 * `emailVerified` was written at signup and shown in the UI, but nothing ever
 * checked it: an account created with an address the signer-up did not control
 * could immediately buy domains, start subscriptions and provision containers.
 *
 * Deliberately NOT applied to login. One existing account is unverified, and
 * blocking sign-in would lock it out with no way to reach the "resend
 * verification" button. The gate belongs on the actions that cost something,
 * not on the door.
 *
 * Admins are exempt: they are created out-of-band and an operator locked out of
 * their own panel by an unsent email is worse than the risk this prevents.
 */
import { db } from './db'
import { isAdmin } from './security'

export interface VerificationGateResult {
  ok: boolean
  /** Ready-to-return response when ok is false. */
  response?: Response
}

/**
 * Returns `{ ok: true }` when the user may proceed, otherwise a 403 explaining
 * what to do. 403 rather than 401: the caller is authenticated, they simply
 * have not completed a required step.
 */
export async function requireVerifiedEmail(
  userId: string,
  role?: string
): Promise<VerificationGateResult> {
  if (role && isAdmin(role)) return { ok: true }

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { emailVerified: true, role: true, email: true },
  })

  if (!user) {
    return {
      ok: false,
      response: Response.json({ error: 'User not found' }, { status: 404 }),
    }
  }

  if (isAdmin(user.role)) return { ok: true }
  if (user.emailVerified) return { ok: true }

  return {
    ok: false,
    response: Response.json(
      {
        error:
          'Please confirm your email address before making a purchase. ' +
          'We sent a link when you signed up — check your inbox, or request a new one from Settings.',
        code: 'email_not_verified',
      },
      { status: 403 }
    ),
  }
}
