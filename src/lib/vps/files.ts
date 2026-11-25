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
import {
  ARCHIVE_TIME_LIMIT_SECONDS,
  EXIT_NOT_A_FOLDER,
  EXIT_TARGET_EXISTS,
  EXIT_TIMED_OUT,
  EXIT_TOO_LARGE,
  MAX_DEST_SYMLINKS,
  MAX_EXTRACT_ARCHIVE_BYTES,
  MAX_EXTRACT_ENTRIES,
  MAX_EXTRACT_UNCOMPRESSED_BYTES,
  MAX_PREVIEW_BYTES,
  archiveContentTotals,
  archiveKindOf,
  archiveMemberNames,
  chmodCommand,
  copyMoveCommand,
  extractCommand,
  extractSucceeded,
  findManagedCollisions,
  findSymlinkCollisions,
  isDocumentRoot,
  isManagedRelPath,
  isSameOrInside,
  listDestSymlinksCommand,
  normalizeRel,
  parseOctalMode,
  previewContentType,
  stageArchiveCommand,
  validateSelection,
  zipCommand,
  zipFileName,
} from './file-ops'
import {
  DemoFsError,
  demoChmod,
  demoCompress,
  demoCopy,
  demoExtract,
  demoList,
  demoMkdir,
  demoRead,
  demoRemove,
  demoRename,
  demoStat,
  demoWrite,
} from './demo-files'

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

/**
 * A file operation that ran but failed on the server (zip missing, disk
 * full, timed out). The message is written for the customer and never
 * carries host paths outside the site, so routes may show it (422).
 */
export class FileOperationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileOperationError'
  }
}

/** Run a demo-tree operation; its refusals are the caller's mistake (400). */
function demoOp<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof DemoFsError) throw new PathError(err.message)
    throw err
  }
}

/** The path of a resolved location relative to the site's base ("" = base). */
function relOf(r: { abs: string; base: string }): string {
  return normalizeRel(path.posix.relative(r.base.replace(/\/+$/, ''), r.abs))
}

