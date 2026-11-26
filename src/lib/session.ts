/**
 * src/lib/session.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Browser sessions live in an httpOnly cookie, never in JavaScript.
 *
 * The login token used to be kept in localStorage, where any script on the
 * page could read it — one XSS bug and every admin's 7-day token could be
 * stolen. Now the server sets it as an httpOnly cookie that page scripts cannot
 * see, and the proxy (src/proxy.ts) turns that cookie into the
 * `Authorization: Bearer` header the API routes already understand. API keys
 * and explicit bearer tokens (CLI, scripts) keep working unchanged.
 *
 * Cross-site use. Customer sites used to be served from subdomains of the
 * panel's own domain (they are now served on their own domains only, but the
 * defence stays: old DNS, staging copies or a misconfiguration could still put
 * one there). Such a site is "same-site", and SameSite=Lax alone would let it
 * make the panel act with the visitor's session. The cookie is therefore only
 * honoured for requests the browser marks as coming from the panel's own
 * origin (Fetch Metadata, with an Origin-header fallback), plus plain
 * top-level GET navigations such as opening an invoice PDF.
 *
 * No database or Node-only imports: the proxy imports this module.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** Seven days, matching the JWT lifetime in src/lib/auth.ts. */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

const isProd = () => process.env.NODE_ENV === 'production'

/**
 * `__Host-` (production, HTTPS) makes the browser refuse the cookie unless it
 * is Secure, host-only and Path=/ — so a customer site on a subdomain cannot
 * plant a session cookie for the panel. Plain HTTP in development cannot use
 * the prefix.
 */
export function sessionCookieName(): string {
  return isProd() ? '__Host-apsamo_session' : 'apsamo_session'
}

function cookieAttributes(maxAge: number): string {
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    ...(isProd() ? ['Secure'] : []),
  ].join('; ')
}

/** Set-Cookie value that stores the session token. */
export function sessionSetCookie(token: string): string {
  return `${sessionCookieName()}=${token}; ${cookieAttributes(SESSION_MAX_AGE_SECONDS)}`
}

/** Set-Cookie value that deletes the session. */
export function sessionClearCookie(): string {
  return `${sessionCookieName()}=; ${cookieAttributes(0)}`
}

/** Read the session token from a Cookie header. */
export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  const name = sessionCookieName()
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim()
      return value || null
    }
  }
  return null
}

/**
 * True when the Authorization header carries a real bearer value. Older client
 * code sent `Bearer null` / `Bearer ` when it had no token; those must not
 * block the cookie from being used.
 */
export function hasUsableBearer(authHeader: string | null): boolean {
  if (!authHeader) return false
  const m = /^Bearer\s+(.+)$/.exec(authHeader.trim())
  if (!m) return false
  const v = m[1].trim()
  return v !== '' && v !== 'null' && v !== 'undefined'
}

type HeaderSource = { headers: Headers; method: string }

/**
 * Where did this request come from, as far as the browser tells us?
 *   same-origin  the panel's own pages
 *   foreign      another site, including a customer subdomain
 *   unknown      no browser signal (typed URL, bookmark, non-browser client)
 */
export function requestSource(req: HeaderSource): 'same-origin' | 'foreign' | 'unknown' {
  const site = req.headers.get('sec-fetch-site')
  if (site === 'same-origin') return 'same-origin'
  if (site === 'same-site' || site === 'cross-site') return 'foreign'

  const origin = req.headers.get('origin')
  if (origin) {
    if (origin === 'null') return 'foreign'
    try {
      const originHost = new URL(origin).host
      const hosts = [req.headers.get('host'), req.headers.get('x-forwarded-host')]
      return hosts.some((h) => h && h === originHost) ? 'same-origin' : 'foreign'
    } catch {
      return 'foreign'
    }
  }
  return 'unknown'
}

const SAFE_METHODS = new Set(['GET', 'HEAD'])

/**
 * May the session COOKIE authenticate this request?
 *   - panel's own pages: always
 *   - anything else: only a read-only top-level navigation (opening a link),
 *     never a state change and never a script-initiated request
 */
export function cookieAuthAllowed(req: HeaderSource): boolean {
  const source = requestSource(req)
  if (source === 'same-origin') return true
  if (!SAFE_METHODS.has(req.method.toUpperCase())) return false
  if (source === 'unknown') return true
  return req.headers.get('sec-fetch-mode') === 'navigate'
}

/**
 * May a response to this request SET the session cookie? Refused for requests
 * from other sites, so a page elsewhere cannot sign a visitor into an account
 * of its choosing (login CSRF).
 */
export function mayIssueSessionCookie(req: HeaderSource): boolean {
  return requestSource(req) !== 'foreign'
}

/** Start a browser session on `res` (unless the request came from another site). */
export function attachSession<R extends Response>(res: R, token: string, req: HeaderSource): R {
  if (mayIssueSessionCookie(req)) res.headers.append('Set-Cookie', sessionSetCookie(token))
  return res
}

/** End the browser session on `res`. */
export function clearSession<R extends Response>(res: R): R {
  res.headers.append('Set-Cookie', sessionClearCookie())
  return res
}

/* ── Support access ─────────────────────────────────────────────────────────
 * While a super admin views the panel as a customer, the session cookie holds
 * the 1-hour support session and the admin's own login waits in this second
 * httpOnly cookie, so "Return to admin" can restore it without a password.
 * It is only ever read back by /api/auth/support/end, which re-verifies it.
 */
export function supportReturnCookieName(): string {
  return isProd() ? '__Host-apsamo_support_return' : 'apsamo_support_return'
}

export function readSupportReturnCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null
  const name = supportReturnCookieName()
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim() || null
  }
  return null
}

/** Remember the admin's own session while they use support access (≤ 1 hour). */
export function attachSupportReturn<R extends Response>(res: R, adminToken: string): R {
  res.headers.append('Set-Cookie', `${supportReturnCookieName()}=${adminToken}; ${cookieAttributes(60 * 60)}`)
  return res
}

export function clearSupportReturn<R extends Response>(res: R): R {
  res.headers.append('Set-Cookie', `${supportReturnCookieName()}=; ${cookieAttributes(0)}`)
  return res
}
