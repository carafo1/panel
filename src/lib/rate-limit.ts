/**
 * In-memory sliding-window rate limiter.
 *
 * Used by:
 *  - #8 Rate Limiting - protects auth endpoints, API routes, etc.
 *
 * Note: Because Next.js route handlers may run in different processes
 * (especially in serverless), this in-memory limiter is best-effort.
 * For multi-instance deployments, swap the store for a Redis backend.
 */

interface RateLimitEntry {
  timestamps: number[]
}

interface RateLimitOptions {
  /** Unique identifier for the bucket (e.g. ip + route, or userId + route) */
  key: string
  /** Maximum number of requests allowed in the window */
  limit: number
  /** Window duration in milliseconds */
  windowMs: number
}

interface RateLimitResult {
  success: boolean
  remaining: number
  resetAt: number
}

// Map<bucketKey, RateLimitEntry>
const store = new Map<string, RateLimitEntry>()

// Periodic cleanup interval (every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000
let lastCleanup = Date.now()

function cleanup(now: number) {
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return
  lastCleanup = now
  // Remove entries whose newest timestamp is older than 1 hour
  const oneHourAgo = now - 60 * 60 * 1000
  for (const [k, entry] of store) {
    const last = entry.timestamps[entry.timestamps.length - 1]
    if (!last || last < oneHourAgo) {
      store.delete(k)
    }
  }
}

/**
 * Check and record a rate limit decision for the given bucket.
 */
export function rateLimit(opts: RateLimitOptions): RateLimitResult {
  const now = Date.now()
  cleanup(now)

  const windowStart = now - opts.windowMs
  const entry = store.get(opts.key) ?? { timestamps: [] }

  // Drop timestamps outside the sliding window
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

  if (entry.timestamps.length >= opts.limit) {
    const oldest = entry.timestamps[0]
    const resetAt = oldest + opts.windowMs
    store.set(opts.key, entry)
    return {
      success: false,
      remaining: 0,
      resetAt,
    }
  }

  entry.timestamps.push(now)
  store.set(opts.key, entry)

  return {
    success: true,
    remaining: Math.max(0, opts.limit - entry.timestamps.length),
    resetAt: now + opts.windowMs,
  }
}

/**
 * Build a rate-limit identifier from a Request. Combines the client IP
 * (forwarded or socket) and an optional user id (passed via header).
 */
export function getRateLimitIdentifier(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  const realIp = req.headers.get('x-real-ip')
  const ip = forwarded?.split(',')[0]?.trim() || realIp || 'unknown'
  const userId = req.headers.get('x-user-id') || ''
  return userId ? `${ip}:${userId}` : ip
}

/**
 * Wrap a Next.js route handler with rate limiting.
 *
 * Usage:
 *   export const POST = withRateLimit(async (req) => { ... }, {
 *     limit: 10,
 *     windowMs: 60_000,
 *   })
 */
export function withRateLimit<TArgs extends unknown[]>(
  handler: (req: Request, ...args: TArgs) => Promise<Response> | Response,
  opts: { limit: number; windowMs: number }
) {
  return async (req: Request, ...args: TArgs): Promise<Response> => {
    const id = getRateLimitIdentifier(req)
    const url = new URL(req.url)
    const key = `${id}:${url.pathname}`

    const result = rateLimit({ key, ...opts })

    if (!result.success) {
      const retryAfter = Math.max(
        1,
        Math.ceil((result.resetAt - Date.now()) / 1000)
      )
      return new Response(
        JSON.stringify({
          error: 'Too many requests',
          message: 'Rate limit exceeded. Please try again later.',
          retryAfter,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfter),
            'X-RateLimit-Limit': String(opts.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(result.resetAt),
          },
        }
      )
    }

    const response = await handler(req, ...args)

    // Attach rate limit headers to the response
    try {
      const headers = new Headers(response.headers)
      headers.set('X-RateLimit-Limit', String(opts.limit))
      headers.set('X-RateLimit-Remaining', String(result.remaining))
      headers.set('X-RateLimit-Reset', String(result.resetAt))
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return response
    }
  }
}

/**
 * Reset the rate limit for a given key (useful for testing or admin overrides).
 */
export function resetRateLimit(key: string): void {
  store.delete(key)
}
