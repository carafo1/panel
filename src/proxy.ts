import { NextResponse, NextRequest } from 'next/server'
import { db } from '@/lib/db'

/**
 * #8 API Rate Limiting Proxy + Project Redirect/IP-Block Enforcement
 *
 * (In Next.js 16, the `middleware.ts` file convention was renamed to
 * `proxy.ts` and the exported `middleware` function was renamed to `proxy`.
 * The `matcher` export and `runtime`/`config` exports are unchanged. See
 * https://nextjs.org/docs/messages/middleware-to-proxy)
 *
 * Two independent layers run in this proxy:
 *
 *  ── Layer 1: Project Redirects + IP Blocks ──────────────────────────────
 *  Runs FIRST (before rate limiting). Only fires for requests whose Host
 *  header matches a project's `customDomain` or `subdomain`. Skips the
 *  panel's own routes (`/api/*`, `/dashboard`, `/_next/*`, `/admin`, etc.).
 *  Queries the DB for active Redirect + IpBlock rows (cached 10s in memory)
 *  and either returns a 301/302 redirect, a 403 Forbidden, or falls through.
 *
 *  ── Layer 2: Rate Limiting + CORS (existing) ────────────────────────────
 *  Per-IP, per-route rate limits on `/api/*` requests + CORS headers on all
 *  `/api/*` responses. Untouched by Layer 1.
 *
 * Notes:
 *  - `runtime = 'nodejs'` is REQUIRED so Prisma (`@/lib/db`) works. The
 *    edge runtime cannot use Prisma's CJS client.
 *  - This proxy does NOT verify JWT. Route handlers do their own auth.
 *  - Rate-limit store + redirect/IP-block cache are in-memory Maps. Each
 *    process keeps its own state.
 */

// NOTE: In Next.js 16, `proxy.ts` ALWAYS runs on the Node.js runtime
// (the `runtime` export is not allowed here — it's implicitly nodejs).
// This is required so Prisma's CJS client (@/lib/db) works.

// ═══════════════════════════════════════════════════════════════════════════
// Layer 1: Project Redirects + IP Blocks (in-memory cached DB queries)
// ═══════════════════════════════════════════════════════════════════════════

interface CachedRedirect {
  id: string
  projectId: string
  fromPath: string
  toUrl: string
  statusCode: number
  matchQuery: string | null
}

interface CachedIpBlock {
  id: string
  projectId: string
  ipAddress: string
  action: string
  expiresAt: Date | null
}

interface CachedProjectHost {
  id: string
  subdomain: string
  customDomain: string | null
}

let redirectsCache: CachedRedirect[] = []
let ipBlocksCache: CachedIpBlock[] = []
let projectHostsCache: CachedProjectHost[] = []
let lastRefreshAt = 0
let refreshPromise: Promise<void> | null = null
const REFRESH_TTL_MS = 10_000

/**
 * Refresh the in-memory caches from the DB if they're older than 10s.
 * Concurrent callers share a single refresh promise (dedup).
 */
async function ensureCacheFresh(): Promise<void> {
  if (lastRefreshAt > 0 && Date.now() - lastRefreshAt < REFRESH_TTL_MS) return
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const [redirects, ipBlocks, projects] = await Promise.all([
          db.redirect.findMany({
            where: { enabled: true },
            select: {
              id: true,
              projectId: true,
              fromPath: true,
              toUrl: true,
              statusCode: true,
              matchQuery: true,
            },
          }),
          db.ipBlock.findMany({
            where: { enabled: true },
            select: {
              id: true,
              projectId: true,
              ipAddress: true,
              action: true,
              expiresAt: true,
            },
          }),
          db.project.findMany({
            where: { status: 'running' },
            select: {
              id: true,
              subdomain: true,
              customDomain: true,
            },
          }),
        ])
        redirectsCache = redirects as CachedRedirect[]
        ipBlocksCache = ipBlocks as CachedIpBlock[]
        projectHostsCache = projects as CachedProjectHost[]
        lastRefreshAt = Date.now()
      } catch (err) {
        // Don't update lastRefreshAt so we retry on the next request.
        console.error('[middleware] cache refresh failed:', err)
      } finally {
        refreshPromise = null
      }
    })()
  }
  await refreshPromise
}

