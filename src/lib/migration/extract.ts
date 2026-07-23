/**
 * Archive extraction for every supported backup format.
 * ====================================================
 *
 * Extraction happens ON THE TARGET SERVER, never on the panel. A WordPress
 * backup with a media library is routinely 5–20 GB; unpacking it on the panel
 * and re-uploading the tree would double the transfer, need a matching amount
 * of panel disk, and take twice as long. The archive goes over SFTP once, is
 * unpacked in place into a scratch workspace, and only the finished tree is
 * moved into the project directory.
 *
 * Each backup product wraps the same two things — a file tree and a SQL dump —
 * in its own container, so the job here is normalising them:
 *
 *   wordpress-zip  plain zip/tarball of the WP directory
 *   wpress         All-in-One WP Migration's bespoke format (no standard tool
 *                  reads it, so we ship a small Python unpacker)
 *   duplicator     zip with the site at the root + dup-installer/*.sql
 *   updraftplus    a backup SET: db.gz plus separate plugins/themes/uploads
 *                  zips that have to be reassembled into wp-content/
 *   cpanel         tarball with homedir/public_html + mysql/*.sql
 *   files-sql      any archive, with the dump supplied separately
 *   git / docker   a clone rather than an archive
 */
import {
  exec,
  shellQuote,
  ensureRemoteDir,
  remoteExists,
  remoteIsDir,
  listDirs,
  listFileNames,
  findFiles,
  findFilesBySize,
  moveRemote,
  writeRemoteText,
  probeTools,
  tryInstallPackage,
  type AnyClient,
  type RemoteToolset,
} from './remote'
import type { MigrationSourceType } from './types'

export interface ExtractOptions {
  /** Absolute path of the uploaded archive on the target server. */
  archivePath: string
  /** Original filename — the extension drives the strategy. */
  filename: string
  sourceType: MigrationSourceType
  /** Scratch directory; must already exist and be owned by this migration. */
  workDir: string
  tools?: RemoteToolset
  onLog?: (line: string) => void
}

export interface ExtractResult {
  /** Directory holding the unpacked tree. */
  extractDir: string
  /** SQL dumps found inside the archive, largest first. */
  sqlFiles: string[]
  /** Extraction notes worth surfacing on the review screen. */
  warnings: string[]
}

// ─── The .wpress unpacker ─────────────────────────────────────────────────

/**
 * All-in-One WP Migration's .wpress container, in ~70 lines of Python.
 *
 * The format is a flat sequence of [4377-byte header][content] records:
 *   bytes    0..254   filename          (null-padded)
 *   bytes  255..268   size, ASCII       (null-padded)
 *   bytes  269..280   mtime, ASCII      (null-padded)
 *   bytes  281..4376  directory prefix  (null-padded)
 * A header of 4377 zero bytes terminates the archive.
 *
 * Content is copied in 1 MB chunks so peak memory stays flat regardless of
 * how large the archive or any single file inside it is.
 */
const WPRESS_EXTRACTOR = `#!/usr/bin/env python3
import os, sys

HEADER = 4377
N, S, M = 255, 14, 12

def field(raw):
    return raw.split(b'\\x00')[0].decode('utf-8', 'replace').strip()

def main(src, dst):
    dst = os.path.abspath(dst)
    os.makedirs(dst, exist_ok=True)
    count, skipped = 0, 0
    with open(src, 'rb') as f:
        while True:
            header = f.read(HEADER)
            if len(header) < HEADER:
                break
            if header.count(b'\\x00') == HEADER:
                break  # EOF block
            name = field(header[0:N])
            size_raw = field(header[N:N+S])
            prefix = field(header[N+S+M:HEADER])
            if not name:
                break
            try:
                size = int(size_raw or '0')
            except ValueError:
                break
            rel = os.path.join(prefix, name) if prefix and prefix != '.' else name
            target = os.path.normpath(os.path.join(dst, rel))
            # Archive-slip guard: never write outside the extraction root.
            if not (target == dst or target.startswith(dst + os.sep)):
                f.seek(size, 1)
                skipped += 1
                continue
            try:
                os.makedirs(os.path.dirname(target), exist_ok=True)
                remaining = size
                with open(target, 'wb') as out:
                    while remaining > 0:
                        chunk = f.read(min(1048576, remaining))
                        if not chunk:
                            break
                        out.write(chunk)
                        remaining -= len(chunk)
                if remaining > 0:
                    f.seek(remaining, 1)
                count += 1
            except OSError as e:
                f.seek(size, 1)
                skipped += 1
    print('extracted=%d skipped=%d' % (count, skipped))

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit('usage: wpress.py <archive> <dest>')
    main(sys.argv[1], sys.argv[2])
`

