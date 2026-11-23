import bcryptjs from 'bcryptjs'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { requireSecret } from '@/lib/security'
import { rateLimit } from '@/lib/rate-limit'

// SECURITY: requireSecret throws at module load time if JWT_SECRET is missing
// or still set to its placeholder value. This prevents the panel from booting
// with an insecure default that an attacker could use to forge any user's token.
const JWT_SECRET = requireSecret('JWT_SECRET')
const TOKEN_EXPIRY = '7d'
const TWO_FACTOR_TEMP_TOKEN_EXPIRY = '5m'
// Impersonation (support access) sessions are issued by issueSession with a
// 1-hour lifetime — see app/api/admin/impersonate.

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
 * Verify a SESSION token (login or impersonation).
 *
 * SECURITY: other short-lived tokens are signed with the same secret — the
 * "password OK, 2FA pending" token, the GitHub OAuth `state`, the realtime
 * token. Each carries a `kind` claim. Session tokens never do, and always
 * carry email + role. Without this check those tokens were accepted as a full
 * login: the 2FA-pending token let anyone with just the password skip the
 * second factor, and the OAuth state (visible in the GitHub URL) was a
 * 10-minute session.
 */
export function verifyToken(token: string): {
  userId: string
  email: string
  role: string
  impersonatedBy?: string
} | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      userId?: unknown
      email?: unknown
      role?: unknown
      kind?: unknown
      impersonatedBy?: string
    }
    if (decoded.kind !== undefined) return null
    if (
      typeof decoded.userId !== 'string' ||
      typeof decoded.email !== 'string' ||
      typeof decoded.role !== 'string'
    ) {
      return null
    }
    return {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      ...(decoded.impersonatedBy ? { impersonatedBy: decoded.impersonatedBy } : {}),
    }
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
  /** ms epoch; tokens issued (iat) before this are rejected. 0 = never. */
  sessionsRevokedAt: number
  expiresAt: number
}

const identityCache = new Map<string, CachedIdentity>()

/**
 * Drop a user's cached role/status so the next request re-reads the DB.
 * Called whenever a role or account status changes — without it a demotion
 * would take up to AUTH_CACHE_TTL_MS to bite instead of being immediate.
 */
/**
 * SECURITY: admin accounts must use two-factor authentication. An admin or
 * super admin without 2FA is treated as a regular user — every admin check
 * reads the role through here, so admin powers stay paused everywhere until
 * they turn 2FA on (Settings → Security). On by default in production;
 * REQUIRE_ADMIN_2FA=true|false overrides (development defaults to off).
 */
export function adminTwoFactorRequired(): boolean {
  const v = (process.env.REQUIRE_ADMIN_2FA || '').trim().toLowerCase()
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return process.env.NODE_ENV === 'production'
}

/** The role a user actually gets, after the admin-2FA rule. */
export function effectiveRole(role: string, twoFactorEnabled: boolean): string {
  const isAdminRole = role === 'admin' || role === 'super_admin'
  return isAdminRole && !twoFactorEnabled && adminTwoFactorRequired() ? 'user' : role
}

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
      select: { id: true, email: true, role: true, status: true, sessionsRevokedAt: true, twoFactorEnabled: true },
    })
    if (!user) {
      // Deleted user: forget any cached identity so a stale entry can't
      // keep the account alive.
      identityCache.delete(userId)
      return null
    }
    const fresh: CachedIdentity = {
      role: effectiveRole(user.role, user.twoFactorEnabled),
      status: (user as { status?: string }).status || 'active',
      email: user.email,
      sessionsRevokedAt: user.sessionsRevokedAt ? user.sessionsRevokedAt.getTime() : 0,
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
  const { iat, sid } = readTimingClaims(token)
  return checkSession(decoded.userId, iat, sid, decoded.impersonatedBy)
}

/* ────────────────────────────────────────────────────────────────────
 * Sessions — signing out actually ends a token
 * ────────────────────────────────────────────────────────────────────
 *
 * SECURITY: a JWT is valid until it expires (7 days) no matter what the
 * server thinks. Signing out used to delete only the browser's copy, so a
 * token copied anywhere kept working for a week, and changing a password left
 * an attacker's existing login in place. Now:
 *   - each login creates a Session row; the token carries its id (`sid`) and
 *     is accepted only while that row is live — logout revokes it
 *   - `User.sessionsRevokedAt` rejects EVERY token issued before it (also old
 *     tokens without a sid), for "sign out everywhere" and password changes
 * Lookups are cached for AUTH_CACHE_TTL_MS like identities; revoking clears
 * the cache, so a revocation takes effect immediately.
 */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