/**
 * Convert an IPv4 address to a 32-bit unsigned integer.
 * Returns null for invalid input.
 */
function ipToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const octet = parseInt(p, 10)
    if (Number.isNaN(octet) || octet < 0 || octet > 255) return null
    n = (n << 8) | octet
  }
  return n >>> 0
}

/**
 * True if `ip` matches `rule` (single IPv4 or IPv4 CIDR like 10.0.0.0/8).
 */
function ipMatch(rule: string, ip: string): boolean {
  if (!ip || ip === 'unknown') return false
  const [ruleIp, cidrStr] = rule.split('/')
  const ruleNum = ipToInt(ruleIp || '')
  if (ruleNum === null) return false

  if (cidrStr === undefined) {
    return ipToInt(ip) === ruleNum
  }

  const prefix = parseInt(cidrStr, 10)
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false

  const ipNum = ipToInt(ip)
  if (ipNum === null) return false

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipNum & mask) === (ruleNum & mask)
}

/**
 * Find the project that owns the given Host header (matches customDomain or
 * subdomain). Returns null if no match.
 */
function findProjectByHost(host: string): CachedProjectHost | null {
  if (!host) return null
  // Strip :port suffix for matching.
  const hostname = host.split(':')[0].toLowerCase()
  for (const p of projectHostsCache) {
    if (p.subdomain && p.subdomain.toLowerCase() === hostname) return p
    if (p.customDomain && p.customDomain.toLowerCase() === hostname) return p
  }
  return null
}

/**
 * True if the IP should be blocked for this project.
 *
 * Logic:
 *  - Allow-list mode: if the project has any active 'allow' rule, only IPs
 *    matching an allow rule are admitted; everything else is blocked.
 *  - Deny mode: any matching 'deny' rule blocks the IP.
 *  - Allow + deny combined: allow rules take precedence (whitelist wins).
 */
function isIpBlocked(projectId: string, ip: string): boolean {
  const now = new Date()
  const blocks = ipBlocksCache.filter(
    (b) =>
      b.projectId === projectId &&
      (b.expiresAt === null || b.expiresAt.getTime() > now.getTime())
  )

  const allowRules = blocks.filter((b) => b.action === 'allow')
  if (allowRules.length > 0) {
    const isAllowed = allowRules.some((b) => ipMatch(b.ipAddress, ip))
    if (!isAllowed) return true // whitelist mode: not on the list → blocked
  }

  const denyRules = blocks.filter((b) => b.action === 'deny')
  if (denyRules.some((b) => ipMatch(b.ipAddress, ip))) {
    return true
  }

  return false
}

/**
 * Find a redirect rule that matches the given path + query string.
 *
 * Matching rules:
 *  - Exact match: fromPath === pathname
 *  - Wildcard match: fromPath ends with `/*` → prefix match on the dir part
 *  - Trailing slash: fromPath ends with `/` → prefix match
 *  - If redirect has a matchQuery, the request's `?<search>` must equal it
 */
function findRedirect(
  projectId: string,
  pathname: string,
  search: string
): CachedRedirect | null {
  for (const r of redirectsCache) {
    if (r.projectId !== projectId) continue
    // Honor explicit query match if set.
    if (r.matchQuery !== null && r.matchQuery !== '') {
      const expected = r.matchQuery.startsWith('?')
        ? r.matchQuery
        : `?${r.matchQuery}`
      if (expected !== search) continue
    }
    if (r.fromPath === pathname) return r
    if (r.fromPath.endsWith('/*')) {
      const prefix = r.fromPath.slice(0, -2) // strip /*
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return r
    } else if (r.fromPath.endsWith('/') && pathname.startsWith(r.fromPath)) {
      return r
    }
  }
  return null
}

