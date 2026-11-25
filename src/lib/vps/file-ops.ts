/**
 * File manager operations: validation and shell command building
 * ==============================================================
 *
 * Pure helpers (no shell, no network, no database) behind the file manager's
 * server-side actions in files.ts: extract an archive that is already on the
 * server, compress a selection into a .zip, change permissions, copy / move.
 * Unit-tested in tests/unit/file-ops.test.ts.
 *
 * The panel runs these as root on a host shared with other tenants, so every
 * rule here errs on the side of refusing:
 *   - modes are plain octal; setuid / setgid are never set (a root-owned
 *     setuid binary uploaded by a customer is a root shell on the host);
 *   - recursive walks never follow symbolic links (`find` defaults to -P);
 *   - archives are size- and entry-limited, listed with archive-safety and
 *     refused when an entry would be written THROUGH an existing link in the
 *     destination folder;
 *   - files the platform writes (docker-compose.yml, Dockerfile …) cannot be
 *     moved, have their mode changed, or be overwritten by an extraction.
 */
import path from 'path'
import { shellQuoteArg } from './deploy-safety'
import { ARCHIVE_LIST_SEPARATOR, type ListableArchive } from './archive-safety'

// ─── Limits ────────────────────────────────────────────────────────────────

/** Largest archive (on disk) that may be extracted from the file manager. */
export const MAX_EXTRACT_ARCHIVE_BYTES = 2 * 1024 ** 3
/** Largest total uncompressed size an extraction may write. */
export const MAX_EXTRACT_UNCOMPRESSED_BYTES = 4 * 1024 ** 3
/** Most entries an extraction may write. */
export const MAX_EXTRACT_ENTRIES = 100_000
/** Largest total size of a selection compressed into a .zip. */
export const MAX_COMPRESS_INPUT_BYTES = 2 * 1024 ** 3
/** Wall-clock limit (seconds) for one extract / compress / copy on the server. */
export const ARCHIVE_TIME_LIMIT_SECONDS = 600
/** Largest file the preview endpoint streams to the browser. */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
/** Most items one compress / copy / move request may name. */
export const MAX_SELECTION = 500
/** Most symbolic links in a destination folder we are willing to check. */
export const MAX_DEST_SYMLINKS = 20_000

/** Exit codes the composed scripts use; mapped to messages by the caller. */
export const EXIT_TARGET_EXISTS = 95
export const EXIT_TOO_LARGE = 94
export const EXIT_NOT_A_FOLDER = 93
export const EXIT_TIMED_OUT = 124 // what coreutils `timeout` returns

// ─── Platform-managed files ────────────────────────────────────────────────

/** The folder that holds the website itself (WordPress / imported sites). */
export const DOCUMENT_ROOT_DIR = 'site'

/**
 * Files at the deploy root the platform writes and rewrites. Same list as the
 * client (src/components/hosting/site/file-utils.ts), checked again here.
 */
export const MANAGED_ROOT_FILES = ['docker-compose.yml', 'dockerfile', '.dockerignore', 'wp-config-docker.php']

/** Is this path (relative to the deploy root) a platform-managed file? */
export function isManagedRelPath(rel: string): boolean {
  const clean = normalizeRel(rel)
  if (!clean || clean.includes('/')) return false
  return MANAGED_ROOT_FILES.includes(clean.toLowerCase())
}

/** The document root folder itself (`site`), which must stay where it is. */
export function isDocumentRoot(rel: string): boolean {
  return normalizeRel(rel) === DOCUMENT_ROOT_DIR
}

// ─── Paths and names ───────────────────────────────────────────────────────

/** "./a//b/" → "a/b"; "" and "." → "". Does not validate. */
export function normalizeRel(rel: string): string {
  const parts = String(rel || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
  return parts.join('/')
}

/**
 * A single file or folder name chosen by the customer (archive name, copy
 * target). Returns an error message, or null when usable.
 */
export function validateEntryName(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'A name is required.'
  const name = raw.trim()
  if (!name) return 'A name is required.'
  if (name === '.' || name === '..') return 'That name is reserved.'
  if (/[\\/]/.test(name)) return 'A name cannot contain / or \\.'
  if (/[\x00-\x1f\x7f]/.test(name)) return 'A name cannot contain control characters.'
  if (name.length > 255) return 'That name is too long (255 characters at most).'
  return null
}

/**
 * The selection for compress / copy / move: a list of relative paths. They
 * must be distinct, non-empty, and not the root itself. Traversal is checked
 * again by pathTraversalSafe when each one is resolved.
 */
export function validateSelection(raw: unknown): { ok: true; paths: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Choose at least one file or folder.' }
  if (raw.length > MAX_SELECTION) return { ok: false, error: `Choose at most ${MAX_SELECTION} items at once.` }
  const seen = new Set<string>()
  const paths: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, error: 'Every item must be a path.' }
    const rel = normalizeRel(item)
    if (!rel) return { ok: false, error: 'The hosting root itself cannot be selected.' }
    if (rel.split('/').includes('..')) return { ok: false, error: 'Parent-directory (..) segments are not allowed' }
    if (!seen.has(rel)) {
      seen.add(rel)
      paths.push(rel)
    }
  }
  return { ok: true, paths }
}

