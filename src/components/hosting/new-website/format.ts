/**
 * Small, dependency-free helpers shared by the New website flow.
 */

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 || value >= 100 ? 0 : 1)} ${units[i]}`
}

/** "3 min left", "40 s left", "about 1 h 20 min left". */
export function formatTimeLeft(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return ''
  const s = Math.max(0, Math.round(seconds))
  if (s < 5) return 'a few seconds left'
  if (s < 60) return `${s} s left`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min left`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `about ${h} h ${rest} min left` : `about ${h} h left`
}

export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return ''
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return ''
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m} min ${s} s` : `${m} min`
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} d ago`
  return new Date(iso).toLocaleDateString()
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function isValidDomain(domain: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(
    domain.trim()
  )
}

/** HTTPS or git@ clone URL with an owner/repo path. */
export function isValidGitUrl(url: string): boolean {
  if (!url) return false
  return /^(https?:\/\/|git@)[\w.-]+[:/][\w.-]+\/[\w.-]+(?:\.git)?\/?$/i.test(url.trim())
}

export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.trim())
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

/**
 * A strong, readable password for the WordPress admin. Generated in the
 * browser so the customer can see and copy it before the site exists — the
 * server would otherwise invent one nobody is ever shown.
 */
export function generatePassword(length = 18): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%+=?'
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

/** File extension check that understands double extensions (.tar.gz). */
export function hasAcceptedExtension(filename: string, accept: string[]): boolean {
  if (accept.length === 0) return true
  const lower = filename.toLowerCase()
  return accept.some((ext) => lower.endsWith(ext.toLowerCase()))
}

/** Offer a website name from an archive's filename. */
export function nameFromFilename(filename: string): string {
  return filename
    .replace(/\.(zip|wpress|tar|tgz|gz|bz2|xz|daf|sql)$/gi, '')
    .replace(/\.(tar|sql)$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}
