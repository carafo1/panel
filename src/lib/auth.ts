import bcryptjs from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { requireSecret } from '@/lib/security'

// SECURITY: requireSecret throws at module load time if JWT_SECRET is missing
// or still set to its placeholder value. This prevents the panel from booting
// with an insecure default that an attacker could use to forge any user's token.
const JWT_SECRET = requireSecret('JWT_SECRET')
const TOKEN_EXPIRY = '7d'
const TWO_FACTOR_TEMP_TOKEN_EXPIRY = '5m'
// Deliberately short: an impersonation session should not outlive the support
// interaction that justified it.
const IMPERSONATION_TOKEN_EXPIRY = '1h'

export async function hashPassword(password: string): Promise<string> {
  const salt = await bcryptjs.genSalt(12)
  return bcryptjs.hash(password, salt)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcryptjs.compare(password, hash)
}

export function generateToken(payload: { userId: string; email: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRY })
}

/**
 * Short-lived token that lets a super admin act as a customer for support.
 *
 * SECURITY: carries an `impersonatedBy` claim so every action taken while
 * impersonating is attributable to the real admin, and expires in 1 hour
 * rather than the normal 7 days.
 */
export function generateImpersonationToken(payload: {
  userId: string
  email: string
  role: string
  impersonatedBy: string
}): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: IMPERSONATION_TOKEN_EXPIRY,
  })
}

export function verifyToken(token: string): {
  userId: string
  email: string
  role: string
  impersonatedBy?: string
} | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId: string
      email: string
      role: string
      impersonatedBy?: string
    }
    return decoded
  } catch {
    return null
  }
}

/* ────────────────────────────────────────────────────────────────────
 * Fresh authorization — role and account standing from the DATABASE
 * ────────────────────────────────────────────────────────────────────
 *
 * SECURITY: the JWT bakes in the role at login and lives for 7 days. Trusting
 * `decoded.role` therefore means a demoted admin keeps admin powers, and a
 * suspended account keeps working, for up to a week. That is the dangerous
 * direction of the failure, so authorization must read the CURRENT role and
 * status rather than what was true when the token was minted.
 *
 * A naive per-request DB read is fine for correctness but noisy against
 * SQLite, so results are cached briefly. The cache bounds the staleness window
 * to AUTH_CACHE_TTL_MS (seconds) instead of 7 days, and role/status changes
 * invalidate it explicitly for an immediate effect.
 */
const AUTH_CACHE_TTL_MS = 10_000

interface CachedIdentity {
  role: string
  status: string
  email: string
  expiresAt: number
}

const identityCache = new Map<string, CachedIdentity>()

/**
 * Drop a user's cached role/status so the next request re-reads the DB.
 * Called whenever a role or account status changes — without it a demotion
 * would take up to AUTH_CACHE_TTL_MS to bite instead of being immediate.
 */
export function invalidateUserAuthCache(userId?: string): void {
  if (userId) identityCache.delete(userId)
  else identityCache.clear()
}

async function loadIdentity(userId: string): Promise<CachedIdentity | null> {
  const cached = identityCache.get(userId)
  if (cached && cached.expiresAt > Date.now()) return cached

  try {
    // Lazy import to break the db -> ... -> auth -> db require cycle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('@/lib/db') as typeof import('@/lib/db')
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, status: true },
    })
    if (!user) {
      // Deleted user: forget any cached identity so a stale entry can't
      // keep the account alive.
      identityCache.delete(userId)
      return null
    }
    const fresh: CachedIdentity = {
      role: user.role,
      status: (user as { status?: string }).status || 'active',
      email: user.email,
      expiresAt: Date.now() + AUTH_CACHE_TTL_MS,
    }
    identityCache.set(userId, fresh)
    return fresh
  } catch (error) {
    console.error('[auth] loadIdentity failed:', error)
    // FAIL CLOSED. Returning the token's claims here would reintroduce the
    // exact hole this function exists to close.
    return null
  }
}

export interface FreshAuth {
  userId: string
  email: string
  /** Current role from the database, NOT the role baked into the token. */
  role: string
  status: string
  impersonatedBy?: string
}

/**
 * Verify a token AND confirm the account is still active with its current
 * role. Returns null for an invalid token, a deleted user, or any account
 * whose status is not "active".
 *
 * Prefer this over `verifyToken` anywhere an authorization decision is made.
 */
export async function verifyTokenFresh(
  token: string
): Promise<FreshAuth | null> {
  const decoded = verifyToken(token)
  if (!decoded) return null

  const identity = await loadIdentity(decoded.userId)
  if (!identity) return null
  if (identity.status !== 'active') return null

  return {
    userId: decoded.userId,
    email: identity.email,
    role: identity.role,
    status: identity.status,
    impersonatedBy: decoded.impersonatedBy,
  }
}

/**
 * Authorization helper for API routes: resolves the caller and checks they
 * currently hold one of `roles`. Accepts a JWT or an API key.
 */
