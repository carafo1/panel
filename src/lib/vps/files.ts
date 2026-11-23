/**
 * File Manager Module
 * ===================
 *
 * Provides safe, project-scoped file operations.
 *
 * Two execution modes:
 *
 *   - LOCAL (server.sshHost === 'localhost' / 127.0.0.1 / ::1):
 *       Every operation runs against a per-project storage root at
 *       `<STORAGE_ROOT>/projects/<projectId>/` on the panel host via the
 *       LocalClient (child_process + local fs). Path traversal is rejected
 *       by `pathTraversalSafe`. The "home" directory is the project root,
 *       created lazily on first access (ensureDir).
 *
 *   - REMOTE (real VPS over SSH):
 *       Operations run against the project's `deployPath` on the remote
 *       host via SFTP (`putFile`/`getFile`) + `exec` for ls/mkdir/rm/mv.
 *       Path safety is enforced by `safePath`.
 *
 *   - DEMO (no sshHost + no creds):
 *       Synthetic in-memory listing so the panel's file manager UI still
 *       works in pure-demo mode.
 *
 * Operations:
 *   - listFiles      — `ls -la --time-style=full-iso` parsed into FileEntry[]
 *   - uploadFile     — SFTP putFile (local: copyFile via LocalSftp)
 *   - downloadFile   — SFTP getFile (local: copyFile via LocalSftp)
 *   - deleteFile     — `rm -rf` (use with care; path validation is enforced)
 *   - createDirectory— `mkdir -p`
 *   - renameFile     — `mv`
 *   - getFileContent — `cat` (with optional truncation)
 *   - saveFileContent— SFTP putFile (overwrites)
 */
import path from 'path'
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  putFile,
  getFile,
  isServerInDemoMode,
  isLocalHost,
  type SshCredentials,
} from './ssh'
import { ensureDir } from './local-exec'
import { getServerCredentials } from './provisioner'
import {
  assertConfinedLocal,
  confinementGuardScript,
  guardFailureMessage,
  PathConfinementError,
  type ConfineMode,
} from './path-confine'
import { archiveListingCommand, findUnsafeArchiveEntries, unsafeArchiveMessage } from './archive-safety'

/**
 * A path the customer asked for that we refuse (absolute, `..`, escapes the
 * site). It is the caller's mistake, so routes answer 400 with this message
 * rather than a 500 "internal error".
 */
export class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathError'
  }
}

// ─── Per-project storage root (LOCAL mode) ──────────────────────────────

/**
 * Root directory for all panel-managed local storage. Defaults to
 * `<cwd>/storage` (i.e. `/home/z/my-project/storage` in the sandbox).
 * Override with the STORAGE_ROOT env var.
 */
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage')

/**
 * Per-project local storage root for the file manager.
 *
 * In LOCAL mode every file the user creates/uploads lives under this
 * directory. Path traversal checks guarantee no operation can escape it.
 */
function PROJECT_ROOT(projectId: string): string {
  return path.join(STORAGE_ROOT, 'projects', projectId)
}

/**
 * Resolve a user-supplied relative path against an arbitrary root and ensure
 * the result stays *inside* the root. Throws if the path:
 *   - is empty
 *   - is absolute (starts with `/`)
 *   - contains `..` segments (literal check before normalization, so users
 *     can't sneak a `..` past us via encoded characters etc.)
 *   - escapes the root after posix normalization
 *
 * Returns the resolved absolute path on the host filesystem.
 */
export function pathTraversalSafe(root: string, requested: string): string {
  if (!requested || typeof requested !== 'string') {
    throw new PathError('Path is required')
  }
  if (path.isAbsolute(requested)) {
    throw new PathError('Absolute paths are not allowed')
  }
  const segments = requested.split('/')
  if (segments.some((s) => s === '..')) {
    throw new PathError('Parent-directory (..) segments are not allowed')
  }
  const base = root.replace(/\/$/, '')
  const resolved = path.posix.normalize(`${base}/${requested}`)
  if (resolved !== base && !resolved.startsWith(base + '/')) {
    throw new PathError('Resolved path escapes the project directory')
  }
  return resolved
}

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

