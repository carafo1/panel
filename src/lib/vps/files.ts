/**
 * File Manager Module
 * ===================
 *
 * Provides safe, project-scoped file operations on a project's `deployPath`
 * on the VPS. Every operation resolves the requested path against the
 * project root and rejects any attempt to escape via `..` or absolute paths
 * — see {@link safePath}.
 *
 * Operations:
 *   - listFiles      — `ls -la --time-style=full-iso` parsed into FileEntry[]
 *   - uploadFile     — SFTP putFile
 *   - downloadFile   — SFTP getFile, returns Buffer
 *   - deleteFile     — `rm -rf` (use with care; path validation is enforced)
 *   - createDirectory— `mkdir -p`
 *   - renameFile     — `mv`
 *   - getFileContent — `cat` (with optional truncation)
 *   - saveFileContent— SFTP putFile (overwrites)
 *
 * In DEMO MODE (no real SSH), every operation works against a synthetic
 * in-memory file tree so the panel's file manager UI is fully functional.
 */
import path from 'path'
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  putFile,
  getFile,
  isServerInDemoMode,
  type SshCredentials,
} from './ssh'
import { getServerCredentials } from './provisioner'

// ─── Types ───────────────────────────────────────────────────────────────

export interface FileEntry {
  name: string
  /** Path relative to deployPath. */
  path: string
  absolutePath: string
  type: 'file' | 'dir' | 'symlink'
  size: number
  /** ISO timestamp. */
  modifiedAt: string
  /** e.g. "rwxr-xr-x". */
  permissions: string
}

// ─── Path safety ─────────────────────────────────────────────────────────

/**
 * Resolve a user-supplied path against the project's deployPath and ensure
 * the result is *inside* the deployPath. Throws if the path:
 *   - is absolute (starts with `/`)
 *   - contains `..` segments (after normalization, escapes the deployPath)
 *
 * Returns the absolute path on the VPS filesystem.
 */
export function safePath(deployPath: string, requested: string): string {
  if (!requested || typeof requested !== 'string') {
    throw new Error('Path is required')
  }
  if (path.isAbsolute(requested)) {
    throw new Error('Absolute paths are not allowed')
  }
  // Reject any ".." segment literally — even before normalization, so users
  // can't sneak a `..` past us via encoded characters etc.
  const segments = requested.split('/')
  if (segments.some((s) => s === '..')) {
    throw new Error('Parent-directory (..) segments are not allowed')
  }

  // Resolve to an absolute path on the VPS and assert it stays inside.
  const base = deployPath.replace(/\/$/, '')
  const resolved = path.posix.normalize(`${base}/${requested}`)
  if (resolved !== base && !resolved.startsWith(base + '/')) {
    throw new Error('Resolved path escapes the project directory')
  }
  return resolved
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Parse a single line of `ls -la --time-style=full-iso` into a FileEntry.
 * Example line:
 *   `-rw-r--r-- 1 root root  1024 2024-01-15 12:34:56.000000000 +0000 filename`
 */
function parseLsLine(line: string, deployPath: string): FileEntry | null {
  if (!line) return null
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('total ')) return null

  // Split on whitespace but keep the filename (which may contain spaces).
  const match = trimmed.match(
    /^([bcdlsp-][rwxst-]{9})\s+\d+\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)? [+-]\d{4})\s+(.+)$/
  )
  if (!match) return null
  const [, perms, , , sizeStr, mtimeStr, nameRaw] = match
  if (!perms || !nameRaw) return null

  // Resolve symlinks: "link -> target"
  let name = nameRaw
  let type: FileEntry['type'] = 'file'
  if (perms.startsWith('d')) type = 'dir'
  else if (perms.startsWith('l')) {
    type = 'symlink'
    const arrowIdx = nameRaw.indexOf(' -> ')
    if (arrowIdx >= 0) name = nameRaw.slice(0, arrowIdx)
  } else if (perms.startsWith('b') || perms.startsWith('c')) {
    type = 'file'
  }

  const size = parseInt(sizeStr, 10) || 0
  const isoMatch = mtimeStr.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/)
  const modifiedAt = isoMatch ? new Date(isoMatch[1] + 'Z').toISOString() : new Date().toISOString()
  const abs = path.posix.normalize(`${deployPath}/${name}`)
  const rel = abs.replace(deployPath.replace(/\/$/, '') + '/', '')

  return {
    name,
    path: rel,
    absolutePath: abs,
    type,
    size,
    modifiedAt,
    permissions: perms.slice(1), // strip the type char
  }
}

