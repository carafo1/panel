/**
 * Remote filesystem helpers for the migration runner.
 * ==================================================
 *
 * `vps/ssh.ts` covers the general case, but migrations move multi-gigabyte
 * archives and inspect large directory trees, which needs two things the
 * generic helpers do not provide:
 *
 *   1. `putFileFromPath` — SFTP straight from a path on disk. `putFile` takes
 *      a Buffer, so uploading a 4 GB backup through it would first read the
 *      whole archive into the Node heap and kill the panel process.
 *   2. A set of small, quoted, read-only shell probes (exists / size / find)
 *      used by detection, wrapped so a failure returns a value instead of
 *      throwing — detection is best-effort by nature and must never abort an
 *      import over a missing optional file.
 */
import { withConnection, exec, shellQuote, type SshCredentials } from '@/lib/vps/ssh'
import type { Client } from 'ssh2'
import type { LocalClient } from '@/lib/vps/local-exec'

type AnyClient = Client | LocalClient

export { shellQuote }

// ─── Transfer ─────────────────────────────────────────────────────────────

/**
 * Upload a local file to the remote host by path, without buffering it.
 *
 * Works for both transports: ssh2's real SFTP `fastPut` streams the file, and
 * `LocalClient`'s SFTP shim implements `fastPut` as a `copyFile`.
 */
export async function putFileFromPath(
  client: AnyClient,
  localPath: string,
  remotePath: string,
  opts: { mode?: number; onProgress?: (transferred: number, total: number) => void } = {}
): Promise<void> {
  const sftp = await new Promise<{
    fastPut: (
      src: string,
      dest: string,
      optsOrCb: unknown,
      cb?: (err?: Error | null) => void
    ) => void
    chmod: (p: string, mode: number, cb: (err?: Error | null) => void) => void
  }>((resolve, reject) => {
    client.sftp((err, s) => (err ? reject(err) : resolve(s as never)))
  })

  await new Promise<void>((resolve, reject) => {
    const transferOpts = opts.onProgress
      ? {
          step: (transferred: number, _chunk: number, total: number) => {
            opts.onProgress?.(transferred, total)
          },
        }
      : {}
    sftp.fastPut(localPath, remotePath, transferOpts, (err) =>
      err ? reject(err) : resolve()
    )
  })

  if (opts.mode !== undefined) {
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(remotePath, opts.mode!, (err) => (err ? reject(err) : resolve()))
    })
  }
}

// ─── Probes ───────────────────────────────────────────────────────────────

/** True when the path exists on the remote host (file, dir, or symlink). */
export async function remoteExists(
  client: AnyClient,
  remotePath: string
): Promise<boolean> {
  const r = await exec(
    client,
    `test -e ${shellQuote(remotePath)} && echo yes || echo no`,
    { timeoutMs: 15000 }
  )
  return r.stdout.trim() === 'yes'
}

/** True when the path exists and is a directory. */
export async function remoteIsDir(
  client: AnyClient,
  remotePath: string
): Promise<boolean> {
  const r = await exec(
    client,
    `test -d ${shellQuote(remotePath)} && echo yes || echo no`,
    { timeoutMs: 15000 }
  )
  return r.stdout.trim() === 'yes'
}