// ─── Path safety (REMOTE mode — kept for backwards compat) ──────────────

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
    throw new PathError('Path is required')
  }
  if (path.isAbsolute(requested)) {
    throw new PathError('Absolute paths are not allowed')
  }
  // Reject any ".." segment literally — even before normalization, so users
  // can't sneak a `..` past us via encoded characters etc.
  const segments = requested.split('/')
  if (segments.some((s) => s === '..')) {
    throw new PathError('Parent-directory (..) segments are not allowed')
  }

  // Resolve to an absolute path on the VPS and assert it stays inside.
  const base = deployPath.replace(/\/$/, '')
  const resolved = path.posix.normalize(`${base}/${requested}`)
  if (resolved !== base && !resolved.startsWith(base + '/')) {
    throw new PathError('Resolved path escapes the project directory')
  }
  return resolved
}

// ─── Path resolution helper ──────────────────────────────────────────────

interface ResolvedPath {
  /** Absolute path on the host filesystem. */
  abs: string
  /** The base directory the path was resolved against. */
  base: string
  /** True when running in LOCAL mode (LocalClient on the panel host). */
  localMode: boolean
  /** True when the project's server is in DEMO mode (synthetic). */
  isDemo: boolean
}

/**
 * Resolve a relative path against the project's base directory, branching on
 * the server's execution mode:
 *
 *   - LOCAL  → PROJECT_ROOT(projectId) with pathTraversalSafe (root created
 *              lazily via ensureDir).
 *   - REMOTE → project.deployPath with safePath (requires deployPath).
 *   - DEMO   → project.deployPath with safePath (synthetic; deployPath can
 *              be empty — the demo branch doesn't actually use the result).
 */
async function resolveProjectPath(
  project: {
    id: string
    deployPath?: string | null
    server: { sshHost?: string | null } | null
  },
  relative: string
): Promise<ResolvedPath> {
  const localMode = isLocalHost(project.server?.sshHost)
  if (localMode) {
    // Prefer the project's real deployed directory (e.g. the WordPress site at
    // deployPath, which is bind-mounted into the container) so the File Manager
    // operates on the ACTUAL website files — that's what "manage / export /
    // import website files" means. Fall back to the panel-managed per-project
    // storage root only for projects that haven't been deployed yet.
    const deployed = (project.deployPath || '').trim().replace(/\/+$/, '')
    const base = deployed || PROJECT_ROOT(project.id)
    await ensureDir(base)
    return {
      abs: pathTraversalSafe(base, relative || '.'),
      base,
      localMode: true,
      isDemo: false,
    }
  }
  // No server configured → demo mode (synthetic listing).
  const isDemo = project.server ? isServerInDemoMode(project.server) : true
  // Reject a bad path first, whatever state the site is in.
  safePath('/__validate__', relative || '.')
  if (!project.deployPath) {
    throw new PathError('This website has not been deployed yet — its files appear after the first deployment.')
  }
  return {
    abs: safePath(project.deployPath, relative || '.'),
    base: project.deployPath,
    localMode: false,
    isDemo,
  }
}

// ─── Symlink confinement ─────────────────────────────────────────────────
//
// The checks above are textual. The panel runs as root, so a symlink inside
// the site (`leak -> /opt/apsamo/.env`, or a directory pointing at `/etc`)
// would otherwise let a download read, or an upload write, anywhere on the
// host. Every operation below therefore re-checks the real location: in
// process with fs.realpath/lstat when the files live on the panel host, and
// with a bash guard (realpath -m) that runs in the same shell as the
// operation, for both local and SSH servers.

type AnyClient = Parameters<typeof exec>[0]

async function checkLocalConfinement(
  r: ResolvedPath,
  target: string,
  mode: ConfineMode
): Promise<void> {
  if (!r.localMode) return
  try {
    await assertConfinedLocal(r.base, target, mode)
  } catch (err) {
    if (err instanceof PathConfinementError) throw new PathError(err.message)
    throw err
  }
}

/**
 * Run `command` on the host only if every guarded path still resolves inside
 * the site. Guard failures become a PathError (400), not a 500.
 */
