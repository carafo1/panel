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
