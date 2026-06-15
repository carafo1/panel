import { NextResponse, NextRequest } from 'next/server'

/**
 * #8 API Rate Limiting Middleware (Edge-compatible)
 *
 * Responsibilities:
 *  - Apply per-IP, per-route rate limits on /api/* requests
 *  - Attach CORS headers to all /api/* responses
 *  - Respond to CORS preflight (OPTIONS) with 204 No Content
 *  - Return 429 Too Many Requests with Retry-After when limits are exceeded
 *
 * Notes:
 *  - This middleware does NOT verify JWT. Route handlers do their own auth.
 *  - Rate limit store is an in-memory Map (Edge runtime). Each Edge instance
 *    keeps its own counts; in multi-instance deployments, swap for a Redis
 *    backend if stricter enforcement is needed.
 *  - Only /api/* routes are subject to rate limiting / CORS logic. All other
 *    routes pass through unchanged.
 */

// ─── Rate Limiting (Edge-compatible, in-memory Map) ──────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

// ─── Main Middleware ─────────────────────────────────────────────────────────

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

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
  // Run the middleware on every route EXCEPT:
  //  - Next.js internals (/_next/static, /_next/image)
  //  - Common static asset files (favicon, images, fonts, css/js, etc.)
  //
  // Functional logic (rate limit + CORS) only fires for /api/* paths,
  // as guarded at the top of the middleware handler.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|css|js|map|woff|woff2|ttf|eot|otf)$).*)',
  ],
}