/**
 * Fallback ZIP extractor for hosts without `unzip`. Python 3 ships zipfile in
 * the standard library and is present on effectively every modern Linux
 * server, which makes it a more reliable dependency than unzip itself.
 */
const PY_UNZIP = `#!/usr/bin/env python3
import os, sys, zipfile

def main(src, dst):
    dst = os.path.abspath(dst)
    os.makedirs(dst, exist_ok=True)
    skipped = 0
    with zipfile.ZipFile(src) as z:
        for info in z.infolist():
            name = info.filename
            target = os.path.normpath(os.path.join(dst, name))
            if not (target == dst or target.startswith(dst + os.sep)):
                skipped += 1
                continue
            if info.is_dir():
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with z.open(info) as fsrc, open(target, 'wb') as fdst:
                while True:
                    chunk = fsrc.read(1048576)
                    if not chunk:
                        break
                    fdst.write(chunk)
    print('skipped=%d' % skipped)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
`

// ─── Format helpers ───────────────────────────────────────────────────────

type ArchiveKind =
  | 'zip'
  | 'tar'
  | 'tar.gz'
  | 'tar.bz2'
  | 'tar.xz'
  | 'gz'
  | 'bz2'
  | 'xz'
  | 'wpress'
  | 'sql'
  | 'unknown'

export function archiveKind(filename: string): ArchiveKind {
  const f = filename.toLowerCase()
  if (f.endsWith('.wpress')) return 'wpress'
  // Duplicator's `.daf` is a ZIP with a different name on it. Mapping it here
  // rather than leaving it to the magic-byte sniffer avoids telling the
  // customer their correctly-named archive "is really zip despite the name".
  if (f.endsWith('.zip') || f.endsWith('.daf')) return 'zip'
  if (f.endsWith('.tar.gz') || f.endsWith('.tgz')) return 'tar.gz'
  if (f.endsWith('.tar.bz2') || f.endsWith('.tbz2') || f.endsWith('.tbz')) return 'tar.bz2'
  if (f.endsWith('.tar.xz') || f.endsWith('.txz')) return 'tar.xz'
  if (f.endsWith('.tar')) return 'tar'
  if (f.endsWith('.sql.gz')) return 'gz'
  if (f.endsWith('.sql.bz2')) return 'bz2'
  if (f.endsWith('.sql')) return 'sql'
  if (f.endsWith('.gz')) return 'gz'
  if (f.endsWith('.bz2')) return 'bz2'
  if (f.endsWith('.xz')) return 'xz'
  return 'unknown'
}

/**
 * Sniff the real format from the file's magic bytes.
 *
 * Filenames lie constantly in this domain: customers rename `.tar.gz` to
 * `.zip` because a form only accepted zips, cPanel hands out extensionless
 * files, and Duplicator's `.daf` is a zip wearing a hat. Trusting the
 * extension means picking the wrong tool and reporting "corrupt archive" for
 * an archive that is perfectly fine.
 */
async function sniffKind(
  client: AnyClient,
  archivePath: string
): Promise<ArchiveKind | null> {
  const r = await exec(
    client,
    `head -c 6 ${shellQuote(archivePath)} | od -An -tx1 | tr -d ' \\n' || true`,
    { timeoutMs: 30000 }
  )
  const hex = r.stdout.trim().toLowerCase()
  if (!hex) return null
  if (hex.startsWith('504b0304') || hex.startsWith('504b0506')) return 'zip'
  if (hex.startsWith('1f8b')) return 'tar.gz' // could be a bare .gz; caller re-checks
  if (hex.startsWith('425a68')) return 'tar.bz2'
  if (hex.startsWith('fd377a58')) return 'tar.xz'
  return null
}

