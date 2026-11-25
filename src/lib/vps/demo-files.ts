/**
 * Demo-mode file system for the file manager
 * ==========================================
 *
 * When a website's server runs in demo mode (no SSH host, or VPS_DEMO_MODE=1
 * as in the e2e suite) nothing can be read from a real disk. Instead of a
 * fixed listing, each website gets a small in-memory tree shaped like a real
 * WordPress deploy: the platform files at the root and the website in site/.
 * Every file-manager action (upload, edit, rename, delete, chmod, copy, move,
 * compress, extract, preview) works against it, so the whole flow can be
 * tried and tested without a server.
 *
 * The tree lives in the server process only (lost on restart) and is capped
 * in size. It is never used for a real server.
 */
import { deflateSync } from 'zlib'
import { normalizeRel } from './file-ops'

export interface DemoEntry {
  name: string
  /** Relative to the deploy root. */
  path: string
  type: 'file' | 'dir'
  size: number
  modifiedAt: string
  /** e.g. "rw-r--r--". */
  permissions: string
}

interface DemoNode {
  type: 'file' | 'dir'
  size: number
  mode: number
  mtime: number
  content?: Buffer
  /** For a .zip made by compress(): what it holds, so extract() can restore it. */
  archive?: Array<{ rel: string; node: DemoNode }>
}

type Tree = Map<string, DemoNode>

/** Bytes of content kept per file; larger uploads keep only their size. */
const MAX_CONTENT_BYTES = 2 * 1024 * 1024
/** Most entries one demo website may hold. */
const MAX_NODES = 5000

export class DemoFsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DemoFsError'
  }
}

const store = (): Map<string, Tree> => {
  const g = globalThis as unknown as { __apsamoDemoFs?: Map<string, Tree> }
  if (!g.__apsamoDemoFs) g.__apsamoDemoFs = new Map()
  return g.__apsamoDemoFs
}

// ─── Seed content ──────────────────────────────────────────────────────────

function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

