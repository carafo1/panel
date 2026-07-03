/**
 * src/lib/security.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Shared security helpers for the Apsamo Panel API.
 *
 *   - requireSecret(name, value)   — throw at startup if a required env secret is missing
 *   - sanitizeError(err)           — convert any error to a safe client-facing message
 *   - isAdmin(role)                — true for 'admin' OR 'super_admin'
 *   - isSuperAdmin(role)           — true for 'super_admin' only
 *   - sanitizeProjectForCustomer() — strip internal infrastructure fields from a project
 *   - sanitizeServerForCustomer()  — strip IP + SSH info from a server
 *
 * Why this file exists:
 *   Every API route was inventing its own error-handling and admin-check logic,
 *   which led to inconsistent role checks (e.g. 'admin' without 'super_admin'),
 *   leaked error.message strings, and missing secrets. Centralizing the helpers
 *   here makes the security posture uniform and easy to audit.
 * ════════════════════════════════════════════════════════════════════════════
 */

/**
 * Throw at module load time if a required environment variable is missing or
 * still set to its placeholder value. This catches misconfigured production
 * deploys before they accept a single request.
 *
 * Usage:
 *   export const JWT_SECRET = requireSecret('JWT_SECRET')
 *   export const CRON_API_KEY = requireSecret('CRON_API_KEY')
 */
export function requireSecret(name: string): string {
  const value = process.env[name]
  if (!value || value.trim() === '') {
    throw new Error(
      `[security] Required environment variable ${name} is not set. ` +
      `Refusing to start. Generate one with: openssl rand -base64 32`
    )
  }
  // Reject known placeholder values from .env.example
  const placeholders: Record<string, RegExp> = {
    JWT_SECRET: /^replace-with/,
    ENCRYPTION_KEY: /^replace-with/,
    NEXTAUTH_SECRET: /^replace-with/,
    CRON_API_KEY: /^replace-with|^deployhub-cron-key$/,
  }
  if (placeholders[name] && placeholders[name].test(value)) {
    throw new Error(
      `[security] ${name} is still set to its placeholder value. ` +
      `Generate a real one and update .env before starting the panel.`
    )
  }
  return value
}

/**
 * Convert any thrown error into a safe, generic client-facing message.
 * Never returns the raw error.message to the client — that would leak
 * Prisma error details, internal file paths, SSH connection errors, etc.
 *
 * The full error is logged server-side via console.error.
 *
 * Usage in a route handler:
 *   try { ... } catch (err) {
 *     console.error('[my-route]', err)
 *     return NextResponse.json({ error: sanitizeError(err) }, { status: 500 })
 *   }
 */
export function sanitizeError(err: unknown): string {
  // Log the full error server-side for debugging
  console.error('[route-error]', err)

  // Prisma errors — return a generic message
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: string }).code
    if (code === 'P2002') return 'A record with this value already exists.'
    if (code === 'P2025') return 'Record not found.'
    if (code?.startsWith('P')) return 'Database operation failed.'
  }

  // Zod validation errors — safe to expose (they describe user input)
  if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'ZodError') {
    return 'Invalid input: ' + ((err as { errors?: Array<{ message: string }> }).errors ?? [])
      .map((e) => e.message)
      .join(', ')
  }

  // Everything else — return generic message
  return 'Internal server error. Please try again or contact support if the issue persists.'
}

/**
 * Returns true if the role has admin privileges (either 'admin' or 'super_admin').
 * Use this for the standard "admin-only" gate on API routes.
 */
export function isAdmin(role: string | undefined | null): boolean {
  return role === 'admin' || role === 'super_admin'
}

/**
 * Returns true only for 'super_admin' (highest privilege).
 * Use this for actions that even regular admins can't do — e.g. deleting
 * other admins, viewing raw audit logs with IP addresses.
 */
export function isSuperAdmin(role: string | undefined | null): boolean {
  return role === 'super_admin'
}

/**
 * Strip internal infrastructure fields from a project before returning it
 * to a non-admin customer. Customers should not see:
 *   - containerId, containerName, containerPort, externalPort (Docker internals)
 *   - deployPath (filesystem layout)
 *   - databaseHost, databasePort, databaseUser (DB connection details —
 *     they get these via the dedicated /databases?reveal=true endpoint)
 *   - server.ip, server.sshHost (network topology)
 *   - server.sshUser, server.sshPassword, server.deployedPublicKey (SSH creds)
 *
 * Admins see the full record.
 */
export function sanitizeProjectForCustomer<T extends Record<string, unknown>>(
  project: T,
  userRole: string | undefined | null
): T {
  if (isAdmin(userRole)) return project

  const sanitized = { ...project }

  // Strip Docker container internals
  delete sanitized.containerId
  delete sanitized.containerName
  delete sanitized.containerPort
  delete sanitized.externalPort
  delete sanitized.deployPath

  // Strip DB connection details (customer retrieves these via /databases endpoint)
  delete sanitized.databaseHost
  delete sanitized.databasePort
  delete sanitized.databaseUser
  delete sanitized.databasePassword

  // Strip server internals if nested
  if (sanitized.server && typeof sanitized.server === 'object') {
    sanitized.server = sanitizeServerForCustomer(
      sanitized.server as Record<string, unknown>,
      userRole
    ) as T[keyof T]
  }

  return sanitized
}

/**
 * Strip sensitive fields from a server record before returning to a customer.
 * Customers should see only: name, region, status, specs (cpuCores, ramGB, etc.).
 * They should NEVER see: ip, sshHost, sshUser, sshPassword, sshFingerprint,
 * deployedPublicKey, hasSshKey, hasSshPassword, dockerVersion, caddyVersion, osInfo.
 */
export function sanitizeServerForCustomer<T extends Record<string, unknown>>(
  server: T,
  userRole: string | undefined | null
): T {
  if (isAdmin(userRole)) return server

  const sanitized = { ...server }

  // Network topology
  delete sanitized.ip
  delete sanitized.sshHost
  delete sanitized.sshPort
  delete sanitized.sshUser

  // SSH credentials + key material
  delete sanitized.sshPassword
  delete sanitized.sshPrivateKey
  delete sanitized.sshFingerprint
  delete sanitized.deployedPublicKey
  delete sanitized.hasSshKey
  delete sanitized.hasSshPassword

  // Internal version + OS info
  delete sanitized.dockerVersion
  delete sanitized.caddyVersion
  delete sanitized.osInfo
  delete sanitized.lastProvisionedAt
  delete sanitized.lastHealthCheckAt
  delete sanitized.healthStatus

  return sanitized
}

/**
 * Mask a secret so only its prefix is visible (e.g. for listing API keys or
 * webhook signing secrets). Returns "whk_abc...****" style output.
 *
 * Full secret is returned only once at creation time.
 */
export function maskSecret(secret: string, visiblePrefix = 8): string {
  if (!secret || secret.length <= visiblePrefix) return '****'
  return secret.slice(0, visiblePrefix) + '...' + '*'.repeat(4)
}

/**
 * Validate that a callback URL is on the same origin as the app.
 * Prevents open-redirect attacks in OAuth callback handlers.
 */
export function isSafeRedirectUrl(url: string, allowedOrigins: string[]): boolean {
  try {
    const parsed = new URL(url)
    return allowedOrigins.includes(parsed.origin)
  } catch {
    return false
  }
}

/**
 * Constant-time string comparison to prevent timing attacks on token checks.
 * Use for: webhook signing secrets, API key prefix matching, cron key checks.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}