/** Decompress-and-untar command for a given kind. */
function tarCommand(kind: ArchiveKind, archive: string, dest: string): string {
  // --no-same-owner: uids inside a customer's cPanel tarball are meaningless
  //   here and would otherwise create files owned by a random local account.
  // --no-same-permissions: setuid bits inside an untrusted archive are never
  //   something we want to preserve.
  const flags = '--no-same-owner --no-same-permissions'
  const decomp =
    kind === 'tar.gz' ? 'z' : kind === 'tar.bz2' ? 'j' : kind === 'tar.xz' ? 'J' : ''
  return `tar -x${decomp}f ${shellQuote(archive)} -C ${shellQuote(dest)} ${flags} 2>&1`
}

// ─── Generic archive extraction ───────────────────────────────────────────

/**
 * Unpack any supported archive into `dest`. Chooses a strategy from the real
 * (sniffed) format and the tools present, installing `unzip` on demand and
 * falling back to Python when that is not possible.
 */
async function extractArchive(
  client: AnyClient,
  archivePath: string,
  filename: string,
  dest: string,
  tools: RemoteToolset,
  log: (l: string) => void,
  warnings: string[]
): Promise<void> {
  await ensureRemoteDir(client, dest)

  const declared = archiveKind(filename)
  const sniffed = await sniffKind(client, archivePath)
  let kind = declared

  if (sniffed && sniffed !== declared) {
    // gzip magic covers both `.tar.gz` and a bare `.sql.gz`; only correct the
    // kind when the declared extension was not already a gzip variant.
    const gzipFamily = declared === 'gz' || declared === 'tar.gz'
    if (!(sniffed === 'tar.gz' && gzipFamily)) {
      log(
        `Archive is really ${sniffed} despite the .${declared} name — using the ${sniffed} extractor.`
      )
      warnings.push(
        `File was named "${filename}" but its contents are ${sniffed}. Extracted as ${sniffed}.`
      )
      kind = sniffed
    }
  }

  switch (kind) {
    case 'zip': {
      if (!tools.unzip) {
        log('unzip is missing on this server — installing it…')
        tools.unzip = await tryInstallPackage(client, 'unzip')
      }
      if (tools.unzip) {
        // -o overwrite, -q quiet. unzip refuses absolute and ../ paths itself.
        const r = await exec(
          client,
          `unzip -o -q ${shellQuote(archivePath)} -d ${shellQuote(dest)} 2>&1`,
          { timeoutMs: 3600_000 }
        )
        // Exit 1 is "completed with warnings" (e.g. skipped a weird entry),
        // which is normal for real-world backups and not a failure.
        if (r.exitCode !== 0 && r.exitCode !== 1) {
          throw new Error(`unzip failed: ${(r.stdout || r.stderr).slice(-400)}`)
        }
        if (r.exitCode === 1) {
          warnings.push('Some archive entries were skipped during extraction.')
        }
      } else if (tools.python3) {
        log('Falling back to the built-in Python ZIP extractor…')
        const script = `${dest}/../unzip.py`
        await writeRemoteText(client, script, PY_UNZIP, { mode: 0o755 })
        const r = await exec(
          client,
          `python3 ${shellQuote(script)} ${shellQuote(archivePath)} ${shellQuote(dest)} 2>&1`,
          { timeoutMs: 3600_000 }
        )
        if (r.exitCode !== 0) {
          throw new Error(`ZIP extraction failed: ${r.stdout.slice(-400)}`)
        }
      } else {
        throw new Error(
          'This server has neither unzip nor python3, so ZIP archives cannot be extracted.'
        )
      }
      break
    }

    case 'tar':
    case 'tar.gz':
    case 'tar.bz2':
    case 'tar.xz': {
      if (!tools.tar) throw new Error('tar is not available on this server.')
      const r = await exec(client, tarCommand(kind, archivePath, dest), {
        timeoutMs: 3600_000,
      })
      if (r.exitCode !== 0) {
        throw new Error(`tar failed: ${(r.stdout || r.stderr).slice(-400)}`)
      }
      break
    }

    case 'gz':
    case 'bz2':
    case 'xz': {
      // A single compressed file — almost always a SQL dump. Decompress it
      // into the destination under its own name.
      const base = filename.replace(/\.(gz|bz2|xz)$/i, '') || 'dump.sql'
      const tool = kind === 'gz' ? 'gzip' : kind === 'bz2' ? 'bzip2' : 'xz'
      const r = await exec(
        client,
        `${tool} -dc ${shellQuote(archivePath)} > ${shellQuote(`${dest}/${base}`)} 2>/dev/null`,
        { timeoutMs: 1800_000 }
      )
      if (r.exitCode !== 0) {
        throw new Error(`${tool} decompression failed: ${r.stderr.slice(-400)}`)
      }
      break
    }

    case 'sql': {
      const r = await exec(
        client,
        `cp -f ${shellQuote(archivePath)} ${shellQuote(`${dest}/${filename}`)}`,
        { timeoutMs: 600_000 }
      )
      if (r.exitCode !== 0) throw new Error(`Could not stage SQL file: ${r.stderr}`)
      break
    }

    case 'wpress':
      throw new Error('.wpress archives are handled by extractWpress, not here.')

    default:
      throw new Error(
        `Unsupported archive format for "${filename}". Supported: .zip, .tar, .tar.gz, .tar.bz2, .tar.xz, .wpress, .sql, .sql.gz`
      )
  }
}