/** Is `child` the same as, or inside, `parent` (both relative, normalized)? */
export function isSameOrInside(parent: string, child: string): boolean {
  const p = normalizeRel(parent)
  const c = normalizeRel(child)
  if (p === '') return true
  return c === p || c.startsWith(p + '/')
}

// ─── Permissions ───────────────────────────────────────────────────────────

export type ModeResult = { ok: true; mode: string } | { ok: false; error: string }

/**
 * Validate an octal mode ("644", "0755", "1777"). Setuid (4xxx) and setgid
 * (2xxx) are refused; the sticky bit (1xxx) is allowed. Returns the mode as
 * three or four digits, without a leading zero for plain modes.
 */
export function parseOctalMode(raw: unknown): ModeResult {
  if (typeof raw !== 'string' && typeof raw !== 'number') return { ok: false, error: 'Enter a mode such as 644 or 755.' }
  const s = String(raw).trim()
  if (!/^[0-7]{3,4}$/.test(s)) return { ok: false, error: 'Enter a mode of three octal digits, such as 644 or 755.' }
  if (s.length === 4) {
    const special = Number(s[0])
    if (special & 4) return { ok: false, error: 'The setuid bit cannot be set from the file manager.' }
    if (special & 2) return { ok: false, error: 'The setgid bit cannot be set from the file manager.' }
    return { ok: true, mode: special === 0 ? s.slice(1) : s }
  }
  return { ok: true, mode: s }
}

/**
 * Shell command changing permissions. Non-recursive: the one path. Recursive
 * (folders only): `dirMode` on every folder, `fileMode` on every file, found
 * with `find -P` (links are never followed, and their own mode is left
 * alone), staying on one filesystem.
 */
export function chmodCommand(
  abs: string,
  opts: { mode: string; recursive?: false } | { recursive: true; dirMode: string; fileMode: string }
): string {
  for (const m of opts.recursive ? [opts.dirMode, opts.fileMode] : [opts.mode]) {
    const parsed = parseOctalMode(m)
    if (!parsed.ok || parsed.mode !== m) throw new Error(`Invalid mode: ${m}`)
  }
  const a = shellQuoteArg(abs)
  if (!opts.recursive) return `chmod ${opts.mode} -- ${a}`
  return (
    `if [ ! -d ${a} ] || [ -L ${a} ]; then exit ${EXIT_NOT_A_FOLDER}; fi\n` +
    `find -P ${a} -xdev -type d -exec chmod ${opts.dirMode} -- {} + && ` +
    `find -P ${a} -xdev -type f -exec chmod ${opts.fileMode} -- {} +`
  )
}

// ─── Archives ──────────────────────────────────────────────────────────────

/** Archive type from a file name, or null when it is not one we extract. */
export function archiveKindOf(name: string): ListableArchive | null {
  const lower = name.toLowerCase()
  if (/\.(tar\.gz|tgz)$/.test(lower)) return 'tar.gz'
  if (/\.tar$/.test(lower)) return 'tar'
  if (/\.zip$/.test(lower)) return 'zip'
  return null
}

/**
 * Total uncompressed size and entry count from `archiveListingCommand`
 * output (zipinfo short format / `tar -tv`). Null when the output does not
 * look like a listing, so the caller refuses ("cannot verify").
 */