/** Last lines of a command's output for an error message, minus host paths. */
function failureDetail(r: { stdout: string; stderr: string }, base: string): string {
  const text = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ')
  return text.split(base.replace(/\/+$/, '')).join('').slice(0, 240)
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

  // Demo mode: the in-memory website tree (demo-files.ts).
  if (isDemo) {
    const root = base.replace(/\/+$/, '')
    return demoOp(() => demoList(projectId, relOf(rp))).map((e) => ({
      name: e.name,
      path: e.path,
      absolutePath: `${root}/${e.path}`,
      type: e.type,
      size: e.size,
      modifiedAt: e.modifiedAt,
      permissions: e.permissions,
    }))
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
    demoOp(() => demoWrite(projectId, relOf(rp), content))
    return { ok: true, message: `Uploaded ${path.posix.basename(abs)}` }
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
    // Uploads over the demo tree's size cap keep only their size.
    const stored = demoOp(() => demoRead(projectId, relOf(rp)))
    const body =
      stored ?? Buffer.from(`# ${filename}\n\nThis is a demo-mode placeholder file.\nProject: ${project.slug}\n`)
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
    demoOp(() => demoRemove(projectId, relOf(rp)))
    return { ok: true, message: `Deleted ${path.posix.basename(abs)}` }
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
    demoOp(() => demoMkdir(projectId, relOf(rp)))
    return { ok: true, message: 'Directory created' }
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
    demoOp(() => demoRename(projectId, relOf(resolvedOld), relOf(resolvedNew)))
    return { ok: true, message: 'Renamed' }
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
    const stat = demoOp(() => demoStat(projectId, relOf(rp)))
    if (!stat) throw new PathError('That file does not exist.')
    const stored = demoOp(() => demoRead(projectId, relOf(rp)))
    const text = stored ? stored.toString('utf8') : `# ${path.posix.basename(abs)}\n\nThis is a demo-mode placeholder.\n`
    const truncated = text.length > maxBytes
    return { content: truncated ? text.slice(0, maxBytes) : text, size: stat.size, truncated }
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
    demoOp(() => demoWrite(projectId, relOf(rp), content))
    return { ok: true, message: 'Saved' }
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

// ─── Server-side operations: chmod, compress, extract, copy/move, preview ──
//
// Command building and validation live in file-ops.ts (unit-tested); these
// wrappers resolve paths, apply the same confinement checks as above, and
// run the command on the site's host (or the demo tree).

async function loadProject(projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  return project
}

type ChmodOptions =
  | { mode: string; recursive?: false }
  | { recursive: true; dirMode: string; fileMode: string }

/**
 * Change the permissions of one file or folder. Recursive changes (folders
 * only) set one mode on every folder and another on every file, never
 * following links. setuid/setgid are refused; platform files and the hosting
 * root keep the modes the platform gives them.
 */
export async function chmodPath(
  projectId: string,
  pathArg: string,
  input: { mode?: unknown; recursive?: unknown; dirMode?: unknown; fileMode?: unknown }
): Promise<{ ok: boolean; message: string; changed: number }> {
  let opts: ChmodOptions
  if (input.recursive === true) {
    const dir = parseOctalMode(input.dirMode ?? input.mode)
    if (!dir.ok) throw new PathError(dir.error)
    const file = parseOctalMode(input.fileMode)
    if (!file.ok) throw new PathError(file.error)
    opts = { recursive: true, dirMode: dir.mode, fileMode: file.mode }
  } else {
    const m = parseOctalMode(input.mode)
    if (!m.ok) throw new PathError(m.error)
    opts = { mode: m.mode }
  }

  const project = await loadProject(projectId)
  const rp = await resolveProjectPath(project, pathArg)
  const rel = relOf(rp)
  if (!rel) throw new PathError('The permissions of the hosting root are managed by the platform.')
  if (isManagedRelPath(rel)) {
    throw new PathError('This file is managed by Apsamo; the platform sets its permissions.')
  }
  const label = opts.recursive ? `${opts.dirMode} on folders and ${opts.fileMode} on files` : opts.mode

  if (rp.isDemo) {
    const changed = demoOp(() => demoChmod(projectId, rel, opts))
    return { ok: true, message: `Permissions set to ${label}`, changed }
  }

  // chmod follows a link named on the command line, so a link is refused
  // outright ('read' mode); recursive walks never follow links (find -P).
  await checkLocalConfinement(rp, rp.abs, 'read')
  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    const r = await guardedExec(client, rp.base, [[rp.abs, 'read']], chmodCommand(rp.abs, opts), 120000)
    if (r.exitCode === EXIT_NOT_A_FOLDER) throw new PathError('Only folders can be changed recursively.')
    if (r.exitCode !== 0) {
      throw new FileOperationError(`Permissions were not changed: ${failureDetail(r, rp.base) || 'unknown error'}`)
    }
  })
  return { ok: true, message: `Permissions set to ${label}`, changed: 1 }
}

/**
 * Compress items of one folder into `<folder>/<name>.zip` on the server.
 * Links are stored as links; the input size and run time are bounded.
 */
export async function compressPaths(
  projectId: string,
  dirArg: string,
  items: unknown,
  nameArg: unknown
): Promise<{ ok: boolean; message: string; path: string }> {
  const selection = validateSelection(items)
  if (!selection.ok) throw new PathError(selection.error)
  const zip = zipFileName(nameArg)
  if (!zip.ok) throw new PathError(zip.error)

  const dirRel = normalizeRel(dirArg)
  const names: string[] = []
  for (const p of selection.paths) {
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (parent !== dirRel) throw new PathError('Everything you compress must be in the same folder.')
    names.push(p.slice(parent ? parent.length + 1 : 0))
  }
  const outRel = dirRel ? `${dirRel}/${zip.name}` : zip.name

  const project = await loadProject(projectId)
  const dir = await resolveProjectPath(project, dirRel || '.')
  const out = await resolveProjectPath(project, outRel)
  const resolvedItems = await Promise.all(selection.paths.map((p) => resolveProjectPath(project, p)))

  if (dir.isDemo) {
    demoOp(() => demoCompress(projectId, dirRel, names, zip.name))
    return { ok: true, message: `Created ${zip.name}`, path: outRel }
  }

  await checkLocalConfinement(dir, dir.abs, 'list')
  await checkLocalConfinement(out, out.abs, 'write')
  // An item may itself be a link (zip -y stores it as one); its folder must
  // still resolve inside the site.
  for (const it of resolvedItems) await checkLocalConfinement(it, it.abs, 'remove')

  const creds = await getServerCredentials(project.serverId!)
  await withConnection(creds, async (client) => {
    const guards: Array<[string, ConfineMode]> = [
      [dir.abs, 'list'],
      [out.abs, 'write'],
      ...resolvedItems.map((it): [string, ConfineMode] => [it.abs, 'remove']),
    ]
    const r = await guardedExec(
      client,
      dir.base,
      guards,
      zipCommand(dir.abs, names, out.abs),
      (ARCHIVE_TIME_LIMIT_SECONDS + 60) * 1000
    )
    if (r.exitCode === EXIT_TARGET_EXISTS) throw new PathError(`${zip.name} already exists in this folder.`)
    if (r.exitCode === EXIT_TOO_LARGE) {
      throw new PathError('The selection is larger than 2 GB. Compress smaller parts, or use SFTP.')
    }
    if (r.exitCode === EXIT_TIMED_OUT) throw new FileOperationError('Compressing took too long and was stopped.')
    if (r.exitCode !== 0 || !/__APSAMO_ZIP_DONE__/.test(r.stdout)) {
      const detail = failureDetail(r, dir.base)
      throw new FileOperationError(
        /zip: (command )?not found/.test(detail)
          ? 'The zip tool is not installed on this server.'
          : `The archive could not be created: ${detail || 'unknown error'}`
      )
    }
  })
  return { ok: true, message: `Created ${zip.name}`, path: outRel }
}

