/**
 * Pure helpers for the website file manager (unit-tested).
 *
 * Paths are always relative to the website's deploy path, with "/" separators
 * and no leading slash; the deploy path itself is "".
 */

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  modifiedAt: string
  permissions: string
}

/**
 * The folder that holds the website itself. WordPress sites keep everything in
 * <deployPath>/site (mounted as /var/www/html); imported sites do the same.
 */
export const DOCUMENT_ROOT_DIR = 'site'

/**
 * Files at the deploy path root that the platform writes and rewrites. Editing
 * or deleting them can take the site down, and a redeploy may overwrite edits.
 */
const MANAGED_ROOT_FILES = new Set(['docker-compose.yml', 'dockerfile', '.dockerignore', 'wp-config-docker.php'])

export function isManagedFile(entry: Pick<FileEntry, 'path' | 'name'>): boolean {
  if (entry.path.includes('/')) return false
  return MANAGED_ROOT_FILES.has(entry.name.toLowerCase())
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'csv', 'tsv', 'log',
  'env', 'ini', 'conf', 'cfg', 'toml', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs',
  'py', 'rb', 'php', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift',
  'kt', 'sh', 'bash', 'zsh', 'sql', 'graphql', 'gql', 'vue', 'svelte', 'astro',
  'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg', 'htaccess', 'example',
  'lock', 'map', 'twig', 'blade', 'phtml', 'tpl', 'po', 'pot', 'gitignore',
  'dockerignore', 'editorconfig', 'npmrc', 'nvmrc', 'babelrc', 'prettierrc',
])

/** Extension-less names that are text. */
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'procfile', 'readme', 'license', 'changelog', 'caddyfile'])

export function isLikelyTextFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (TEXT_NAMES.has(lower)) return true
  if (lower.startsWith('.env')) return true
  const dot = lower.lastIndexOf('.')
  if (dot === -1) return false
  return TEXT_EXTENSIONS.has(lower.slice(dot + 1))
}

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz)$/i
export function isArchive(name: string): boolean {
  return ARCHIVE_RE.test(name)
}

export type FileKind = 'folder' | 'link' | 'code' | 'image' | 'archive' | 'text' | 'other'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp', 'svg'])
const CODE_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'php', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp',
  'cs', 'sh', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'json', 'yml', 'yaml', 'xml',
])

export function fileKind(entry: Pick<FileEntry, 'name' | 'type'>): FileKind {
  if (entry.type === 'directory') return 'folder'
  if (entry.type === 'symlink') return 'link'
  const lower = entry.name.toLowerCase()
  if (isArchive(lower)) return 'archive'
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (IMAGE_EXT.has(ext)) return 'image'
  if (CODE_EXT.has(ext) || lower === 'dockerfile') return 'code'
  if (isLikelyTextFile(lower)) return 'text'
  return 'other'
}

export type SortKey = 'name' | 'size' | 'modified'
export type SortDir = 'asc' | 'desc'

