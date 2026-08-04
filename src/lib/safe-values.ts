/**
 * Validators for customer-supplied values that end up inside generated
 * docker-compose.yml and Dockerfile text.
 *
 * Why this exists
 * ---------------
 * The compose generator built the environment block by string interpolation:
 *
 *     `      ${k}: "${v.replace(/"/g, '\\"')}"`
 *
 * The KEY was not escaped at all, and env-var keys were accepted as "any
 * non-empty string". A customer could therefore save a variable named
 *
 *     X: "1"\n    privileged: true\n    volumes:\n      - "/:/host:rw"\n    user
 *
 * with the value `0:0`, and the generator would close the `environment:` block
 * and emit `privileged`, `volumes` and `user` as siblings of the service.
 * Docker parsed that without complaint: a root-owned privileged container with
 * the host filesystem bind-mounted read-write. That is host root, and with it
 * every other tenant's files, databases and backups on the same machine.
 *
 * Two layers, because either alone is not enough:
 *   - the API rejects hostile input, so it never reaches the database;
 *   - the emitter escapes and re-checks, because rows written before this
 *     landed (or by any future write path) must not be able to deploy.
 */

/**
 * POSIX environment variable name. Docker itself will not accept anything
 * outside this, so nothing legitimate is lost by requiring it.
 */
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export function isValidEnvKey(key: unknown): key is string {
  return typeof key === 'string' && ENV_KEY_RE.test(key)
}

export const ENV_KEY_ERROR =
  'Environment variable names must start with a letter or underscore and ' +
  'contain only letters, numbers and underscores (max 128 characters).'

/** C0 control characters, minus the ones given their own escape above. */
const CONTROL_RE = new RegExp(
  '[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]',
  'g'
)

/**
 * Escape a string for a YAML double-quoted scalar.
 *
 * The backslash MUST be escaped first: the previous code escaped only `"`, so
 * a value ending in a single backslash produced `"...\"` — the closing quote
 * was itself escaped, the scalar ran on into the following lines, and the
 * document meant something other than what it looked like.
 */
export function yamlQuoted(s: string): string {
  const body = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(CONTROL_RE, (c) =>
      '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0')
    )
  return `"${body}"`
}

/**
 * A runtime version goes straight into a Dockerfile `FROM` line
 * (`FROM node:${v}-alpine`). A newline there appends arbitrary build
 * instructions, so keep it to what a real image tag looks like.
 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/

export function safeRuntimeVersion(v: unknown, fallback: string): string {
  return typeof v === 'string' && VERSION_RE.test(v) ? v : fallback
}

/**
 * The document root is interpolated into `COPY . ${root}/` and
 * `RUN chown -R www-data:www-data ${root}` — an unchecked value is arbitrary
 * `RUN` at build time. Absolute, no traversal, no shell metacharacters.
 */
const DOC_ROOT_RE = /^\/[A-Za-z0-9._\-/]{0,255}$/

export function safeDocumentRoot(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  if (!DOC_ROOT_RE.test(v)) return fallback
  if (v.includes('..') || v.includes('//')) return fallback
  return v.replace(/\/+$/, '') || fallback
}

/** A TCP port, or null when the input is not one. */
export function safePort(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isInteger(n)) return null
  if (n < 1 || n > 65535) return null
  return n
}