// ─── .wpress ──────────────────────────────────────────────────────────────

async function extractWpress(
  client: AnyClient,
  archivePath: string,
  dest: string,
  tools: RemoteToolset,
  log: (l: string) => void
): Promise<void> {
  if (!tools.python3) {
    log('python3 is missing — installing it to read the .wpress archive…')
    tools.python3 = await tryInstallPackage(client, 'python3')
  }
  if (!tools.python3) {
    throw new Error(
      'Reading All-in-One WP Migration (.wpress) archives needs python3, which is not installed and could not be installed automatically.'
    )
  }
  await ensureRemoteDir(client, dest)
  const script = `${dest}/../wpress.py`
  await writeRemoteText(client, script, WPRESS_EXTRACTOR, { mode: 0o755 })
  log('Unpacking .wpress archive…')
  const r = await exec(
    client,
    `python3 ${shellQuote(script)} ${shellQuote(archivePath)} ${shellQuote(dest)} 2>&1`,
    { timeoutMs: 3600_000 }
  )
  if (r.exitCode !== 0) {
    throw new Error(`.wpress extraction failed: ${r.stdout.slice(-500)}`)
  }
  log(r.stdout.trim().slice(-200) || 'Archive unpacked.')

  // All-in-One writes the database as `database.sql` at the archive root and
  // keeps the site tree beside it. Nothing to rearrange, but confirm we got a
  // recognisable payload rather than silently importing an empty directory.
  const names = await listFileNames(client, dest)
  const dirs = await listDirs(client, dest)
  if (names.length === 0 && dirs.length === 0) {
    throw new Error('The .wpress archive unpacked to nothing — it may be corrupt.')
  }
}

// ─── UpdraftPlus ──────────────────────────────────────────────────────────

/**
 * Reassemble an UpdraftPlus backup set.
 *
 * UpdraftPlus does not produce one archive; it produces a set:
 *   backup_<date>_<site>_<hash>-db.gz         → the SQL dump
 *   …-plugins.zip / -themes.zip / -uploads.zip / -others.zip
 * each of which unpacks to the *contents* of the matching wp-content folder.
 * Customers hand us either the whole set inside one zip, or a single file. We
 * put the components back where WordPress expects them.
 */