/**
 * Extract an archive that is already in the site into `destArg` (its own
 * folder when omitted). The archive is copied to a private temp file first,
 * so what is checked is exactly what is extracted. Refused when it holds
 * links or out-of-tree paths (archive-safety), is over the size / entry
 * limits, would write through a link already in the destination, or would
 * replace a platform-managed file.
 */
export async function extractArchive(
  projectId: string,
  archiveArg: string,
  destArg: string | undefined,
  opts: { overwrite?: boolean } = {}
): Promise<{ ok: boolean; message: string; entries: number; destination: string }> {
  const project = await loadProject(projectId)
  const arch = await resolveProjectPath(project, archiveArg)
  const archRel = relOf(arch)
  const kind = archiveKindOf(path.posix.basename(archRel))
  if (!archRel || !kind) throw new PathError('Only .zip, .tar, .tar.gz and .tgz archives can be extracted.')
  const destRel = destArg === undefined ? normalizeRel(path.posix.dirname(archRel)) : normalizeRel(destArg)
  const dest = await resolveProjectPath(project, destRel || '.')
  const overwrite = opts.overwrite === true
  const where = destRel ? `${destRel}/` : 'the hosting root'

  if (arch.isDemo) {
    const written = demoOp(() => demoExtract(projectId, archRel, destRel, overwrite))
    return {
      ok: true,
      message: `Extracted ${written} file${written === 1 ? '' : 's'} into ${where}`,
      entries: written,
      destination: destRel,
    }
  }

  await checkLocalConfinement(arch, arch.abs, 'read')
  await checkLocalConfinement(dest, dest.abs, 'write')
  const creds = await getServerCredentials(project.serverId!)
  const entries = await withConnection(creds, async (client) => {
    const size = await guardedExec(client, arch.base, [[arch.abs, 'read']], `stat -c %s -- ${shellQuote(arch.abs)}`, 15000)
    const bytes = Number(size.stdout.trim())
    if (size.exitCode !== 0 || !Number.isFinite(bytes)) throw new PathError('That archive does not exist.')
    if (bytes > MAX_EXTRACT_ARCHIVE_BYTES) {
      throw new PathError('This archive is larger than 2 GB. Extract it over SSH or SFTP instead.')
    }

    const rand = Math.random().toString(36).slice(2, 8)
    const tmp = `/tmp/apsamo-extract-${Date.now()}-${rand}.${kind}`
    try {
      const staged = await guardedExec(client, arch.base, [[arch.abs, 'read']], stageArchiveCommand(arch.abs, tmp), 300000)
      if (staged.exitCode !== 0) {
        throw new FileOperationError(`The archive could not be read: ${failureDetail(staged, arch.base) || 'unknown error'}`)
      }

      const listing = await exec(client, archiveListingCommand(kind, tmp), { timeoutMs: 120000 }).catch(() => null)
      const out = listing && listing.exitCode === 0 ? listing.stdout : ''
      const problems = out ? findUnsafeArchiveEntries(out) : null
      if (problems === null || problems.length > 0) throw new PathError(unsafeArchiveMessage(problems))

      const totals = archiveContentTotals(kind, out)
      if (!totals) throw new PathError(unsafeArchiveMessage(null))
      if (totals.entries > MAX_EXTRACT_ENTRIES) {
        throw new PathError(`This archive holds more than ${MAX_EXTRACT_ENTRIES.toLocaleString('en-US')} entries, which is over the limit.`)
      }
      if (totals.bytes > MAX_EXTRACT_UNCOMPRESSED_BYTES) {
        throw new PathError('This archive unpacks to more than 4 GB, which is over the limit.')
      }

      const members = archiveMemberNames(out)
      const managed = findManagedCollisions(members, destRel)
      if (managed.length) {
        throw new PathError(
          `The archive would replace files managed by Apsamo (${managed.slice(0, 3).join(', ')}). Extract it into a folder instead.`
        )
      }

      const links = await guardedExec(client, dest.base, [[dest.abs, 'write']], listDestSymlinksCommand(dest.abs), 60000)
      const linkList = links.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
      if (linkList.length > MAX_DEST_SYMLINKS) {
        throw new PathError('The destination folder holds too many symbolic links to check safely. Extract into an empty folder.')
      }
      const through = findSymlinkCollisions(members, linkList)
      if (through.length) {
        throw new PathError(
          `The archive would write through symbolic links in the destination (${through.slice(0, 3).join(', ')}). Extract into an empty folder.`
        )
      }

      const r = await guardedExec(
        client,
        dest.base,
        [[dest.abs, 'write']],
        extractCommand(kind, tmp, dest.abs, { overwrite }),
        (ARCHIVE_TIME_LIMIT_SECONDS + 60) * 1000
      )
      if (r.exitCode === EXIT_TIMED_OUT) throw new FileOperationError('Extracting took too long and was stopped; some files may have been written.')
      if (!extractSucceeded(kind, r.exitCode)) {
        const detail = failureDetail(r, dest.base)
        throw new FileOperationError(
          /unzip: (command )?not found/.test(detail)
            ? 'The unzip tool is not installed on this server.'
            : `The archive could not be extracted: ${detail || 'unknown error'}`
        )
      }
      return totals.entries
    } finally {
      await exec(client, `rm -f -- ${shellQuote(tmp)}`, { timeoutMs: 10000 }).catch(() => {})
    }
  })
  return {
    ok: true,
    message: `Extracted ${entries} entr${entries === 1 ? 'y' : 'ies'} into ${where}`,
    entries,
    destination: destRel,
  }
}