// ─── List files ──────────────────────────────────────────────────────────

export async function listFiles(
  projectId: string,
  subdir: string
): Promise<FileEntry[]> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.deployPath) throw new Error('Project has no deployPath (not deployed yet)')

  const resolved = safePath(project.deployPath, subdir || '.')

  // Demo mode: synthetic listing.
  if (isServerInDemoMode(project.server)) {
    return demoListing(resolved, project.deployPath)
  }

  const creds: SshCredentials = await getServerCredentials(project.serverId!)
  return await withConnection(creds, async (client) => {
    const r = await exec(
      client,
      `ls -la --time-style=full-iso ${shellQuote(resolved)} 2>&1`,
      { timeoutMs: 15000 }
    )
    if (r.exitCode !== 0) {
      throw new Error(`ls failed: ${(r.stderr || r.stdout).trim()}`)
    }
    const entries: FileEntry[] = []
    for (const line of r.stdout.split('\n')) {
      const e = parseLsLine(line, resolved)
      if (e && e.name !== '.' && e.name !== '..') {
        entries.push(e)
      }
    }
    return entries
  })
}

// ─── Upload ──────────────────────────────────────────────────────────────

export async function uploadFile(
  projectId: string,
  pathArg: string,
  content: Buffer | string
): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.deployPath) throw new Error('Project has no deployPath')

  const abs = safePath(project.deployPath, pathArg)

  if (isServerInDemoMode(project.server)) {
    return { ok: true, message: `[demo] Uploaded ${path.basename(abs)} (${content.length} bytes)` }
  }

  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    // Ensure parent dir exists, then upload.
    const parent = path.posix.dirname(abs)
    await exec(client, `mkdir -p ${shellQuote(parent)}`, { timeoutMs: 10000 })
    await putFile(client, abs, content, { mode: 0o644 })
  })
  return { ok: true, message: `Uploaded ${path.basename(abs)}` }
}

// ─── Download ────────────────────────────────────────────────────────────

export async function downloadFile(
  projectId: string,
  pathArg: string
): Promise<{ content: Buffer; filename: string; size: number }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.deployPath) throw new Error('Project has no deployPath')

  const abs = safePath(project.deployPath, pathArg)
  const filename = path.posix.basename(abs)

  if (isServerInDemoMode(project.server)) {
    // Synthetic 1KB text body so the browser triggers a download.
    const body = Buffer.from(
      `# ${filename}\n\nThis is a demo-mode placeholder file.\nProject: ${project.slug}\n`
    )
    return { content: body, filename, size: body.length }
  }

  const creds = await getServerCredentials(project.serverId!)
  const content = await withConnection(creds, async (client) => {
    return await getFile(client, abs)
  })
  return { content, filename, size: content.length }
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteFile(
  projectId: string,
  pathArg: string
): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.deployPath) throw new Error('Project has no deployPath')

  const abs = safePath(project.deployPath, pathArg)

  if (isServerInDemoMode(project.server)) {
    return { ok: true, message: `[demo] Deleted ${path.posix.basename(abs)}` }
  }

  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    await exec(client, `rm -rf ${shellQuote(abs)}`, { timeoutMs: 30000 })
  })
  return { ok: true, message: 'Deleted' }
}

// ─── Create directory ────────────────────────────────────────────────────

export async function createDirectory(
  projectId: string,
  pathArg: string
): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.deployPath) throw new Error('Project has no deployPath')

  const abs = safePath(project.deployPath, pathArg)

  if (isServerInDemoMode(project.server)) {
    return { ok: true, message: `[demo] Created directory ${path.posix.basename(abs)}` }
  }

  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    await exec(client, `mkdir -p ${shellQuote(abs)}`, { timeoutMs: 10000 })
  })
  return { ok: true, message: 'Directory created' }
}

