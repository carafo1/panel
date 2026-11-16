/**
 * src/lib/csp.ts
 * ════════════════════════════════════════════════════════════════════════════
 * Content-Security-Policy for the panel's pages.
 *
 * Scripts run only if they carry this request's nonce (Next.js adds it to its
 * own scripts automatically, see app/layout.tsx for the theme script) or are
 * loaded by a script that does ('strict-dynamic'). An injected
 * `<script>` or `onerror=` handler therefore does not run — the second line of
 * defence behind escaping, now that session tokens are also out of reach in an
 * httpOnly cookie.
 *
 * Styles allow 'unsafe-inline': React, Radix and the chart library set inline
 * style attributes, which a nonce cannot cover. Style injection cannot run
 * code, so this is the usual trade-off.
 *
 * No database or Node-only imports: the proxy imports this module.
 * ════════════════════════════════════════════════════════════════════════════
 */

/** 128 random bits, base64 — fresh for every page request. */
export function generateNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/**
 * @param nonce   per-request nonce
 * @param host    the request's Host header — the realtime service is reached
 *                on port 3003 of the same host when the panel is opened on an
 *                explicit port (see src/lib/socket.ts)
 */
export function buildCsp(nonce: string, host: string | null): string {
  const dev = process.env.NODE_ENV !== 'production'
  const hostname = (host || '').replace(/:\d+$/, '')
  const realtime =
    hostname && /^[a-z0-9.-]+$/i.test(hostname)
      ? ['http', 'https', 'ws', 'wss'].map((s) => `${s}://${hostname}:3003`)
      : []

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...realtime, ...(dev ? ['ws:'] : [])],
    'worker-src': ["'self'", 'blob:'],
    'frame-src': ["'self'"],
    'frame-ancestors': ["'self'"],
    'form-action': ["'self'"],
    'base-uri': ["'self'"],
    'object-src': ["'none'"],
  }
  const policy = Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`)
  if (!dev) policy.push('upgrade-insecure-requests')
  return policy.join('; ')
}