/** Resolve a redirect target to a full URL string. */
function resolveRedirectTarget(
  toUrl: string,
  baseUrl: URL
): string | URL {
  if (/^https?:\/\//i.test(toUrl)) return toUrl
  if (toUrl.startsWith('/')) return new URL(toUrl, baseUrl).toString()
  return new URL(`/${toUrl}`, baseUrl).toString()
}

/**
 * Panel-owned path prefixes that should NEVER be subject to project
 * redirect/IP-block enforcement (even on a project-hosted host).
 */
const PANEL_PATH_PREFIXES = [
  '/api/',
  '/_next/',
  '/dashboard',
  '/admin',
  '/auth',
  '/login',
  '/register',
  '/pricing',
  '/docs',
  '/contact',
]

function isPanelRoute(pathname: string): boolean {
  if (pathname === '/' || pathname === '/favicon.ico') return true
  for (const p of PANEL_PATH_PREFIXES) {
    if (pathname === p) return true
    if (p.endsWith('/') && pathname.startsWith(p)) return true
    if (!p.endsWith('/') && pathname.startsWith(p + '/')) return true
  }
  return false
}

/**
 * Run Layer 1 enforcement. Returns a NextResponse if the request should be
 * short-circuited (redirect or 403), or null if it should fall through to
 * the existing rate-limit / route-handler logic.
 */
async function enforceProjectRules(
  request: NextRequest
): Promise<NextResponse | null> {
  const { pathname, search } = request.nextUrl
  // Skip panel routes entirely — they're never subject to project rules.
  if (isPanelRoute(pathname)) return null

  try {
    await ensureCacheFresh()
  } catch {
    // If cache refresh fails, fall through (don't break the request).
    return null
  }

  const host =
    request.headers.get('host') ||
    request.headers.get('x-forwarded-host') ||
    request.nextUrl.host
  const project = findProjectByHost(host)
  if (!project) return null // not a project-hosted request → skip

  // IP-block enforcement first (so blocked IPs can't even hit redirects).
  const ip = getClientIp(request)
  if (isIpBlocked(project.id, ip)) {
    return new NextResponse('Forbidden', { status: 403 })
  }

  // Redirect enforcement.
  const redirect = findRedirect(project.id, pathname, search)
  if (redirect) {
    const target = resolveRedirectTarget(redirect.toUrl, request.nextUrl)
    return NextResponse.redirect(target, redirect.statusCode)
  }

  return null
}

// ═══════════════════════════════════════════════════════════════════════════
// Layer 2: Rate Limiting (Edge-compatible, in-memory Map) — existing logic
// ═══════════════════════════════════════════════════════════════════════════

interface RateLimitEntry {
  count: number
  resetAt: number
}

// Map<bucketKey, RateLimitEntry> where bucketKey = `${ip}:${routeType}`
const rateLimitStore = new Map<string, RateLimitEntry>()

let lastCleanup = Date.now()
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes
const WINDOW_MS = 60 * 1000 // 1 minute sliding-ish window

interface RouteLimit {
  /** Logical bucket type so different routes don't share the same counter */
  type: string
  /** Maximum number of requests allowed within the window */
  limit: number
}

/**
 * Resolve the rate limit configuration for a given pathname.
 * Order matters: more specific routes are matched first.
 */
function getRouteLimit(pathname: string): RouteLimit {
  if (pathname === '/api/auth/login') {
    return { type: 'auth:login', limit: 5 }
  }
  if (pathname === '/api/auth/register') {
    return { type: 'auth:register', limit: 3 }
  }
  if (pathname === '/api/auth/forgot-password') {
    return { type: 'auth:forgot-password', limit: 3 }
  }
  if (pathname === '/api/auth/reset-password') {
    return { type: 'auth:reset-password', limit: 5 }
  }
  if (pathname === '/api/domains/search') {
    return { type: 'domains:search', limit: 20 }
  }
  return { type: 'api:default', limit: 100 }
}

/** Periodically purge expired entries so the Map doesn't grow unbounded. */
function cleanup(now: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  for (const [key, entry] of rateLimitStore) {
    if (now > entry.resetAt) {
      rateLimitStore.delete(key)
    }
  }
}

interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfter: number // seconds
  resetAt: number // epoch ms
}