/**
 * Copy or move items into another folder of the site. Each item keeps its
 * name; nothing is overwritten. Platform files and the website folder cannot
 * be moved. Returns per-item failures instead of stopping at the first.
 */
export async function copyOrMovePaths(
  projectId: string,
  op: 'copy' | 'move',
  items: unknown,
  destArg: unknown
): Promise<{ ok: boolean; message: string; done: number; failed: Array<{ path: string; error: string }> }> {
  const selection = validateSelection(items)
  if (!selection.ok) throw new PathError(selection.error)
  if (typeof destArg !== 'string') throw new PathError('Choose a destination folder.')
  const destRel = normalizeRel(destArg)

  for (const p of selection.paths) {
    if (op === 'move' && isManagedRelPath(p)) throw new PathError(`${p} is managed by Apsamo and must stay where it is.`)
    if (op === 'move' && isDocumentRoot(p)) throw new PathError(`${p}/ holds your website and must stay where it is.`)
    if (isSameOrInside(p, destRel)) throw new PathError(`${p} cannot be ${op === 'copy' ? 'copied' : 'moved'} into itself.`)
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    if (parent === destRel) throw new PathError(`${p} is already in that folder.`)
  }

  const project = await loadProject(projectId)
  const dest = await resolveProjectPath(project, destRel || '.')
  const pairs = await Promise.all(
    selection.paths.map(async (p) => {
      const name = p.slice(p.lastIndexOf('/') + 1)
      return {
        rel: p,
        src: await resolveProjectPath(project, p),
        target: await resolveProjectPath(project, destRel ? `${destRel}/${name}` : name),
      }
    })
  )
  const verb = op === 'copy' ? 'Copied' : 'Moved'
  const summary = (done: number) => `${verb} ${done} item${done === 1 ? '' : 's'} to ${destRel ? `${destRel}/` : 'the hosting root'}`

  if (dest.isDemo) {
    const failed: Array<{ path: string; error: string }> = []
    if (demoStat(projectId, destRel)?.type !== 'dir') throw new PathError('The destination folder does not exist.')
    for (const { rel, target } of pairs) {
      try {
        demoOp(() => (op === 'copy' ? demoCopy(projectId, rel, relOf(target)) : demoRename(projectId, rel, relOf(target))))
      } catch (err) {
        failed.push({ path: rel, error: err instanceof Error ? err.message : 'failed' })
      }
    }
    const done = pairs.length - failed.length
    return { ok: done > 0, message: summary(done), done, failed }
  }

  await checkLocalConfinement(dest, dest.abs, 'list')
  const creds = await getServerCredentials(project.serverId!)
  const failed: Array<{ path: string; error: string }> = []
  await withConnection(creds, async (client) => {
    const isDir = await guardedExec(
      client,
      dest.base,
      [[dest.abs, 'list']],
      `if [ -d ${shellQuote(dest.abs)} ]; then echo yes; else exit ${EXIT_NOT_A_FOLDER}; fi`,
      10000
    )
    if (isDir.exitCode !== 0) throw new PathError('The destination folder does not exist.')

    for (const { rel, src, target } of pairs) {
      try {
        // The item itself may be a link (copied / moved as a link); its
        // folder and the new location must resolve inside the site.
        await checkLocalConfinement(src, src.abs, 'remove')
        await checkLocalConfinement(target, target.abs, 'write')
        const r = await guardedExec(
          client,
          src.base,
          [
            [src.abs, 'remove'],
            [target.abs, 'write'],
          ],
          copyMoveCommand(op, src.abs, target.abs),
          (ARCHIVE_TIME_LIMIT_SECONDS + 60) * 1000
        )
        if (r.exitCode === EXIT_TARGET_EXISTS) throw new PathError('something with that name is already there')
        if (r.exitCode === EXIT_TIMED_OUT) throw new FileOperationError('took too long and was stopped')
        if (r.exitCode !== 0) throw new FileOperationError(failureDetail(r, src.base) || 'failed')
      } catch (err) {
        if (!(err instanceof PathError || err instanceof FileOperationError)) throw err
        failed.push({ path: rel, error: err.message })
      }
    }
  })
  const done = pairs.length - failed.length
  return { ok: done > 0, message: summary(done), done, failed }
}

