import bcryptjs from 'bcryptjs'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'deployhub-secret-key-2024'
const TOKEN_EXPIRY = '7d'
const TWO_FACTOR_TEMP_TOKEN_EXPIRY = '5m'

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

export function verifyToken(token: string): { userId: string; email: string; role: string } | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; email: string; role: string }
    return decoded
  } catch {
    return null
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
