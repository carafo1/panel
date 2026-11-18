/**
 * Redirect validation
 * ===================
 *
 * A redirect becomes a `redir <from> <to> <code>` line in the Caddyfile that
 * every tenant on the server shares. Caddy splits tokens on whitespace,
 * treats `{ }` as block delimiters and `{…}` as placeholders, and `"`/`` ` ``
 * as quotes. A value carrying a newline and a `}` closes the site block and
 * opens a new one for any hostname the author likes — so these values are
 * checked when stored AND again where the Caddyfile is generated.
 *
 * Pure (no database), so it is unit-tested directly.
 */

export class RedirectValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RedirectValidationError'
  }
}

const MAX_LEN = 2048

/**
 * Characters that can change the meaning of a Caddyfile line: any whitespace
 * (Go's unicode.IsSpace includes U+0085 and U+00A0, which JS `\s` partly
 * misses, so C1 controls are listed too), C0/C1 controls, braces, quotes,
 * backticks, backslashes, and `#` (comment start).
 */
const UNSAFE = /[\s\u0000-\u001f\u007f-\u009f{}"'`\\#]/

export function redirectFromPathError(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'From path is required'
  const p = raw.trim()
  if (!p) return 'From path is required'
  if (!p.startsWith('/')) return 'From path must start with "/"'
  if (p.length > MAX_LEN) return 'From path is too long'
  if (UNSAFE.test(p)) {
    return 'From path must not contain spaces, quotes, braces, backslashes, "#" or control characters'
  }
  return null
}

/**
 * The destination may be an absolute http(s) URL or a path on the same site
 * (starting with "/"), which is what the dashboard form offers.
 */
export function redirectToUrlError(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'To URL is required'
  const u = raw.trim()
  if (!u) return 'To URL is required'
  if (u.length > MAX_LEN) return 'To URL is too long'
  // '#' is legitimate in a destination (a fragment), but never at the start
  // of the token, which is the only place Caddy reads it as a comment.
  if (/[\s\u0000-\u001f\u007f-\u009f{}"'`\\]/.test(u)) {
    return 'To URL must not contain spaces, quotes, braces, backslashes or control characters'
  }
  if (u.startsWith('/')) return null
  if (!/^https?:\/\//i.test(u)) return 'To URL must start with http://, https:// or "/"'
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'To URL must use http:// or https://'
    }
    if (!parsed.hostname) return 'To URL must include a host name'
  } catch {
    return 'To URL is not a valid URL'
  }
  return null
}

export function redirectStatusError(code: unknown): string | null {
  return code === 301 || code === 302 ? null : 'Status code must be 301 or 302'
}

/** True when a stored redirect is safe to write into the Caddyfile. */
export function isSafeRedirect(r: { fromPath: string; toUrl: string; statusCode: number }): boolean {
  return (
    redirectFromPathError(r.fromPath) === null &&
    redirectToUrlError(r.toUrl) === null &&
    redirectStatusError(r.statusCode) === null &&
    r.fromPath === r.fromPath.trim() &&
    r.toUrl === r.toUrl.trim()
  )
}

/** Build the Caddy directive, refusing anything unsafe (last line of defence). */
export function caddyRedirLine(r: { fromPath: string; toUrl: string; statusCode: number }): string {
  if (!isSafeRedirect(r)) {
    throw new RedirectValidationError(
      `Refusing to write proxy config: redirect ${JSON.stringify(r.fromPath)} -> ${JSON.stringify(r.toUrl)} is not safe.`
    )
  }
  return `redir ${r.fromPath} ${r.toUrl} ${r.statusCode}`
}