export function archiveContentTotals(
  kind: ListableArchive,
  output: string
): { bytes: number; entries: number } | null {
  const at = output.indexOf(ARCHIVE_LIST_SEPARATOR)
  if (at < 0) return null
  const verbose = output.slice(0, at).split(/\r?\n/)
  if (kind === 'zip') {
    // zipinfo ends with "N files, B bytes uncompressed, C bytes compressed: …"
    for (let i = verbose.length - 1; i >= 0; i--) {
      const m = verbose[i].match(/^\s*(\d+)\s+files?,\s+(\d+)\s+bytes? uncompressed/)
      if (m) return { entries: Number(m[1]), bytes: Number(m[2]) }
    }
    // An empty archive prints "Empty zipfile." and no summary.
    if (verbose.some((l) => /empty zipfile/i.test(l))) return { entries: 0, bytes: 0 }
    return null
  }
  let bytes = 0
  let entries = 0
  for (const line of verbose) {
    // -rw-r--r-- user/group    1234 2024-01-15 12:34 name
    const m = line.match(/^[-dlhcbps][rwxsStT-]{9}\s+\S+\s+(\d+)\s/)
    if (m) {
      entries++
      bytes += Number(m[1])
    }
  }
  return { bytes, entries }
}

/** The member names (second half of the listing), normalized, without empties. */
export function archiveMemberNames(output: string): string[] {
  const at = output.indexOf(ARCHIVE_LIST_SEPARATOR)
  if (at < 0) return []
  return output
    .slice(at + ARCHIVE_LIST_SEPARATOR.length)
    .split(/\r?\n/)
    .map((n) => normalizeRel(n.trim()))
    .filter(Boolean)
}

/**
 * Members that would be written through an existing symbolic link in the
 * destination: `link -> /etc` plus a member `link/passwd` writes /etc/passwd.
 * `symlinks` are the links already in the destination, relative to it.
 */
export function findSymlinkCollisions(members: string[], symlinks: string[]): string[] {
  if (symlinks.length === 0) return []
  const links = new Set(symlinks.map(normalizeRel).filter(Boolean))
  const hits: string[] = []
  for (const m of members) {
    const parts = normalizeRel(m).split('/')
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/')
      if (links.has(prefix)) {
        hits.push(m)
        break
      }
    }
  }
  return hits
}

/**
 * Top-level members that would overwrite a platform-managed file, when the
 * archive is extracted into the deploy root.
 */
export function findManagedCollisions(members: string[], destRel: string): string[] {
  if (normalizeRel(destRel) !== '') return []
  return members.filter((m) => isManagedRelPath(m))
}

/** Command copying the archive to a private temp file for listing + extracting. */
export function stageArchiveCommand(srcAbs: string, tmpAbs: string): string {
  return `cp --no-dereference -- ${shellQuoteArg(srcAbs)} ${shellQuoteArg(tmpAbs)} && chmod 600 -- ${shellQuoteArg(tmpAbs)}`
}

/**
 * Extract a staged archive into `destAbs`. Never keeps the archive's owners;
 * for tar also its permissions (umask applies), and any setuid / setgid bit
 * left behind is cleared afterwards. `overwrite: false` keeps existing files.
 * Bounded by `timeout`.
 */
export function extractCommand(
  kind: ListableArchive,
  archiveAbs: string,
  destAbs: string,
  opts: { overwrite: boolean }
): string {
  const a = shellQuoteArg(archiveAbs)
  const d = shellQuoteArg(destAbs)
  const t = `timeout ${ARCHIVE_TIME_LIMIT_SECONDS}`
  const run =
    kind === 'zip'
      ? `${t} unzip ${opts.overwrite ? '-o' : '-n'} -q ${a} -d ${d}`
      : `${t} tar -x${kind === 'tar.gz' ? 'z' : ''}f ${a} -C ${d} --no-same-owner --no-same-permissions${opts.overwrite ? '' : ' --skip-old-files'}`
  // The extractor's exit status is what the caller judges; the setuid sweep
  // runs whatever happened, so a partial extraction is cleaned too.
  return [
    `mkdir -p -- ${d} || exit 1`,
    run,
    `__apsamo_rc=$?`,
    `find -P ${d} -xdev -type f -perm /6000 -exec chmod ug-s -- {} + 2>/dev/null`,
    `exit $__apsamo_rc`,
  ].join('\n')
}

/**
 * Did the extractor succeed? `unzip` exits 1 for warnings (e.g. files it was
 * told not to overwrite) after finishing; everything else must be 0.
 */
export function extractSucceeded(kind: ListableArchive, exitCode: number | null | undefined): boolean {
  if (exitCode === 0) return true
  return kind === 'zip' && exitCode === 1
}