async function assembleUpdraft(
  client: AnyClient,
  dir: string,
  tools: RemoteToolset,
  log: (l: string) => void,
  warnings: string[]
): Promise<void> {
  const components: Array<{ suffix: string; target: string }> = [
    { suffix: '-plugins.zip', target: 'wp-content/plugins' },
    { suffix: '-themes.zip', target: 'wp-content/themes' },
    { suffix: '-uploads.zip', target: 'wp-content/uploads' },
    { suffix: '-mu-plugins.zip', target: 'wp-content/mu-plugins' },
    { suffix: '-others.zip', target: 'wp-content' },
  ]

  let matched = 0
  for (const comp of components) {
    const found = await findFiles(client, dir, `*${comp.suffix}`, { limit: 5 })
    for (const zipPath of found) {
      const target = `${dir}/${comp.target}`
      log(`Restoring ${comp.target} from ${zipPath.split('/').pop()}…`)
      await ensureRemoteDir(client, target)
      await extractArchive(
        client,
        zipPath,
        zipPath.split('/').pop() || 'component.zip',
        target,
        tools,
        log,
        warnings
      )
      await exec(client, `rm -f ${shellQuote(zipPath)}`, { timeoutMs: 60000 })
      matched++
    }
  }

  // The database component is gzipped SQL; decompress it in place so the
  // detector finds a plain .sql file like every other format.
  const dbFiles = await findFiles(client, dir, '*-db.gz', { limit: 5 })
  for (const gz of dbFiles) {
    const out = gz.replace(/\.gz$/, '.sql')
    log(`Decompressing database dump ${gz.split('/').pop()}…`)
    const r = await exec(
      client,
      `gzip -dc ${shellQuote(gz)} > ${shellQuote(out)} && rm -f ${shellQuote(gz)}`,
      { timeoutMs: 1800_000 }
    )
    if (r.exitCode !== 0) {
      warnings.push(`Could not decompress ${gz.split('/').pop()}.`)
    }
    matched++
  }
  // Some versions ship the dump uncompressed or with a .crypt extension.
  const encrypted = await findFiles(client, dir, '*-db.gz.crypt', { limit: 3 })
  if (encrypted.length > 0) {
    warnings.push(
      'This UpdraftPlus backup contains an ENCRYPTED database (.crypt). Decrypt it in UpdraftPlus first, then re-upload — we cannot import it without your encryption phrase.'
    )
  }

  if (matched === 0) {
    warnings.push(
      'No UpdraftPlus component archives were found — importing the upload as a plain file backup instead.'
    )
  }
}

// ─── Duplicator ───────────────────────────────────────────────────────────

/**
 * Tidy a Duplicator package after extraction.
 *
 * Duplicator archives contain the site at the root plus a `dup-installer/`
 * directory holding the SQL dump and its PHP installer. That installer must
 * NOT survive into the live document root: it is a well-known unauthenticated
 * remote-code-execution surface when left behind, and it is useless here since
 * we perform the install ourselves.
 */
async function tidyDuplicator(
  client: AnyClient,
  dir: string,
  log: (l: string) => void
): Promise<string[]> {
  const sql = await findFilesBySize(client, dir, 'dup-database__*.sql', { limit: 5 })
  const generic = sql.length
    ? sql
    : await findFilesBySize(client, dir, 'database.sql', { limit: 5 })

  // Move the dump out of the tree before deleting the installer directory.
  const kept: string[] = []
  for (const f of generic) {
    const dest = `${dir}/__apsamo_dump_${f.path.split('/').pop()}`
    await moveRemote(client, f.path, dest).catch(() => {})
    if (await remoteExists(client, dest)) kept.push(dest)
  }

  const installerDir = `${dir}/dup-installer`
  if (await remoteIsDir(client, installerDir)) {
    log('Removing the Duplicator installer (not needed, and unsafe to leave live)…')
    await exec(client, `rm -rf ${shellQuote(installerDir)}`, { timeoutMs: 300000 })
  }
  for (const leftover of ['installer.php', 'installer-backup.php', 'dup-installer-bootlog__*.txt']) {
    await exec(client, `rm -f ${shellQuote(dir)}/${leftover}`, { timeoutMs: 60000 })
  }
  return kept
}

// ─── cPanel ───────────────────────────────────────────────────────────────

/**
 * Locate the real document root inside a cPanel backup and hoist it.
 *
 * cPanel tarballs look like `<user>/homedir/public_html/…` with the SQL dumps
 * in `<user>/mysql/*.sql`. We keep the dumps but return the public_html path
 * so the rest of the pipeline treats it as the site root.
 */