/** Folders first, then the chosen column; names compare naturally (file2 < file10). */
export function sortEntries(entries: FileEntry[], key: SortKey, dir: SortDir): FileEntry[] {
  const mul = dir === 'asc' ? 1 : -1
  const byName = (a: FileEntry, b: FileEntry) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'directory' ? 0 : 1
    const bDir = b.type === 'directory' ? 0 : 1
    if (aDir !== bDir) return aDir - bDir
    let cmp = 0
    if (key === 'size') cmp = (a.size || 0) - (b.size || 0)
    else if (key === 'modified') cmp = new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime()
    if (cmp === 0) cmp = byName(a, b)
    return cmp * mul
  })
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir.replace(/\/+$/, '')}/${name}` : name
}

/** Parent of a path ("" for top-level entries and for the root). */
export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

/** Encode each segment for the /files/[...path] routes, keeping "/" separators. */
export function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/')
}

/**
 * A single new file or folder name. Returns an error message, or null when
 * the name is usable. Paths ("a/b") and traversal are refused.
 */
export function validateName(raw: string, existing: string[] = []): string | null {
  const name = raw.trim()
  if (!name) return 'Enter a name.'
  if (name === '.' || name === '..') return 'That name is reserved.'
  if (/[\\/]/.test(name)) return 'A name cannot contain / or \\.'
  if (name.length > 255) return 'That name is too long (255 characters at most).'
  if (existing.some((e) => e.toLowerCase() === name.toLowerCase())) return 'Something with that name already exists here.'
  return null
}

/** "rwxr-xr-x" → "755". Returns null for anything that is not 9 mode chars. */
export function toOctal(perms: string): string | null {
  if (!/^[rwxsStT-]{9}$/.test(perms)) return null
  let out = ''
  for (let i = 0; i < 9; i += 3) {
    const r = perms[i] === 'r' ? 4 : 0
    const w = perms[i + 1] === 'w' ? 2 : 0
    const x = /[xst]/.test(perms[i + 2]) ? 1 : 0
    out += String(r + w + x)
  }
  return out
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

// ─── Permissions dialog ──────────────────────────────────────────────────

/** One row of the permissions grid: owner, group, others. */
export type PermWho = 'owner' | 'group' | 'others'
export type PermBit = 'read' | 'write' | 'execute'
export type PermGrid = Record<PermWho, Record<PermBit, boolean>>

const WHO: PermWho[] = ['owner', 'group', 'others']

/** "755" → grid. Anything that is not three octal digits gives an all-false grid. */
export function gridFromOctal(octal: string): PermGrid {
  const digits = /^[0-7]{3}$/.test(octal) ? octal : '000'
  const grid = {} as PermGrid
  WHO.forEach((who, i) => {
    const d = Number(digits[i])
    grid[who] = { read: !!(d & 4), write: !!(d & 2), execute: !!(d & 1) }
  })
  return grid
}

/** Grid → "755". */
export function octalFromGrid(grid: PermGrid): string {
  return WHO.map((who) => String((grid[who].read ? 4 : 0) + (grid[who].write ? 2 : 0) + (grid[who].execute ? 1 : 0))).join('')
}

/**
 * Validate a mode typed in the dialog. Mirrors the server (file-ops.ts):
 * three octal digits; a leading 0 is accepted; setuid / setgid refused.
 */
export function validateOctalMode(raw: string): { ok: true; mode: string } | { ok: false; error: string } {
  const s = raw.trim()
  if (!/^[0-7]{3,4}$/.test(s)) return { ok: false, error: 'Use three digits from 0 to 7, such as 644 or 755.' }
  if (s.length === 4) {
    const special = Number(s[0])
    if (special & 6) return { ok: false, error: 'Setuid and setgid cannot be set here.' }
    if (special !== 0) return { ok: false, error: 'Special bits are not supported here; use three digits.' }
    return { ok: true, mode: s.slice(1) }
  }
  return { ok: true, mode: s }
}

/** "rwxr-xr-x" → readable summary for the dialog, e.g. "Owner can read, write and run". */
export function describeOctal(octal: string): string {
  if (!/^[0-7]{3}$/.test(octal)) return ''
  const grid = gridFromOctal(octal)
  const part = (who: PermWho, label: string) => {
    const g = grid[who]
    const can = [g.read && 'read', g.write && 'write', g.execute && 'run'].filter(Boolean) as string[]
    if (!can.length) return `${label}: no access`
    return `${label}: ${can.length > 1 ? can.slice(0, -1).join(', ') + ' and ' + can[can.length - 1] : can[0]}`
  }
  return [part('owner', 'Owner'), part('group', 'Group'), part('others', 'Everyone else')].join(' · ')
}

// ─── Preview ─────────────────────────────────────────────────────────────

const PREVIEW_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg'])

/** 'image' / 'pdf' when the preview endpoint can show this file, else null. */
export function previewKind(name: string): 'image' | 'pdf' | null {
  const lower = name.toLowerCase()
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : ''
  if (ext === 'pdf') return 'pdf'
  if (PREVIEW_IMAGE.has(ext)) return 'image'
  return null
}

/** Default archive name for a selection: the item's name, or the folder's. */
export function defaultZipName(selection: string[], folder: string): string {
  if (selection.length === 1) {
    const name = selection[0].slice(selection[0].lastIndexOf('/') + 1)
    return `${name.replace(/\.(zip|tar|tar\.gz|tgz)$/i, '')}.zip`
  }
  const base = folder ? folder.slice(folder.lastIndexOf('/') + 1) : 'website'
  return `${base}-files.zip`
}