/** Total size of a path in bytes; 0 when it does not exist. */
export async function remoteSize(
  client: AnyClient,
  remotePath: string
): Promise<number> {
  const r = await exec(
    client,
    `du -sb ${shellQuote(remotePath)} 2>/dev/null | cut -f1 || echo 0`,
    { timeoutMs: 120000 }
  )
  const n = parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/** Number of regular files under a path. */
export async function remoteFileCount(
  client: AnyClient,
  remotePath: string
): Promise<number> {
  const r = await exec(
    client,
    `find ${shellQuote(remotePath)} -type f 2>/dev/null | wc -l || echo 0`,
    { timeoutMs: 120000 }
  )
  const n = parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/** Bytes free on the filesystem holding `remotePath`. */
export async function remoteFreeBytes(
  client: AnyClient,
  remotePath: string
): Promise<number> {
  const r = await exec(
    client,
    `df -B1 --output=avail ${shellQuote(remotePath)} 2>/dev/null | tail -1 || echo 0`,
    { timeoutMs: 20000 }
  )
  const n = parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Read a (small) remote file as UTF-8. Returns null when absent or unreadable.
 * Capped so a caller that points this at a 3 GB SQL dump by mistake truncates
 * instead of exhausting memory.
 */
export async function readRemoteText(
  client: AnyClient,
  remotePath: string,
  maxBytes = 256 * 1024
): Promise<string | null> {
  const r = await exec(
    client,
    `head -c ${maxBytes} ${shellQuote(remotePath)} 2>/dev/null || true`,
    { timeoutMs: 30000 }
  )
  if (r.exitCode !== 0 && !r.stdout) return null
  return r.stdout || null
}

/**
 * Find files matching a glob-ish `-name` pattern, up to `limit` results.
 * Returns absolute remote paths, deepest-last (find's natural order).
 */
export async function findFiles(
  client: AnyClient,
  root: string,
  namePattern: string,
  opts: { maxDepth?: number; limit?: number } = {}
): Promise<string[]> {
  const depth = opts.maxDepth ? `-maxdepth ${opts.maxDepth}` : ''
  const limit = opts.limit ?? 200
  const r = await exec(
    client,
    `find ${shellQuote(root)} ${depth} -type f -name ${shellQuote(namePattern)} 2>/dev/null | head -n ${limit} || true`,
    { timeoutMs: 120000 }
  )
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * List files matching a pattern together with their sizes, largest first.
 * Used to pick the real SQL dump out of a backup that ships several.
 */
export async function findFilesBySize(
  client: AnyClient,
  root: string,
  namePattern: string,
  opts: { limit?: number } = {}
): Promise<Array<{ path: string; size: number }>> {
  const limit = opts.limit ?? 50
  const r = await exec(
    client,
    `find ${shellQuote(root)} -type f -name ${shellQuote(namePattern)} -printf '%s\\t%p\\n' 2>/dev/null | sort -rn | head -n ${limit} || true`,
    { timeoutMs: 120000 }
  )
  return r.stdout
    .split('\n')
    .map((line) => {
      const [sizeStr, ...rest] = line.split('\t')
      const p = rest.join('\t').trim()
      const size = parseInt(sizeStr, 10)
      if (!p || !Number.isFinite(size)) return null
      return { path: p, size }
    })
    .filter((x): x is { path: string; size: number } => x !== null)
}

/** Immediate subdirectories of `root` (names only, no dotfiles). */
export async function listDirs(
  client: AnyClient,
  root: string
): Promise<string[]> {
  const r = await exec(
    client,
    `find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | head -n 500 || true`,
    { timeoutMs: 30000 }
  )
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('.'))
}

/** Immediate files of `root` (names only). */
export async function listFileNames(
  client: AnyClient,
  root: string
): Promise<string[]> {
  const r = await exec(
    client,
    `find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -type f -printf '%f\\n' 2>/dev/null | head -n 500 || true`,
    { timeoutMs: 30000 }
  )
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

// ─── Mutations ────────────────────────────────────────────────────────────

export async function ensureRemoteDir(
  client: AnyClient,
  remotePath: string
): Promise<void> {
  const r = await exec(client, `mkdir -p ${shellQuote(remotePath)}`, {
    timeoutMs: 30000,
  })
  if (r.exitCode !== 0) {
    throw new Error(`Could not create ${remotePath}: ${r.stderr.trim()}`)
  }
}

/**
 * Recursively delete a path — with a guard rail. Migration workspaces live
 * under a known root, and a bug that computed an empty or short path here
 * would `rm -rf` something catastrophic, so anything outside the allowed
 * prefixes is refused.
 */
export async function removeRemotePath(
  client: AnyClient,
  remotePath: string,
  allowedPrefixes: string[]
): Promise<void> {
  const normalized = remotePath.replace(/\/+$/, '')
  if (!normalized || normalized === '/' || normalized.split('/').length < 3) {
    throw new Error(`Refusing to delete suspicious path: ${remotePath}`)
  }
  if (normalized.includes('..')) {
    throw new Error(`Refusing to delete path containing '..': ${remotePath}`)
  }
  const allowed = allowedPrefixes.some(
    (p) => normalized === p || normalized.startsWith(p.replace(/\/+$/, '') + '/')
  )
  if (!allowed) {
    throw new Error(
      `Refusing to delete ${remotePath} — outside the migration workspace`
    )
  }
  await exec(client, `rm -rf ${shellQuote(normalized)}`, { timeoutMs: 300000 })
}

/** Move/rename, creating the destination's parent first. */
export async function moveRemote(
  client: AnyClient,
  from: string,
  to: string
): Promise<void> {
  const r = await exec(
    client,
    `mkdir -p "$(dirname ${shellQuote(to)})" && mv -f ${shellQuote(from)} ${shellQuote(to)}`,
    { timeoutMs: 300000 }
  )
  if (r.exitCode !== 0) {
    throw new Error(`Move failed (${from} → ${to}): ${r.stderr.trim()}`)
  }
}

/**
 * Copy the *contents* of `from` into `to`, including dotfiles, without
 * clobbering `to` itself. `cp -a src/. dst/` is the portable spelling that
 * gets dotfiles right — `cp -a src/* dst/` silently drops `.htaccess`, which
 * on a WordPress import means every permalink 404s.
 */
export async function copyContents(
  client: AnyClient,
  from: string,
  to: string,
  opts: { timeoutMs?: number } = {}
): Promise<void> {
  await ensureRemoteDir(client, to)
  const r = await exec(
    client,
    `cp -a ${shellQuote(from.replace(/\/+$/, ''))}/. ${shellQuote(to)}/`,
    { timeoutMs: opts.timeoutMs ?? 900000 }
  )
  if (r.exitCode !== 0) {
    throw new Error(`Copy failed (${from} → ${to}): ${r.stderr.trim().slice(0, 400)}`)
  }
}

/** Write a text file remotely via a heredoc — avoids a second SFTP round trip. */
export async function writeRemoteText(
  client: AnyClient,
  remotePath: string,
  content: string,
  opts: { mode?: number } = {}
): Promise<void> {
  const marker = `APSAMO_EOF_${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  // Quoted heredoc marker → the shell performs no expansion, so PHP's `$var`
  // and backticks in the payload survive verbatim.
  const cmd = `mkdir -p "$(dirname ${shellQuote(remotePath)})" && cat > ${shellQuote(remotePath)} <<'${marker}'\n${content}\n${marker}\n`
  const r = await exec(client, cmd, { timeoutMs: 60000 })
  if (r.exitCode !== 0) {
    throw new Error(`Write failed (${remotePath}): ${r.stderr.trim()}`)
  }
  if (opts.mode !== undefined) {
    await exec(
      client,
      `chmod ${opts.mode.toString(8).padStart(3, '0')} ${shellQuote(remotePath)}`,
      { timeoutMs: 15000 }
    )
  }
}

// ─── Tooling probes ───────────────────────────────────────────────────────

export interface RemoteToolset {
  unzip: boolean
  tar: boolean
  gzip: boolean
  bzip2: boolean
  xz: boolean
  python3: boolean
  git: boolean
  docker: boolean
  curl: boolean
  rsync: boolean
}

/**
 * One round trip that reports which extraction tools the host actually has.
 * The extractor picks a strategy from this instead of assuming — a Debian
 * minimal image ships `tar` but frequently not `unzip`, and finding that out
 * halfway through a customer's import is a bad time.
 */
export async function probeTools(client: AnyClient): Promise<RemoteToolset> {
  const names = [
    'unzip',
    'tar',
    'gzip',
    'bzip2',
    'xz',
    'python3',
    'git',
    'docker',
    'curl',
    'rsync',
  ]
  const script = names
    .map((n) => `command -v ${n} >/dev/null 2>&1 && echo "${n}=1" || echo "${n}=0"`)
    .join('; ')
  const r = await exec(client, script, { timeoutMs: 30000 })
  const found = new Set(
    r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('=1'))
      .map((l) => l.split('=')[0])
  )
  return {
    unzip: found.has('unzip'),
    tar: found.has('tar'),
    gzip: found.has('gzip'),
    bzip2: found.has('bzip2'),
    xz: found.has('xz'),
    python3: found.has('python3'),
    git: found.has('git'),
    docker: found.has('docker'),
    curl: found.has('curl'),
    rsync: found.has('rsync'),
  }
}

/**
 * Install a missing extraction tool with the host's package manager. Returns
 * false rather than throwing when it cannot — the caller falls back to another
 * strategy (e.g. Python's zipfile) instead of failing the whole import.
 */
export async function tryInstallPackage(
  client: AnyClient,
  pkg: string
): Promise<boolean> {
  const r = await exec(
    client,
    `(command -v apt-get >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${pkg}) || ` +
      `(command -v dnf >/dev/null 2>&1 && dnf install -y -q ${pkg}) || ` +
      `(command -v yum >/dev/null 2>&1 && yum install -y -q ${pkg}) || ` +
      `(command -v apk >/dev/null 2>&1 && apk add --no-cache ${pkg}) || true`,
    { timeoutMs: 180000 }
  )
  if (r.exitCode !== 0) return false
  const check = await exec(
    client,
    `command -v ${pkg} >/dev/null 2>&1 && echo yes || echo no`,
    { timeoutMs: 15000 }
  )
  return check.stdout.trim() === 'yes'
}

// ─── Convenience wrapper ──────────────────────────────────────────────────

/** Run a function with a connection to the project's server. */
export async function withServer<T>(
  creds: SshCredentials,
  fn: (client: AnyClient) => Promise<T>
): Promise<T> {
  return withConnection(creds, fn)
}

export { exec }
export type { AnyClient }