export async function requireRole(
  request: Request,
  roles: string[]
): Promise<FreshAuth | null> {
  const auth = await authenticateRequestFresh(request)
  if (!auth) return null
  return roles.includes(auth.role) ? auth : null
}

/** Admin-or-super-admin shorthand — by far the most common check. */
export async function requireAdminRole(
  request: Request
): Promise<FreshAuth | null> {
  return requireRole(request, ['admin', 'super_admin'])
}

/**
 * Like `authenticateRequest` (JWT or API key) but with the role and account
 * status re-read from the database.
 */
export async function authenticateRequestFresh(
  request: Request
): Promise<FreshAuth | null> {
  const token =
    extractTokenFromHeader(request.headers.get('Authorization')) ||
    request.headers.get('x-api-key')
  if (!token) return null

  const fresh = await verifyTokenFresh(token)
  if (fresh) return fresh

  // API keys carry no role claim of their own — resolve the owner, then
  // apply the same freshness rules.
  const viaKey = await verifyApiKey(token)
  if (!viaKey) return null
  const identity = await loadIdentity(viaKey.userId)
  if (!identity || identity.status !== 'active') return null
  return {
    userId: viaKey.userId,
    email: identity.email,
    role: identity.role,
    status: identity.status,
  }
}

export function extractTokenFromHeader(authHeader: string | null): string | null {
  if (!authHeader) return null
  const parts = authHeader.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null
  return parts[1]
}

/**
 * Lookup an API key in the database and return the owning user's identity
 * payload (same shape as the JWT payload) on success. Returns null when the
 * key does not exist. Updates `lastUsed` as a side-effect.
 *
 * API keys always start with the `dh_` prefix (see /api/user/api-keys route).
 * Tokens that don't match that prefix are skipped quickly to avoid a DB hit.
 */
export async function verifyApiKey(
  token: string
): Promise<{ userId: string; email: string; role: string } | null> {
  if (!token || !token.startsWith('dh_')) return null
  try {
    // Lazy import to avoid a circular dependency at module load time
    // (db.ts -> ... -> auth.ts -> db.ts). require() inside the function
    // breaks the cycle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('@/lib/db') as typeof import('@/lib/db')
    const apiKey = await db.apiKey.findUnique({
      where: { key: token },
      select: {
        id: true,
        userId: true,
        user: { select: { id: true, email: true, role: true } },
      },
    })
    if (!apiKey || !apiKey.user) return null
    // Fire-and-forget update of lastUsed — must not block the request.
    db.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsed: new Date() } })
      .catch(() => {})
    return {
      userId: apiKey.user.id,
      email: apiKey.user.email,
      role: apiKey.user.role,
    }
  } catch (error) {
    console.error('[auth] verifyApiKey failed:', error)
    return null
  }
}

/**
 * Authenticate a request using either a JWT bearer token or an API key.
 *
 * Tries the JWT path first (sync, fast). If that fails and the token looks
 * like an API key (dh_ prefix), falls back to a database lookup. Returns the
 * decoded user payload, or null when unauthenticated.
 *
 * This is the function API routes should call when they want to accept both
 * session JWTs (issued at login) and long-lived API keys (created from the
 * Settings → API Keys panel and used by the `deployhub` CLI).
 */
export async function authenticateRequest(
  request: Request
): Promise<{ userId: string; email: string; role: string } | null> {
  const authHeader = request.headers.get('Authorization')
  const xApiKey = request.headers.get('x-api-key')
  const token = extractTokenFromHeader(authHeader) || xApiKey
  if (!token) return null
  // Fast path: valid JWT
  const decoded = verifyToken(token)
  if (decoded) return decoded
  // Slow path: API key lookup
  return verifyApiKey(token)
}

/**
 * Generate a short-lived JWT used to identify a user mid-2FA-login flow.
 * Carries ONLY the userId — not the role/email — to limit blast radius.
 * Expires after 5 minutes.
 */
export function generateTwoFactorTempToken(userId: string): string {
  return jwt.sign({ userId, kind: '2fa-temp' }, JWT_SECRET, {
    expiresIn: TWO_FACTOR_TEMP_TOKEN_EXPIRY,
  })
}

/**
 * Verify a 2FA temp token issued at login time. Returns the userId on
 * success, or null if the token is missing/invalid/expired.
 */
export function verifyTwoFactorTempToken(token: string): { userId: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; kind?: string }
    if (decoded.kind !== '2fa-temp' || !decoded.userId) return null
    return { userId: decoded.userId }
  } catch {
    return null
  }
}

/**
 * Resolve the authenticated user from an Authorization: Bearer header.
 * Returns null when not authenticated or user no longer exists.
 */
export async function getUserFromRequest(request: Request) {
  const authHeader = request.headers.get('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) return null
  const decoded = verifyToken(token)
  if (!decoded) return null
  return decoded
}