/**
 * Bytes of an image or PDF for an inline preview, with its content type.
 * Size-limited; refuses links like a download does.
 */
export async function previewFile(
  projectId: string,
  pathArg: string
): Promise<{ content: Buffer; filename: string; contentType: string }> {
  const project = await loadProject(projectId)
  const rp = await resolveProjectPath(project, pathArg)
  const filename = path.posix.basename(rp.abs)
  const contentType = previewContentType(filename)
  if (!contentType) throw new PathError('Only images and PDF files can be previewed.')

  if (rp.isDemo) {
    const stored = demoOp(() => demoRead(projectId, relOf(rp)))
    if (!stored) throw new PathError('This demo file has no stored contents to preview.')
    if (stored.length > MAX_PREVIEW_BYTES) throw new PathError('This file is too large to preview. Download it instead.')
    return { content: stored, filename, contentType }
  }

  await checkLocalConfinement(rp, rp.abs, 'read')
  const creds = await getServerCredentials(project.serverId!)
  const content = await withConnection(creds, async (client) => {
    const st = await guardedExec(
      client,
      rp.base,
      [[rp.abs, 'read']],
      `if [ -f ${shellQuote(rp.abs)} ]; then stat -c %s -- ${shellQuote(rp.abs)}; else exit ${EXIT_NOT_A_FOLDER}; fi`,
      10000
    )
    const size = Number(st.stdout.trim())
    if (st.exitCode !== 0 || !Number.isFinite(size)) throw new PathError('That file does not exist.')
    if (size > MAX_PREVIEW_BYTES) throw new PathError('This file is too large to preview. Download it instead.')
    return await getFile(client, rp.abs)
  })
  return { content, filename, contentType }
}