async function locateCpanelRoot(
  client: AnyClient,
  dir: string
): Promise<{ root: string; sqlFiles: string[] }> {
  const candidates = [
    `${dir}/homedir/public_html`,
    `${dir}/public_html`,
  ]
  // The tarball usually has a single top-level directory named after the user.
  const topDirs = await listDirs(client, dir)
  for (const d of topDirs) {
    candidates.push(`${dir}/${d}/homedir/public_html`)
    candidates.push(`${dir}/${d}/public_html`)
  }

  let root = dir
  for (const c of candidates) {
    if (await remoteIsDir(client, c)) {
      root = c
      break
    }
  }

  const dumps = await findFilesBySize(client, dir, '*.sql', { limit: 30 })
  // Prefer dumps under a mysql/ directory; cPanel also ships tiny per-user
  // grant files that are not the site database.
  const sqlFiles = dumps
    .filter((f) => !f.path.startsWith(root + '/'))
    .sort((a, b) => {
      const aMy = a.path.includes('/mysql/') ? 1 : 0
      const bMy = b.path.includes('/mysql/') ? 1 : 0
      if (aMy !== bMy) return bMy - aMy
      return b.size - a.size
    })
    .map((f) => f.path)

  return { root, sqlFiles }
}

// ─── Single-child flattening ──────────────────────────────────────────────

/**
 * Collapse a wrapper directory.
 *
 * Most people zip the folder, not its contents, so the archive unpacks to
 * `workspace/my-site/wp-config.php` rather than `workspace/wp-config.php`.
 * Detection would then have to search, and every subsequent path would need a
 * prefix. Descend through single-child directories (up to a few levels) until
 * something that looks like a site root appears.
 */