/** Increment counter and decide whether the request is allowed. */
function checkRateLimit(ip: string, pathname: string): RateLimitDecision {
  const now = Date.now()
  cleanup(now)

  const { type, limit } = getRouteLimit(pathname)
  const key = `${ip}:${type}`
  const entry = rateLimitStore.get(key)

  // No entry yet, or window expired -> start fresh
  if (!entry || now > entry.resetAt) {
    const resetAt = now + WINDOW_MS
    rateLimitStore.set(key, { count: 1, resetAt })
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      retryAfter: 0,
      resetAt,
    }
  }

  entry.count += 1

  // Over the limit
  if (entry.count > limit) {
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    return {
      allowed: false,
      remaining: 0,
      retryAfter,
      resetAt: entry.resetAt,
    }
  }

  // Within the limit
  return {
    allowed: true,
    remaining: Math.max(0, limit - entry.count),
    retryAfter: 0,
    resetAt: entry.resetAt,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers (shared by Layer 1 + Layer 2)
// ═══════════════════════════════════════════════════════════════════════════

/** Extract the client IP from common proxy headers. Falls back to 'unknown'. */
function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = request.headers.get('x-real-ip')
  if (realIp) return realIp.trim()
  return 'unknown'
}

/** Attach the standard CORS headers to a NextResponse. */
function withCorsHeaders(response: NextResponse): NextResponse {
  response.headers.set('Access-Control-Allow-Origin', '*')
  response.headers.set(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, PATCH, DELETE, OPTIONS'
  )
  response.headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  )
  return response
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Proxy (Next.js 16: was `middleware` in middleware.ts, now `proxy` in proxy.ts)
// ═══════════════════════════════════════════════════════════════════════════

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // ── Layer 1: Project Redirects + IP Blocks ─────────────────────────────
  // Runs FIRST for ALL routes (not just /api/*). Returns null if the request
  // should fall through to Layer 2 / route handlers.
  try {
    const enforced = await enforceProjectRules(request)
    if (enforced) return enforced
  } catch (err) {
    // Never let Layer 1 errors break the request — log and continue.
    console.error('[proxy] Layer 1 enforcement error:', err)
  }

  // ── Layer 2: Rate Limiting + CORS (existing logic, /api/* only) ────────
  // Only apply rate limiting + CORS logic to /api/* routes.
  // All non-API routes pass through untouched.
  if (!pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  // CORS preflight: respond with 204 No Content (no rate limiting needed)
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 })
    return withCorsHeaders(response)
  }

  // Rate limiting (per IP + per route type)
  const ip = getClientIp(request)
  const decision = checkRateLimit(ip, pathname)

  if (!decision.allowed) {
    const response = NextResponse.json(
      {
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.',
        retryAfter: decision.retryAfter,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(decision.retryAfter),
          'X-RateLimit-Limit': String(getRouteLimit(pathname).limit),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': String(decision.resetAt),
        },
      }
    )
    return withCorsHeaders(response)
  }

  // Pass through to the route handler.
  // Routes do their own JWT / API-key auth — middleware does not verify tokens.
  const response = NextResponse.next()
  response.headers.set(
    'X-RateLimit-Limit',
    String(getRouteLimit(pathname).limit)
  )
  response.headers.set('X-RateLimit-Remaining', String(decision.remaining))
  response.headers.set('X-RateLimit-Reset', String(decision.resetAt))
  return withCorsHeaders(response)
}

export const config = {
  // Run the proxy on every route EXCEPT:
  //  - Next.js internals (/_next/static, /_next/image)
  //  - Common static asset files (favicon, images, fonts, css/js, etc.)
  //
  // Functional logic (rate limit + CORS) only fires for /api/* paths,
  // as guarded at the top of the proxy handler.
  // Layer 1 (redirects/IP-blocks) fires for ALL non-static-asset routes
  // but only enforces when the request Host matches a project.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|css|js|map|woff|woff2|ttf|eot|otf)$).*)',
  ],
}