/** Don't write lastSeenAt more than once per this interval per session. */
const LAST_SEEN_WRITE_MS = 5 * 60 * 1000

interface CachedSession {
  userId: string
  live: boolean
  expiresAtMs: number
  cachedUntil: number
}
const sessionCache = new Map<string, CachedSession>()
const lastSeenWritten = new Map<string, number>()

/** iat (seconds) and sid of an ALREADY VERIFIED token. */
function readTimingClaims(token: string): { iat: number; sid?: string } {
  const payload = jwt.decode(token) as { iat?: number; sid?: unknown } | null
  return {
    iat: typeof payload?.iat === 'number' ? payload.iat : 0,
    sid: typeof payload?.sid === 'string' ? payload.sid : undefined,
  }
}

async function loadSessionRow(sid: string): Promise<CachedSession | null> {
  const cached = sessionCache.get(sid)
  if (cached && cached.cachedUntil > Date.now()) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { db } = require('@/lib/db') as typeof import('@/lib/db')
    const row = await db.session.findUnique({
      where: { id: sid },
      select: { userId: true, revokedAt: true, expiresAt: true },
    })
    if (!row) {
      sessionCache.delete(sid)
      return null
    }
    const entry: CachedSession = {
      userId: row.userId,
      live: !row.revokedAt,
      expiresAtMs: row.expiresAt.getTime(),
      cachedUntil: Date.now() + AUTH_CACHE_TTL_MS,
    }
    sessionCache.set(sid, entry)
    return entry
  } catch (error) {
    console.error('[auth] loadSessionRow failed:', error)
    return null // fail closed
  }
}

function touchSession(sid: string): void {
  const last = lastSeenWritten.get(sid) || 0
  if (Date.now() - last < LAST_SEEN_WRITE_MS) return
  lastSeenWritten.set(sid, Date.now())
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { db } = require('@/lib/db') as typeof import('@/lib/db')
  db.session.update({ where: { id: sid }, data: { lastSeenAt: new Date() } }).catch(() => {})
}

/** The shared freshness + revocation check behind every token type. */
async function checkSession(
  userId: string,
  iat: number,
  sid: string | undefined,
  impersonatedBy?: string
): Promise<FreshAuth | null> {
  const identity = await loadIdentity(userId)
  if (!identity || identity.status !== 'active') return null
  if (identity.sessionsRevokedAt && iat * 1000 < identity.sessionsRevokedAt) return null

  if (sid) {
    const session = await loadSessionRow(sid)
    if (!session || !session.live || session.userId !== userId) return null
    if (session.expiresAtMs <= Date.now()) return null
    touchSession(sid)
  }

  return {
    userId,
    email: identity.email,
    role: identity.role,
    status: identity.status,
    ...(impersonatedBy ? { impersonatedBy } : {}),
  }
}

function clientIp(req?: Request): string | null {
  if (!req) return null
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64) || null
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || null
}

/**
 * Start a session for a successful login and return its token. Use this —
 * not generateToken — wherever a person signs in, so the login can be listed
 * in Settings and revoked.
 */
export async function issueSession(
  user: { userId: string; email: string; role: string },
  req?: Request,
  opts: { impersonatedBy?: string; ttlSeconds?: number } = {}
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { db } = require('@/lib/db') as typeof import('@/lib/db')
  const ttl = opts.ttlSeconds ?? SESSION_TTL_SECONDS
  const session = await db.session.create({
    data: {
      userId: user.userId,
      expiresAt: new Date(Date.now() + ttl * 1000),
      ipAddress: clientIp(req),
      userAgent: req?.headers.get('user-agent')?.slice(0, 300) || null,
      impersonatedBy: opts.impersonatedBy || null,
    },
    select: { id: true },
  })
  // Housekeeping: forget this user's sessions that ended over 30 days ago.
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
  db.session
    .deleteMany({
      where: { userId: user.userId, OR: [{ expiresAt: { lt: monthAgo } }, { revokedAt: { lt: monthAgo } }] },
    })
    .catch(() => {})

  return jwt.sign(
    {
      userId: user.userId,
      email: user.email,
      role: user.role,
      sid: session.id,
      ...(opts.impersonatedBy ? { impersonatedBy: opts.impersonatedBy } : {}),
    },
    JWT_SECRET,
    { expiresIn: ttl }
  )
}