/** A small real PNG (a green leaf on a light tile) so image preview has something to show. */
function demoPng(): Buffer {
  const size = 96
  const raw = Buffer.alloc((size * 3 + 1) * size)
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const dx = (x - size / 2) / (size / 2)
      const dy = (y - size / 2) / (size / 2)
      // A leaf: the overlap of two offset circles.
      const inLeaf = (dx - 0.3) ** 2 + (dy + 0.3) ** 2 < 0.55 && (dx + 0.3) ** 2 + (dy - 0.3) ** 2 < 0.55
      const vein = inLeaf && Math.abs(dx + dy) < 0.05
      const [r, g, b] = vein ? [220, 252, 231] : inLeaf ? [22, 163, 74] : [240, 253, 244]
      const o = row + 1 + x * 3
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** A one-page PDF with a line of text. */
function demoPdf(): Buffer {
  const text = 'Erin Garden Shop - price list (demo)'
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function seed(): Tree {
  const t: Tree = new Map()
  const now = Date.now()
  const dir = (rel: string, mode = 0o755) => t.set(rel, { type: 'dir', size: 4096, mode, mtime: now })
  const file = (rel: string, content: string | Buffer, mode = 0o644) => {
    const buf = typeof content === 'string' ? Buffer.from(content) : content
    t.set(rel, { type: 'file', size: buf.length, mode, mtime: now, content: buf })
  }
  dir('')
  file(
    'docker-compose.yml',
    'services:\n  wordpress:\n    image: wordpress:php8.3-apache\n    volumes:\n      - ./site:/var/www/html\n    restart: unless-stopped\n'
  )
  file('Dockerfile', 'FROM wordpress:php8.3-apache\nCOPY wp-config-docker.php /usr/src/wordpress/\n')
  file('.dockerignore', '.git\nnode_modules\n')
  dir('site')
  file('site/index.php', "<?php\ndefine('WP_USE_THEMES', true);\nrequire __DIR__ . '/wp-blog-header.php';\n")
  file('site/wp-config.php', "<?php\n// Database settings are injected by the platform.\n$table_prefix = 'wp_';\nrequire_once ABSPATH . 'wp-settings.php';\n", 0o640)
  file('site/.htaccess', '# BEGIN WordPress\nRewriteEngine On\nRewriteRule ^index\\.php$ - [L]\n# END WordPress\n')
  file('site/readme.html', '<!DOCTYPE html>\n<html><body><h1>WordPress</h1></body></html>\n')
  file('site/license.txt', 'WordPress - Web publishing software\n')
  dir('site/wp-admin')
  dir('site/wp-includes')
  dir('site/wp-content')
  dir('site/wp-content/themes')
  dir('site/wp-content/themes/twentytwentyfour')
  file('site/wp-content/themes/twentytwentyfour/style.css', '/*\nTheme Name: Twenty Twenty-Four\n*/\n')
  dir('site/wp-content/plugins')
  dir('site/wp-content/uploads')
  dir('site/wp-content/uploads/2026')
  dir('site/wp-content/uploads/2026/11')
  file('site/wp-content/uploads/2026/11/garden-logo.png', demoPng())
  file('site/wp-content/uploads/2026/11/price-list.pdf', demoPdf())
  return t
}

function tree(projectId: string): Tree {
  const s = store()
  let t = s.get(projectId)
  if (!t) {
    t = seed()
    s.set(projectId, t)
  }
  return t
}

/** Forget a website's demo tree (tests). */
export function resetDemoFiles(projectId?: string): void {
  if (projectId) store().delete(projectId)
  else store().clear()
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function modeString(mode: number): string {
  const bits = 'rwxrwxrwx'
  let out = ''
  for (let i = 0; i < 9; i++) out += mode & (1 << (8 - i)) ? bits[i] : '-'
  if (mode & 0o1000) out = out.slice(0, 8) + (mode & 1 ? 't' : 'T')
  return out
}

const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const baseName = (rel: string) => rel.slice(rel.lastIndexOf('/') + 1)
const isUnder = (parent: string, rel: string) => (parent === '' ? rel !== '' : rel.startsWith(parent + '/'))

function get(t: Tree, rel: string): DemoNode | undefined {
  return t.get(normalizeRel(rel))
}

function requireDir(t: Tree, rel: string): void {
  const n = get(t, rel)
  if (!n) throw new DemoFsError('That folder does not exist.')
  if (n.type !== 'dir') throw new DemoFsError('That is a file, not a folder.')
}

function ensureParents(t: Tree, rel: string): void {
  const parts = rel.split('/')
  for (let i = 1; i < parts.length; i++) {
    const p = parts.slice(0, i).join('/')
    const n = t.get(p)
    if (n && n.type !== 'dir') throw new DemoFsError(`${p} is a file, not a folder.`)
    if (!n) t.set(p, { type: 'dir', size: 4096, mode: 0o755, mtime: Date.now() })
  }
}

function checkCapacity(t: Tree, adding: number): void {
  if (t.size + adding > MAX_NODES) throw new DemoFsError('The demo file space is full. Delete something first.')
}

/** The node and everything under it, as relative-to-`rel` snapshots. */
function subtree(t: Tree, rel: string): Array<{ rel: string; node: DemoNode }> {
  const out: Array<{ rel: string; node: DemoNode }> = []
  for (const [k, n] of t) if (k === rel || isUnder(rel, k)) out.push({ rel: k, node: n })
  return out
}

function cloneNode(n: DemoNode): DemoNode {
  return { ...n, content: n.content ? Buffer.from(n.content) : undefined, archive: n.archive?.map((a) => ({ rel: a.rel, node: cloneNode(a.node) })) }
}

// ─── Operations ────────────────────────────────────────────────────────────

export function demoList(projectId: string, dirRel: string): DemoEntry[] {
  const t = tree(projectId)
  const dir = normalizeRel(dirRel)
  requireDir(t, dir)
  const out: DemoEntry[] = []
  for (const [k, n] of t) {
    if (k === '' || parentOf(k) !== dir) continue
    out.push({
      name: baseName(k),
      path: k,
      type: n.type,
      size: n.size,
      modifiedAt: new Date(n.mtime).toISOString(),
      permissions: modeString(n.mode),
    })
  }
  return out
}

export function demoStat(projectId: string, rel: string): { type: 'file' | 'dir'; size: number } | null {
  const n = get(tree(projectId), rel)
  return n ? { type: n.type, size: n.size } : null
}

export function demoRead(projectId: string, rel: string): Buffer | null {
  const n = get(tree(projectId), rel)
  if (!n) throw new DemoFsError('That file does not exist.')
  if (n.type !== 'file') throw new DemoFsError('That is a folder, not a file.')
  return n.content ?? null
}

export function demoWrite(projectId: string, rel: string, content: Buffer | string): void {
  const t = tree(projectId)
  const r = normalizeRel(rel)
  if (!r) throw new DemoFsError('Choose a file name.')
  const existing = t.get(r)
  if (existing?.type === 'dir') throw new DemoFsError('A folder with that name already exists.')
  if (!existing) checkCapacity(t, 1 + r.split('/').length)
  ensureParents(t, r)
  const buf = typeof content === 'string' ? Buffer.from(content) : content
  t.set(r, {
    type: 'file',
    size: buf.length,
    mode: existing?.mode ?? 0o644,
    mtime: Date.now(),
    content: buf.length <= MAX_CONTENT_BYTES ? Buffer.from(buf) : undefined,
  })
}

export function demoMkdir(projectId: string, rel: string): void {
  const t = tree(projectId)
  const r = normalizeRel(rel)
  if (!r) return
  const existing = t.get(r)
  if (existing?.type === 'file') throw new DemoFsError('A file with that name already exists.')
  if (existing) return
  checkCapacity(t, r.split('/').length)
  ensureParents(t, r)
  t.set(r, { type: 'dir', size: 4096, mode: 0o755, mtime: Date.now() })
}

export function demoRemove(projectId: string, rel: string): void {
  const t = tree(projectId)
  const r = normalizeRel(rel)
  if (!r) throw new DemoFsError('The website root folder cannot be deleted.')
  if (!t.has(r)) throw new DemoFsError('That file does not exist.')
  for (const { rel: k } of subtree(t, r)) t.delete(k)
}

export function demoRename(projectId: string, fromRel: string, toRel: string): void {
  const t = tree(projectId)
  const from = normalizeRel(fromRel)
  const to = normalizeRel(toRel)
  if (!from || !t.has(from)) throw new DemoFsError('That file does not exist.')
  if (!to) throw new DemoFsError('Choose a new name.')
  if (to === from) return
  if (t.has(to)) throw new DemoFsError('Something with that name already exists there.')
  if (isUnder(from, to)) throw new DemoFsError('A folder cannot be moved into itself.')
  ensureParents(t, to)
  const items = subtree(t, from)
  for (const { rel } of items) t.delete(rel)
  for (const { rel, node } of items) t.set(to + rel.slice(from.length), node)
}

export function demoCopy(projectId: string, fromRel: string, toRel: string): void {
  const t = tree(projectId)
  const from = normalizeRel(fromRel)
  const to = normalizeRel(toRel)
  if (!from || !t.has(from)) throw new DemoFsError('That file does not exist.')
  if (!to) throw new DemoFsError('Choose a destination.')
  if (t.has(to)) throw new DemoFsError('Something with that name already exists there.')
  if (isUnder(from, to) || to === from) throw new DemoFsError('A folder cannot be copied into itself.')
  const items = subtree(t, from)
  checkCapacity(t, items.length)
  ensureParents(t, to)
  const now = Date.now()
  for (const { rel, node } of items) t.set(to + rel.slice(from.length), { ...cloneNode(node), mtime: now })
}

export function demoChmod(
  projectId: string,
  rel: string,
  opts: { mode: string; recursive?: false } | { recursive: true; dirMode: string; fileMode: string }
): number {
  const t = tree(projectId)
  const r = normalizeRel(rel)
  const n = t.get(r)
  if (!n) throw new DemoFsError('That file does not exist.')
  if (!opts.recursive) {
    n.mode = parseInt(opts.mode, 8)
    return 1
  }
  if (n.type !== 'dir') throw new DemoFsError('Only folders can be changed recursively.')
  let count = 0
  for (const { node } of subtree(t, r)) {
    node.mode = parseInt(node.type === 'dir' ? opts.dirMode : opts.fileMode, 8)
    count++
  }
  return count
}

/** Compress `names` (relative to `dirRel`) into `dirRel/zipName`. Returns the archive size. */
export function demoCompress(projectId: string, dirRel: string, names: string[], zipName: string): number {
  const t = tree(projectId)
  const dir = normalizeRel(dirRel)
  requireDir(t, dir)
  const out = dir ? `${dir}/${zipName}` : zipName
  if (t.has(out)) throw new DemoFsError(`${zipName} already exists in this folder.`)
  const archive: Array<{ rel: string; node: DemoNode }> = []
  let bytes = 0
  for (const name of names) {
    const src = dir ? `${dir}/${normalizeRel(name)}` : normalizeRel(name)
    if (!t.has(src)) throw new DemoFsError(`${name} does not exist.`)
    const cut = parentOf(src).length ? parentOf(src).length + 1 : 0
    for (const { rel, node } of subtree(t, src)) {
      archive.push({ rel: rel.slice(cut), node: cloneNode(node) })
      bytes += node.type === 'file' ? node.size : 0
    }
  }
  checkCapacity(t, 1)
  // A plausible compressed size; the demo does not really deflate anything.
  const size = Math.max(22, Math.round(bytes * 0.42) + archive.length * 76)
  t.set(out, { type: 'file', size, mode: 0o644, mtime: Date.now(), archive })
  return size
}

/**
 * Extract an archive made by demoCompress into `destRel`. Archives uploaded
 * in demo mode have no readable contents and are refused honestly.
 */
export function demoExtract(projectId: string, archiveRel: string, destRel: string, overwrite: boolean): number {
  const t = tree(projectId)
  const n = get(t, archiveRel)
  if (!n || n.type !== 'file') throw new DemoFsError('That archive does not exist.')
  if (!n.archive) {
    throw new DemoFsError('In demo mode only archives created with Compress can be extracted.')
  }
  const dest = normalizeRel(destRel)
  const destNode = t.get(dest)
  if (destNode && destNode.type !== 'dir') throw new DemoFsError('The destination is a file, not a folder.')
  checkCapacity(t, n.archive.length + 1)
  demoMkdir(projectId, dest)
  let written = 0
  const now = Date.now()
  for (const { rel, node } of n.archive) {
    const target = dest ? `${dest}/${rel}` : rel
    const existing = t.get(target)
    if (existing) {
      if (existing.type !== node.type) throw new DemoFsError(`${rel} would replace a ${existing.type === 'dir' ? 'folder' : 'file'} of the same name.`)
      if (node.type === 'dir' || !overwrite) continue
    }
    ensureParents(t, target)
    t.set(target, { ...cloneNode(node), mtime: now })
    if (node.type === 'file') written++
  }
  return written
}