/** Links already in the destination folder, relative to it (bounded). */
export function listDestSymlinksCommand(destAbs: string): string {
  return `if [ -d ${shellQuoteArg(destAbs)} ]; then cd ${shellQuoteArg(destAbs)} && find -P . -xdev -type l -printf '%P\\n' | head -n ${MAX_DEST_SYMLINKS + 1}; fi`
}

/**
 * Compress `names` (children of `dirAbs`, given as plain names relative to
 * it) into `outAbs`. Refuses when the output exists or the input is over
 * the limit; writes to a temp name first so a failure leaves no half file.
 * -y stores links as links (never follows them); -nw turns off wildcard
 * matching so a file literally named `*.php` is just that file.
 */
export function zipCommand(dirAbs: string, names: string[], outAbs: string): string {
  if (names.length === 0) throw new Error('Nothing to compress')
  const items = names.map((n) => {
    const clean = normalizeRel(n)
    if (!clean || clean.split('/').includes('..')) throw new Error(`Invalid item: ${n}`)
    return shellQuoteArg(`./${clean}`)
  })
  const out = shellQuoteArg(outAbs)
  const part = shellQuoteArg(`${outAbs}.part`)
  return [
    `cd ${shellQuoteArg(dirAbs)}`,
    `if [ -e ${out} ] || [ -L ${out} ]; then exit ${EXIT_TARGET_EXISTS}; fi`,
    `__apsamo_size=$(du -sbc -P -- ${items.join(' ')} | tail -n 1 | cut -f1)`,
    `if [ "\${__apsamo_size:-0}" -gt ${MAX_COMPRESS_INPUT_BYTES} ]; then exit ${EXIT_TOO_LARGE}; fi`,
    `rm -f -- ${part}`,
    `timeout ${ARCHIVE_TIME_LIMIT_SECONDS} zip -r -q -y -nw ${part} ${items.join(' ')} || { __apsamo_rc=$?; rm -f -- ${part}; exit $__apsamo_rc; }`,
    `mv -n -- ${part} ${out}`,
    `echo __APSAMO_ZIP_DONE__`,
  ].join('\n')
}

/** `.zip` appended unless already there; the result is validated as a name. */
export function zipFileName(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  const problem = validateEntryName(raw)
  if (problem) return { ok: false, error: problem }
  const name = String(raw).trim()
  return { ok: true, name: /\.zip$/i.test(name) ? name : `${name}.zip` }
}

// ─── Copy / move ───────────────────────────────────────────────────────────

/**
 * Copy or move one path to `targetAbs`. Refuses when the target exists.
 * Copies keep links as links (-a implies --no-dereference) and owners, are
 * bounded by `timeout`, and drop setuid / setgid bits. Move is a rename
 * (`mv -n`).
 */
export function copyMoveCommand(op: 'copy' | 'move', srcAbs: string, targetAbs: string): string {
  const s = shellQuoteArg(srcAbs)
  const t = shellQuoteArg(targetAbs)
  const exists = `if [ -e ${t} ] || [ -L ${t} ]; then exit ${EXIT_TARGET_EXISTS}; fi`
  if (op === 'move') return `${exists}\nmv -n -T -- ${s} ${t}`
  return [
    exists,
    // Owners are kept: the copy stays writable by whoever owned the original
    // (www-data for WordPress uploads).
    `timeout ${ARCHIVE_TIME_LIMIT_SECONDS} cp -a -T -- ${s} ${t}`,
    `find -P ${t} -xdev -type f -perm /6000 -exec chmod ug-s -- {} + ; true`,
  ].join('\n')
}

// ─── Preview ───────────────────────────────────────────────────────────────

const PREVIEW_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
}

/** Content type for an inline preview, or null when the file is not previewable. */
export function previewContentType(name: string): string | null {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf('.')
  if (dot < 0) return null
  return PREVIEW_TYPES[lower.slice(dot + 1)] ?? null
}

/**
 * Response headers for a preview. The bytes are the customer's (or their
 * visitors' uploads), served from the panel's origin, so an SVG must not run
 * script there: a sandboxing CSP and nosniff. PDFs need the browser viewer,
 * which a sandbox blocks; they get no-script framing rules instead.
 */
export function previewHeaders(name: string, contentType: string, size: number): Record<string, string> {
  const safeName = path.posix.basename(name).replace(/["\\\r\n]/g, '_')
  const csp =
    contentType === 'application/pdf'
      ? "default-src 'none'; frame-ancestors 'self'"
      : "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox"
  return {
    'Content-Type': contentType,
    'Content-Disposition': `inline; filename="${safeName}"`,
    'Content-Length': String(size),
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  }
}