/** The session id inside a valid token, if it has one. */
export function sessionIdOf(token: string | null): string | undefined {
  if (!token || !verifyToken(token)) return undefined
  return readTimingClaims(token).sid
}

/** End one session (one device). */
export async function revokeSession(sid: string, userId: string, reason: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { db } = require('@/lib/db') as typeof import('@/lib/db')
  const { count } = await db.session.updateMany({
    where: { id: sid, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  })
  sessionCache.delete(sid)
  return count > 0
}

/**
 * End EVERY session of a user, including logins from before per-device
 * sessions existed. To keep the caller signed in, issue them a new session
 * afterwards (see issueSession).
 */
export async function revokeAllSessions(userId: string, reason: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { db } = require('@/lib/db') as typeof import('@/lib/db')
  // Whole seconds: token iat is in seconds, so a session issued right after
  // this call (same second) must not fall before the cutoff.
  const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000)
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { sessionsRevokedAt: cutoff } }),
    db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    }),
  ])
  identityCache.delete(userId)
  for (const [sid, s] of sessionCache) if (s.userId === userId) sessionCache.delete(sid)
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
 * Super-admin only, with the role read from the DATABASE.
 *
 * The distinction matters. A raw `decoded.role !== 'super_admin'` trusts a JWT
 * that stays valid for seven days, so demoting someone — or suspending their
 * account outright — left them able to change roles and impersonate users
 * until their token happened to expire. Going through requireRole re-reads the
 * role and the account status on every call, so a demotion takes effect at
 * once.
 *
 * Use this for anything that can escalate privilege or assume another
 * identity; `requireAdminRole` remains correct for ordinary operator work.
 */