async function flattenSingleChild(
  client: AnyClient,
  dir: string,
  log: (l: string) => void
): Promise<string> {
  let current = dir
  for (let depth = 0; depth < 4; depth++) {
    const files = await listFileNames(client, current)
    const dirs = await listDirs(client, current)
    // A root worth stopping at has recognisable files in it.
    const looksLikeRoot = files.some((f) =>
      ['wp-config.php', 'index.php', 'index.html', 'package.json', 'composer.json', 'artisan', 'Dockerfile', 'docker-compose.yml'].includes(f)
    )
    if (looksLikeRoot) break
    // wp-content + wp-includes without wp-config still means "this is the root".
    if (dirs.includes('wp-content') || dirs.includes('wp-includes')) break

    const meaningful = files.filter((f) => !f.startsWith('.') && f !== '__MACOSX')
    const meaningfulDirs = dirs.filter((d) => d !== '__MACOSX')
    if (meaningfulDirs.length === 1 && meaningful.length === 0) {
      current = `${current}/${meaningfulDirs[0]}`
      log(`Descending into wrapper directory "${meaningfulDirs[0]}"…`)
      continue
    }
    break
  }
  return current
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Unpack `archivePath` into `<workDir>/extracted` and normalise the layout for
 * the detector. Never throws for cosmetic problems — those become `warnings`
 * shown on the review screen — but does throw when nothing usable came out,
 * because continuing would produce a broken site.
 */
export async function extractPayload(
  client: AnyClient,
  opts: ExtractOptions
): Promise<ExtractResult> {
  const log = (l: string) => opts.onLog?.(l)
  const warnings: string[] = []
  const tools = opts.tools ?? (await probeTools(client))
  const dest = `${opts.workDir}/extracted`

  await ensureRemoteDir(client, dest)

  if (opts.sourceType === 'wpress' || archiveKind(opts.filename) === 'wpress') {
    await extractWpress(client, opts.archivePath, dest, tools, log)
  } else {
    log(`Extracting ${opts.filename}…`)
    await extractArchive(
      client,
      opts.archivePath,
      opts.filename,
      dest,
      tools,
      log,
      warnings
    )
  }

  // macOS zips carry a resource-fork directory that confuses root detection
  // and ships junk into the live site.
  await exec(client, `rm -rf ${shellQuote(dest)}/__MACOSX`, { timeoutMs: 60000 })

  let root = dest
  let sqlFiles: string[] = []

  switch (opts.sourceType) {
    case 'updraftplus':
      await assembleUpdraft(client, dest, tools, log, warnings)
      root = await flattenSingleChild(client, dest, log)
      break

    case 'duplicator': {
      const dumps = await tidyDuplicator(client, dest, log)
      sqlFiles = dumps
      root = await flattenSingleChild(client, dest, log)
      break
    }

    case 'cpanel': {
      const located = await locateCpanelRoot(client, dest)
      root = located.root
      sqlFiles = located.sqlFiles
      if (root === dest) {
        warnings.push(
          'Could not find public_html inside the cPanel backup — importing the archive root instead.'
        )
      }
      break
    }

    default:
      root = await flattenSingleChild(client, dest, log)
      break
  }

  // Collect SQL dumps if the format-specific step did not already.
  if (sqlFiles.length === 0) {
    const found = await findFilesBySize(client, dest, '*.sql', { limit: 30 })
    sqlFiles = found
      // Ignore the dumps WordPress plugins leave inside wp-content — they are
      // stale backups of the very site we are importing, and picking one would
      // silently restore an older copy of the customer's data.
      .filter((f) => !/\/wp-content\/(uploads|ai1wm-backups|updraft|backup)/i.test(f.path))
      .filter((f) => f.size > 0)
      .map((f) => f.path)
  }

  const rootFiles = await listFileNames(client, root)
  const rootDirs = await listDirs(client, root)
  if (rootFiles.length === 0 && rootDirs.length === 0) {
    throw new Error(
      'The archive extracted to an empty directory. It may be corrupt, password-protected, or not a website backup.'
    )
  }

  log(
    `Extraction complete — ${rootFiles.length} file(s) and ${rootDirs.length} folder(s) at the root, ${sqlFiles.length} SQL dump(s) found.`
  )

  return { extractDir: root, sqlFiles, warnings }
}

// ─── Git ──────────────────────────────────────────────────────────────────

/**
 * Clone a repository into the workspace.
 *
 * The token is injected into the remote URL at call time and the URL is
 * scrubbed from anything we log or persist — a PAT in a build log is a
 * credential leak that outlives the migration.
 */
export async function cloneRepository(
  client: AnyClient,
  opts: {
    repoUrl: string
    branch?: string
    token?: string
    workDir: string
    onLog?: (l: string) => void
  }
): Promise<ExtractResult> {
  const log = (l: string) => opts.onLog?.(l)
  const dest = `${opts.workDir}/extracted`
  await ensureRemoteDir(client, dest)

  let url = opts.repoUrl.trim()
  if (opts.token) {
    try {
      const parsed = new URL(url)
      // GitHub/GitLab/Bitbucket all accept a token in the userinfo position.
      parsed.username = opts.token
      parsed.password = 'x-oauth-basic'
      url = parsed.toString()
    } catch {
      throw new Error(`"${opts.repoUrl}" is not a valid repository URL.`)
    }
  }

  const branch = (opts.branch || '').trim()
  const branchFlag = branch ? `--branch ${shellQuote(branch)}` : ''
  log(`Cloning ${redactUrl(opts.repoUrl)}${branch ? ` (branch ${branch})` : ''}…`)

  // --depth 1: migrations want the working tree, not the history, and a
  // shallow clone turns a 400 MB repo into a 20 MB transfer.
  const r = await exec(
    client,
    `GIT_TERMINAL_PROMPT=0 git clone --depth 1 ${branchFlag} ${shellQuote(url)} ${shellQuote(dest)} 2>&1`,
    { timeoutMs: 1800_000 }
  )
  if (r.exitCode !== 0) {
    throw new Error(`Clone failed: ${redactUrl(r.stdout || r.stderr).slice(-400)}`)
  }

  const sql = await findFilesBySize(client, dest, '*.sql', { limit: 10 })
  return {
    extractDir: dest,
    sqlFiles: sql.map((f) => f.path),
    warnings: [],
  }
}

/** Strip credentials out of a URL before it reaches a log or the database. */
export function redactUrl(text: string): string {
  return text.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@')
}