// ─── Rename ──────────────────────────────────────────────────────────────

export async function renameFile(
  projectId: string,
  oldPath: string,
  newPath: string
): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.deployPath) throw new Error('Project has no deployPath')

  const absOld = safePath(project.deployPath, oldPath)
  const absNew = safePath(project.deployPath, newPath)

  if (isServerInDemoMode(project.server)) {
    return { ok: true, message: `[demo] Renamed ${oldPath} → ${newPath}` }
  }

  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    const parent = path.posix.dirname(absNew)
    await exec(client, `mkdir -p ${shellQuote(parent)}`, { timeoutMs: 10000 })
    await exec(client, `mv ${shellQuote(absOld)} ${shellQuote(absNew)}`, { timeoutMs: 30000 })
  })
  return { ok: true, message: 'Renamed' }
}

// ─── Get / save text content ─────────────────────────────────────────────

const MAX_TEXT_BYTES = 1024 * 1024 // 1 MB cap for in-browser text editing.

export async function getFileContent(
  projectId: string,
  pathArg: string,
  maxBytes = MAX_TEXT_BYTES
): Promise<{ content: string; size: number; truncated: boolean }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.deployPath) throw new Error('Project has no deployPath')

  const abs = safePath(project.deployPath, pathArg)

  if (isServerInDemoMode(project.server)) {
    const demo = `# ${path.posix.basename(abs)}\n\nThis is a demo-mode placeholder.\n`
    return { content: demo, size: demo.length, truncated: false }
  }

  const creds = await getServerCredentials(project.serverId!)
  return await withConnection(creds, async (client) => {
    // Use head -c so we never pull a multi-GB file into memory.
    const r = await exec(
      client,
      `wc -c < ${shellQuote(abs)}; echo "---"; head -c ${maxBytes + 1} ${shellQuote(abs)} 2>/dev/null`,
      { timeoutMs: 30000 }
    )
    const parts = r.stdout.split('---')
    const sizeStr = (parts[0] || '').trim()
    const size = parseInt(sizeStr, 10) || 0
    const raw = (parts[1] || '').toString('utf8')
    const truncated = raw.length > maxBytes
    const content = truncated ? raw.slice(0, maxBytes) : raw
    return { content, size, truncated }
  })
}

export async function saveFileContent(
  projectId: string,
  pathArg: string,
  content: string
): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.deployPath) throw new Error('Project has no deployPath')

  const abs = safePath(project.deployPath, pathArg)

  if (isServerInDemoMode(project.server)) {
    return { ok: true, message: `[demo] Saved ${path.posix.basename(abs)} (${content.length} bytes)` }
  }

  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    const parent = path.posix.dirname(abs)
    await exec(client, `mkdir -p ${shellQuote(parent)}`, { timeoutMs: 10000 })
    await putFile(client, abs, content, { mode: 0o644 })
  })
  return { ok: true, message: 'Saved' }
}

// ─── Demo-mode synthetic listing ─────────────────────────────────────────

function demoListing(resolved: string, deployPath: string): FileEntry[] {
  // Only the root has a synthetic tree; subdirs return empty.
  const isRoot = resolved.replace(/\/$/, '') === deployPath.replace(/\/$/, '')
  if (!isRoot) return []
  const now = new Date().toISOString()
  const mk = (
    name: string,
    type: FileEntry['type'],
    size: number,
    perms: string
  ): FileEntry => ({
    name,
    path: name,
    absolutePath: `${deployPath.replace(/\/$/, '')}/${name}`,
    type,
    size,
    modifiedAt: now,
    permissions: perms,
  })
  return [
    mk('public', 'dir', 4096, 'rwxr-xr-x'),
    mk('index.html', 'file', 612, 'rw-r--r--'),
    mk('README.md', 'file', 184, 'rw-r--r--'),
    mk('package.json', 'file', 256, 'rw-r--r--'),
    mk('Dockerfile', 'file', 412, 'rw-r--r--'),
    mk('.env.example', 'file', 88, 'rw-r--r--'),
  ]
}