export async function requireSuperAdminRole(
  request: Request
): Promise<FreshAuth | null> {
  return requireRole(request, ['super_admin'])
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

/** Marks an `ApiKey.key` value as a hash rather than a raw key. */
export const API_KEY_HASH_PREFIX = 'sha256:'

/**
 * The value stored in `ApiKey.key` for a raw API key: `sha256:<hex digest>`.
 *
 * SECURITY: keys used to be stored (and looked up) in plain text, so anyone
 * who could read the database or a backup of it could act as every customer
 * with a key. Only this digest is stored now; the raw key is shown once, at
 * creation. A plain SHA-256 is enough: the key is 256 random bits, so there
 * is nothing to brute-force, and a deterministic digest keeps the existing
 * unique index usable for lookup. The `sha256:` prefix can never collide with
 * a raw key (those start with `dh_`) or be presented as one (verifyApiKey
 * rejects anything not starting with `dh_`).
 */
export function hashApiKey(rawKey: string): string {
  return API_KEY_HASH_PREFIX + crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex')
}

/**
 * Lookup an API key in the database and return the owning user's identity
 * payload (same shape as the JWT payload) on success. Returns null when the
 * key does not exist. Updates `lastUsed` as a side-effect.
 *
 * API keys always start with the `dh_` prefix (see /api/user/api-keys route).
 * Tokens that don't match that prefix are skipped quickly to avoid a DB hit.
 *
 * Looks the key up by its hash first. Rows created before keys were hashed
 * still hold the raw key; on the first successful use such a row is rewritten
 * to hold the hash instead, so the plain value leaves the database.
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
    const select = {
      id: true,
      userId: true,
      user: { select: { id: true, email: true, role: true } },
    } as const
    const hashed = hashApiKey(token)
    let apiKey = await db.apiKey.findUnique({ where: { key: hashed }, select })
    if (!apiKey) {
      // Legacy row holding the raw key: accept it once more and migrate it.
      apiKey = await db.apiKey.findUnique({ where: { key: token }, select })
      if (apiKey) {
        await db.apiKey
          .updateMany({ where: { id: apiKey.id, key: token }, data: { key: hashed } })
          .catch((err: unknown) => {
            console.error('[auth] could not migrate a legacy API key to its hash:', err)
          })
      }
    }
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
): Promise<{ userId: string; email: string; role: string; impersonatedBy?: string } | null> {
  // SECURITY: this used to trust the token on its own (signature + expiry),
  // so a signed-out session, a password-changed account or a suspended user
  // still worked on every route using it. It now applies the same session,
  // revocation and account-status checks as authenticateRequestFresh.
  const auth = await authenticateRequestFresh(request)
  if (!auth) return null
  return {
    userId: auth.userId,
    email: auth.email,
    role: auth.role,
    ...(auth.impersonatedBy ? { impersonatedBy: auth.impersonatedBy } : {}),
  }
}

/**
 * Generate a short-lived JWT used to identify a user mid-2FA-login flow.
 * Carries ONLY the userId — not the role/email — to limit blast radius.
 * Expires after 5 minutes.
 */
export function generateTwoFactorTempToken(userId: string): string {
  // jti makes every pending login distinct, so its attempt budget
  // (consumeTwoFactorAttempt) is its own even for two logins in one second.
  return jwt.sign({ userId, kind: '2fa-temp' }, JWT_SECRET, {
    expiresIn: TWO_FACTOR_TEMP_TOKEN_EXPIRY,
    jwtid: crypto.randomUUID(),
  })
}

/** Code attempts (TOTP or backup code) allowed per 2FA-pending login. */
export const TWO_FACTOR_MAX_ATTEMPTS = 5
// Longer than the token's own 5-minute life, so the budget cannot reset
// while the token is still valid.
const TWO_FACTOR_ATTEMPT_WINDOW_MS = 10 * 60 * 1000

/**
 * Spend one code attempt against a 2FA-pending temp token. Returns false once
 * the token has used up TWO_FACTOR_MAX_ATTEMPTS: the caller must then reject
 * it, and the user has to sign in with their password again.
 *
 * SECURITY: the 2FA endpoints were only rate limited per IP, so one stolen or
 * phished password plus a pool of IPs could walk the 10^6 TOTP space within
 * the token's 5 minutes. The budget is per token and shared by
 * /2fa/login-verify and /2fa/verify-backup. Call it only AFTER the token's
 * signature was verified, so garbage tokens cannot fill the store.
 *
 * Uses the in-process limiter (lib/rate-limit), like the per-IP limits: the
 * panel runs as one process. Keyed by a digest of the token, which also covers
 * tokens issued before they carried a jti.
 */
export function consumeTwoFactorAttempt(tempToken: string): boolean {
  const key = '2fa-pending:' + crypto.createHash('sha256').update(tempToken).digest('hex')
  return rateLimit({
    key,
    limit: TWO_FACTOR_MAX_ATTEMPTS,
    windowMs: TWO_FACTOR_ATTEMPT_WINDOW_MS,
  }).success
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

/* ────────────────────────────────────────────────────────────────────
 * Realtime token — lets the browser's Socket.IO connection prove who it is
 * ────────────────────────────────────────────────────────────────────
 * The session lives in an httpOnly cookie the page cannot read, but the
 * realtime service needs something to forward to /api/realtime/authorize.
 * This token is fetched fresh on each connect, kept only in memory, and is
 * accepted ONLY by that endpoint (verifyToken rejects it everywhere else).
 */
const REALTIME_TOKEN_EXPIRY = '12h'

/** `sid` ties the realtime token to the login session, so signing out ends it too. */
export function generateRealtimeToken(userId: string, sid?: string): string {
  return jwt.sign({ userId, kind: 'realtime', ...(sid ? { sid } : {}) }, JWT_SECRET, {
    expiresIn: REALTIME_TOKEN_EXPIRY,
  })
}

/** Resolve a realtime token to the user's CURRENT role and status. */
export async function verifyRealtimeTokenFresh(token: string): Promise<FreshAuth | null> {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId?: unknown; kind?: unknown; iat?: number; sid?: unknown }
    if (decoded.kind !== 'realtime' || typeof decoded.userId !== 'string') return null
    return checkSession(
      decoded.userId,
      typeof decoded.iat === 'number' ? decoded.iat : 0,
      typeof decoded.sid === 'string' ? decoded.sid : undefined
    )
  } catch {
    return null
  }
}

/**
 * Resolve the authenticated user from an Authorization: Bearer header.
 * Returns null when not authenticated or user no longer exists.
 */
export async function getUserFromRequest(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  if (!token) return null
  return verifyTokenFresh(token)
}
