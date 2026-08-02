/**
 * Signed, expiring state for OAuth round-trips.
 *
 * The state parameter is what ties a callback to the person who started it.
 * An unsigned or absent state means anyone can hand a victim a crafted
 * callback URL and have the ATTACKER's account attached to the victim's — for
 * a backup destination that means the victim's data is uploaded to storage the
 * attacker controls.
 *
 * HMAC over "userId.expiry" with the app's JWT secret. No storage needed, and
 * a replayed state stops working once it expires.
 */
import { createHmac, timingSafeEqual } from 'crypto'

const TTL_MS = 10 * 60 * 1000

function secret(): string {
  const s = process.env.JWT_SECRET
  if (!s) throw new Error('JWT_SECRET is not set')
  return s
}

export function signState(userId: string): string {
  const payload = `${userId}.${Date.now() + TTL_MS}`
  const mac = createHmac('sha256', secret()).update(payload).digest('base64url')
  return `${Buffer.from(payload).toString('base64url')}.${mac}`
}

/** Returns the userId, or null if forged, tampered with, or expired. */
export function verifyState(state: string): string | null {
  const [encoded, mac] = state.split('.')
  if (!encoded || !mac) return null

  let payload: string
  try {
    payload = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }

  const expected = createHmac('sha256', secret()).update(payload).digest('base64url')
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  // Constant-time: a length-varying or early-exit comparison leaks enough to
  // forge a signature given enough attempts.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  const idx = payload.lastIndexOf('.')
  if (idx < 1) return null
  const userId = payload.slice(0, idx)
  const expiry = Number(payload.slice(idx + 1))
  if (!Number.isFinite(expiry) || Date.now() > expiry) return null
  return userId
}