async function guardedExec(
  client: AnyClient,
  base: string,
  guards: Array<[string, ConfineMode]>,
  command: string,
  timeoutMs: number
) {
  const prelude = guards.map(([t, m]) => confinementGuardScript(base, t, m)).join('\n')
  const r = await exec(client, `${prelude}\n${command}`, { timeoutMs })
  const refused = guardFailureMessage(r.exitCode)
  if (refused) throw new PathError(refused)
  return r
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
 *
 * @param dirAbs  absolute path of the directory being listed (for absolutePath)
 * @param rootAbs absolute path of the project root — `path` is made relative to
 *                THIS so nested entries carry their full path (e.g.
 *                `wp-content/themes`), which is what navigation/download need.
 */
function parseLsLine(line: string, dirAbs: string, rootAbs: string): FileEntry | null {
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
  const abs = path.posix.normalize(`${dirAbs}/${name}`)
  const root = rootAbs.replace(/\/+$/, '')
  // Path relative to the PROJECT ROOT (not the current dir), so nested entries
  // carry their full path and navigation/download resolve correctly.
  const rel = abs.startsWith(root + '/') ? abs.slice(root.length + 1) : name

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

  const rp = await resolveProjectPath(project, subdir || '.')
  const { abs: resolved, base, isDemo } = rp

  // Demo mode: synthetic listing.
  if (isDemo) {
    return demoListing(resolved, base)
  }

  await checkLocalConfinement(rp, resolved, 'list')
  const creds: SshCredentials = await getServerCredentials(project.serverId!)
  return await withConnection(creds, async (client) => {
    const r = await guardedExec(
      client,
      base,
      [[resolved, 'list']],
      `ls -la --time-style=full-iso ${shellQuote(resolved)} 2>&1`,
      15000
    )
    if (r.exitCode !== 0) {
      throw new Error(`ls failed: ${(r.stderr || r.stdout).trim()}`)
    }
    const entries: FileEntry[] = []
    for (const line of r.stdout.split('\n')) {
      const e = parseLsLine(line, resolved, base)
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

  const rp = await resolveProjectPath(project, pathArg)
  const { abs, isDemo } = rp

  if (isDemo) {
    return { ok: true, message: `[demo] Uploaded ${path.basename(abs)} (${content.length} bytes)` }
  }

  await checkLocalConfinement(rp, abs, 'write')
  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    // Ensure parent dir exists (only once the target is proven to resolve
    // inside the site), then upload.
    const parent = path.posix.dirname(abs)
    await guardedExec(client, rp.base, [[abs, 'write']], `mkdir -p ${shellQuote(parent)}`, 10000)
    await checkLocalConfinement(rp, abs, 'write')
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

  const rp = await resolveProjectPath(project, pathArg)
  const { abs, isDemo } = rp
  const filename = path.posix.basename(abs)

  if (isDemo) {
    // Synthetic 1KB text body so the browser triggers a download.
    const body = Buffer.from(
      `# ${filename}\n\nThis is a demo-mode placeholder file.\nProject: ${project.slug}\n`
    )
    return { content: body, filename, size: body.length }
  }

  await checkLocalConfinement(rp, abs, 'read')
  const creds = await getServerCredentials(project.serverId!)
  const content = await withConnection(creds, async (client) => {
    await guardedExec(client, rp.base, [[abs, 'read']], 'true', 10000)
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

  const rp = await resolveProjectPath(project, pathArg)
  const { abs, isDemo } = rp

  if (abs.replace(/\/+$/, '') === rp.base.replace(/\/+$/, '')) {
    throw new PathError('The website root folder cannot be deleted.')
  }

  if (isDemo) {
    return { ok: true, message: `[demo] Deleted ${path.posix.basename(abs)}` }
  }

  // 'remove' lets a symlink itself be deleted (rm never follows the final
  // component) but requires its parent to resolve inside the site.
  await checkLocalConfinement(rp, abs, 'remove')
  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    await guardedExec(client, rp.base, [[abs, 'remove']], `rm -rf -- ${shellQuote(abs)}`, 30000)
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

  const rp = await resolveProjectPath(project, pathArg)
  const { abs, isDemo } = rp

  if (isDemo) {
    return { ok: true, message: `[demo] Created directory ${path.posix.basename(abs)}` }
  }

  await checkLocalConfinement(rp, abs, 'write')
  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    await guardedExec(client, rp.base, [[abs, 'write']], `mkdir -p ${shellQuote(abs)}`, 10000)
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

  const resolvedOld = await resolveProjectPath(project, oldPath)
  const resolvedNew = await resolveProjectPath(project, newPath)

  if (resolvedOld.isDemo || resolvedNew.isDemo) {
    return { ok: true, message: `[demo] Renamed ${oldPath} → ${newPath}` }
  }

  await checkLocalConfinement(resolvedOld, resolvedOld.abs, 'read')
  await checkLocalConfinement(resolvedNew, resolvedNew.abs, 'write')
  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    const parent = path.posix.dirname(resolvedNew.abs)
    await guardedExec(
      client,
      resolvedOld.base,
      [
        [resolvedOld.abs, 'read'],
        [resolvedNew.abs, 'write'],
      ],
      `mkdir -p ${shellQuote(parent)} && mv -- ${shellQuote(resolvedOld.abs)} ${shellQuote(resolvedNew.abs)}`,
      30000
    )
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

  const rp = await resolveProjectPath(project, pathArg)
  const { abs, isDemo } = rp

  if (isDemo) {
    const demo = `# ${path.posix.basename(abs)}\n\nThis is a demo-mode placeholder.\n`
    return { content: demo, size: demo.length, truncated: false }
  }

  await checkLocalConfinement(rp, abs, 'read')
  const creds = await getServerCredentials(project.serverId!)
  return await withConnection(creds, async (client) => {
    // Use head -c so we never pull a multi-GB file into memory.
    const r = await guardedExec(
      client,
      rp.base,
      [[abs, 'read']],
      `wc -c < ${shellQuote(abs)}; echo "---"; head -c ${Math.trunc(maxBytes) + 1} ${shellQuote(abs)} 2>/dev/null`,
      30000
    )
    const parts = r.stdout.split('---')
    const sizeStr = (parts[0] || '').trim()
    const size = parseInt(sizeStr, 10) || 0
    const raw = String(parts[1] || '')
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

  const rp = await resolveProjectPath(project, pathArg)
  const { abs, isDemo } = rp

  if (isDemo) {
    return { ok: true, message: `[demo] Saved ${path.posix.basename(abs)} (${content.length} bytes)` }
  }

  await checkLocalConfinement(rp, abs, 'write')
  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    const parent = path.posix.dirname(abs)
    await guardedExec(client, rp.base, [[abs, 'write']], `mkdir -p ${shellQuote(parent)}`, 10000)
    await checkLocalConfinement(rp, abs, 'write')
    await putFile(client, abs, content, { mode: 0o644 })
  })
  return { ok: true, message: 'Saved' }
}

// ─── Export (archive a folder for download) ──────────────────────────────

/**
 * Bundle a directory (the whole project or a subfolder) into a single archive
 * and return its bytes so the caller can stream a download. Produces a `.zip`
 * when the `zip` binary is available (friendliest for end users on any OS) and
 * transparently falls back to `.tar.gz` when it isn't — the returned
 * `filename` always carries the matching extension. `.git` metadata is
 * excluded so exports stay lean and portable.
 */
export async function exportArchive(
  projectId: string,
  subdir: string
): Promise<{ content: Buffer; filename: string; size: number }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  const rp = await resolveProjectPath(project, subdir || '.')
  const { abs, isDemo } = rp
  const label = (
    path.posix.basename(abs.replace(/\/+$/, '')) || project.slug || 'files'
  ).replace(/[^A-Za-z0-9._-]/g, '_')
  const stamp = new Date().toISOString().slice(0, 10)

  if (isDemo) {
    const body = Buffer.from(
      `[demo] Archive of ${project.slug || project.id}/${subdir || ''}\n` +
        `Generated ${new Date().toISOString()}\n`
    )
    return { content: body, filename: `${label}-${stamp}.zip`, size: body.length }
  }

  await checkLocalConfinement(rp, abs, 'list')
  const creds = await getServerCredentials(project.serverId!)
  return await withConnection(creds, async (client) => {
    const rand = Math.random().toString(36).slice(2, 8)

    // Prefer zip — most end users can open a .zip natively.
    // -y stores symlinks AS symlinks. Without it zip follows them, so a link
    // to /opt/apsamo/.env inside the site would export the panel's secrets.
    // (tar below never follows symlinks unless given -h.)
    const zipTmp = `/tmp/apsamo-export-${Date.now()}-${rand}.zip`
    const zipCmd =
      `cd ${shellQuote(abs)} && ` +
      `zip -r -q -y ${shellQuote(zipTmp)} . -x '.git/*' '*/.git/*' && echo __APSAMO_OK__`
    const zr = await guardedExec(client, rp.base, [[abs, 'list']], zipCmd, 300000)
    if (zr.exitCode === 0 && /__APSAMO_OK__/.test(zr.stdout)) {
      const content = await getFile(client, zipTmp)
      await exec(client, `rm -f ${shellQuote(zipTmp)}`, { timeoutMs: 10000 })
      return { content, filename: `${label}-${stamp}.zip`, size: content.length }
    }

    // Fallback: tar.gz (tar is always present on Linux).
    await exec(client, `rm -f ${shellQuote(zipTmp)}`, { timeoutMs: 10000 })
    const tarTmp = `/tmp/apsamo-export-${Date.now()}-${rand}.tar.gz`
    const tarCmd =
      `tar -czf ${shellQuote(tarTmp)} --exclude='.git' -C ${shellQuote(abs)} . && echo __APSAMO_OK__`
    const tr = await guardedExec(client, rp.base, [[abs, 'list']], tarCmd, 300000)
    if (tr.exitCode !== 0 || !/__APSAMO_OK__/.test(tr.stdout)) {
      await exec(client, `rm -f ${shellQuote(tarTmp)}`, { timeoutMs: 10000 })
      const detail = (tr.stderr || tr.stdout || zr.stderr || zr.stdout || '').trim().slice(0, 300)
      throw new Error(`Archive failed: ${detail || 'unknown error'}`)
    }
    const content = await getFile(client, tarTmp)
    await exec(client, `rm -f ${shellQuote(tarTmp)}`, { timeoutMs: 10000 })
    return { content, filename: `${label}-${stamp}.tar.gz`, size: content.length }
  })
}

// ─── Import (upload + extract an archive) ────────────────────────────────

/**
 * Extract an uploaded archive into a directory (the project root or a
 * subfolder). Supports `.zip` (via `unzip`) and `.tar.gz` / `.tgz` / `.tar`
 * (via `tar`), auto-detected from `originalName`. Existing files are
 * overwritten (`unzip -o`). Extraction is confined to the resolved target by
 * `resolveProjectPath` plus the extractor's own path-sanitisation.
 */
export async function importArchive(
  projectId: string,
  subdir: string,
  content: Buffer,
  originalName: string
): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  const rp = await resolveProjectPath(project, subdir || '.')
  const { abs, isDemo } = rp
  const lower = (originalName || '').toLowerCase()
  const isTarGz = /\.(tar\.gz|tgz)$/.test(lower)
  const isTar = /\.tar$/.test(lower)
  const useTar = isTarGz || isTar

  if (isDemo) {
    return {
      ok: true,
      message: `[demo] Imported ${originalName || 'archive'} into ${subdir || '/'}`,
    }
  }

  await checkLocalConfinement(rp, abs, 'write')
  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    const rand = Math.random().toString(36).slice(2, 8)
    const ext = isTarGz ? 'tar.gz' : isTar ? 'tar' : 'zip'
    const tmp = `/tmp/apsamo-import-${Date.now()}-${rand}.${ext}`
    await putFile(client, tmp, content, { mode: 0o644 })

    // Refuse archives carrying symbolic/hard links or out-of-tree paths
    // before anything is written into the project (see lib/vps/archive-safety).
    const listing = await exec(
      client,
      archiveListingCommand(isTarGz ? 'tar.gz' : isTar ? 'tar' : 'zip', tmp),
      { timeoutMs: 120000 }
    ).catch(() => null)
    const problems = listing && listing.exitCode === 0 ? findUnsafeArchiveEntries(listing.stdout) : null
    if (problems === null || problems.length > 0) {
      await exec(client, `rm -f ${shellQuote(tmp)}`, { timeoutMs: 10000 }).catch(() => {})
      throw new Error(unsafeArchiveMessage(problems))
    }

    const extractCmd = useTar
      ? `tar -x${isTarGz ? 'z' : ''}f ${shellQuote(tmp)} -C ${shellQuote(abs)} && echo __APSAMO_OK__`
      : `unzip -o -q ${shellQuote(tmp)} -d ${shellQuote(abs)} && echo __APSAMO_OK__`
    let r
    try {
      r = await guardedExec(
        client,
        rp.base,
        [[abs, 'write']],
        `mkdir -p ${shellQuote(abs)} && ${extractCmd}`,
        300000
      )
    } finally {
      await exec(client, `rm -f ${shellQuote(tmp)}`, { timeoutMs: 10000 })
    }
    if (r.exitCode !== 0 || !/__APSAMO_OK__/.test(r.stdout)) {
      const detail = (r.stderr || r.stdout || '').trim().slice(0, 300)
      throw new Error(
        `Extract failed: ${detail || 'unknown error'}` +
          (!useTar ? ' (is `unzip` installed on the server?)' : '')
      )
    }
  })
  return { ok: true, message: `Imported ${originalName || 'archive'}` }
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
