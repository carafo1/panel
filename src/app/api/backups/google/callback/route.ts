/**
 * /api/backups/google/callback
 *
 * Where Google sends the customer back. Verifies the signed state, swaps the
 * code for tokens, and stores the refresh token encrypted.
 *
 * Always redirects to the panel rather than rendering JSON — a human is
 * looking at this, having just clicked "Allow" on a Google page.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { encrypt } from '@/lib/encryption'
import { logAudit } from '@/lib/audit'
import { exchangeCode } from '@/lib/google-drive'
import { verifyState } from '@/lib/oauth-state'

function back(status: 'connected' | 'error', detail?: string): NextResponse {
  const base = (process.env.APP_URL || 'https://panel.apsamo.com').replace(/\/+$/, '')
  const p = new URLSearchParams({ drive: status })
  if (detail) p.set('detail', detail.slice(0, 200))
  return NextResponse.redirect(`${base}/?${p.toString()}`, { status: 302 })
}

export async function GET(request: Request) {
  const url = new URL(request.url)

  const err = url.searchParams.get('error')
  if (err) {
    // The customer clicked Deny. Not an error worth logging as a failure.
    return back('error', err === 'access_denied' ? 'You cancelled the Google sign-in.' : err)
  }

  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || !state) return back('error', 'Google did not return an authorisation code.')

  // SECURITY: the state ties this callback to the user who started the flow.
  // Without it, a crafted callback URL would attach the ATTACKER's Drive to
  // whichever account happened to open it, and that account's backups would
  // then be uploaded to the attacker's storage.
  const userId = verifyState(state)
  if (!userId) return back('error', 'This sign-in link has expired. Please try again.')

  const result = await exchangeCode(code)
  if (!result.ok || !result.refreshToken) {
    return back('error', result.error || 'Could not complete the Google connection.')
  }

  const dest = await db.backupDestination.upsert({
    where: { userId_provider: { userId, provider: 'google_drive' } },
    create: {
      userId,
      provider: 'google_drive',
      refreshTokenEnc: encrypt(result.refreshToken),
      accessTokenEnc: result.accessToken ? encrypt(result.accessToken) : null,
      accessExpiresAt: result.expiresAt ?? null,
      accountEmail: result.email ?? null,
      enabled: true,
      lastStatus: null,
      lastError: null,
    },
    update: {
      // Reconnecting replaces the credential and clears any previous failure,
      // which is the whole reason someone reconnects.
      refreshTokenEnc: encrypt(result.refreshToken),
      accessTokenEnc: result.accessToken ? encrypt(result.accessToken) : null,
      accessExpiresAt: result.expiresAt ?? null,
      accountEmail: result.email ?? null,
      enabled: true,
      lastStatus: null,
      lastError: null,
    },
  })

  await logAudit({
    userId,
    action: 'backup.destination.connected',
    resource: 'backup_destination',
    resourceId: dest.id,
    req: request,
    metadata: { provider: 'google_drive', account: result.email },
  }).catch(() => {})

  return back('connected')
}
