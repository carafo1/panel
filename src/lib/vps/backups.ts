/**
 * Backups Module
 * ==============
 *
 * Creates, lists, restores, downloads, and deletes per-project backups.
 *
 * Two execution modes:
 *
 *   - LOCAL (server.sshHost === 'localhost' / 127.0.0.1 / ::1):
 *       Backups live at `<STORAGE_ROOT>/backups/<projectId>/` on the panel
 *       host. The filesystem snapshot is a real `tar -czf` of the project
 *       root. SQLite databases (which is what localhost servers actually
 *       provision — see database.ts) are backed up by copying the `.db`
 *       file (the `externalRef`) alongside the tar as
 *       `<archive>.db-<name>.sqlite`. Restore extracts the tar back over the
 *       project root and copies the SQLite file back over the live `externalRef`.
 *       Non-SQLite databases (MySQL/MariaDB/Postgres) require Docker for a
 *       real dump — when Docker is unavailable on a localhost server, those
 *       are skipped with a warning.
 *
 *   - REMOTE (real VPS over SSH + Docker):
 *       Existing Docker-based path: tar of `project.deployPath` on the VPS,
 *       `docker exec <dbcontainer> mysqldump | gzip` per database, stored at
 *       `/opt/deployhub/backups/<slug>/` on the remote VPS.
 *
 *   - DEMO (no sshHost + no creds):
 *       Synthetic WebsiteBackup row + small placeholder download so the
 *       panel's backup list looks alive in pure-demo mode.
 */
import crypto from 'crypto'
import path from 'path'
import { createReadStream } from 'fs'
import { copyFile, stat } from 'fs/promises'
import type { Readable } from 'stream'
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import {
  withConnection,
  exec,
  getFile,
  putFile,
  isServerInDemoMode,
  isLocalHost,
  type SshCredentials,
} from './ssh'
import { ensureDir } from './local-exec'
import { getServerCredentials } from './provisioner'

// ─── Per-project storage root (LOCAL mode) ──────────────────────────────

// Read on each call rather than captured at import, so a process (or a test)
// that sets STORAGE_ROOT after this module loads still gets the right place.
function storageRoot(): string {
  return process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage')
}

function PROJECT_ROOT(projectId: string): string {
  return path.join(storageRoot(), 'projects', projectId)
}

function BACKUP_DIR(projectId: string): string {
  return path.join(storageRoot(), 'backups', projectId)
}

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * A backup whose database dump failed still holds the site's files, but it
 * must not look like a full backup: it is saved as 'partial' with the
 * databases that are missing. (Dump failures used to be logged as a WARNING
 * while the row said 'completed'.)
 */
function backupOutcome(dbFailures: string[], note: string | null | undefined) {
  if (dbFailures.length === 0) return { status: 'completed' as const, note: note || null }
  const missing = `Database not included: ${dbFailures.join(', ')}`
  return { status: 'partial' as const, note: note ? `${note} — ${missing}` : missing }
}

export interface BackupResult {
  id: string
  filename: string
  sizeBytes: number
  status: 'completed' | 'partial' | 'failed'
  message: string
}

export interface BackupRow {
  id: string
  filename: string
  sizeBytes: number
  status: string
  type: string
  note: string | null
  createdAt: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function projectSlug(name: string, slug?: string | null): string {
  if (slug) return slug
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'project'
}

// ─── Create ──────────────────────────────────────────────────────────────

/**
 * Create a backup of the project's deployPath + any database containers.
 * Streams progress via `onLog`. Persists a WebsiteBackup row.
 */
export async function createBackup(
  projectId: string,
  opts: { type?: 'manual' | 'pre-deploy'; note?: string; onLog?: (m: string) => void } = {}
): Promise<BackupResult> {
  const log = (m: string) => opts.onLog?.(m)
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true, websiteDatabases: true },
  })
  if (!project) throw new Error('Project not found')

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const rand = crypto.randomBytes(4).toString('hex')
  const filename = `${timestamp}-${rand}.tar.gz`
  const backupType = opts.type || 'manual'

  log(`Creating backup "${filename}" for project ${project.slug || project.name}…`)

  const localMode = isLocalHost(project.server?.sshHost)
  if (localMode) {
    return await createLocalBackup(project, filename, backupType, opts)
  }

  // ── REMOTE / DEMO path (existing behavior) ─────────────────────────
  if (!project.deployPath) throw new Error('Project has no deployPath')

  const slug = projectSlug(project.name, project.slug)
  const backupDir = `/opt/deployhub/backups/${slug}`
  const remotePath = `${backupDir}/${filename}`

  const demoMode = project.server ? isServerInDemoMode(project.server) : true
  if (demoMode) {
    log('[demo] Simulated backup of /opt/deployhub/projects/' + slug)
    await sleep(400)
    log('[demo] Simulated mysqldump (skipped, demo mode)')
    const row = await db.websiteBackup.create({
      data: {
        projectId,
        filename,
        sizeBytes: 1024 + Math.floor(Math.random() * 1024),
        status: 'completed',
        type: backupType,
        note: opts.note || null,
      },
    })
    return {
      id: row.id,
      filename,
      sizeBytes: row.sizeBytes,
      status: 'completed',
      message: '[demo] Backup completed (simulated).',
    }
  }

  // Real remote mode (SSH + Docker).
  const dbFailures: string[] = []
  const creds: SshCredentials = await getServerCredentials(project.serverId!)
  try {
    await withConnection(creds, async (client) => {
      // Ensure the backup directory exists.
      await exec(client, `mkdir -p ${shellQuote(backupDir)}`, { timeoutMs: 10000 })

      // Step 1: tar+gzip the deployPath.
      log(`Archiving ${project.deployPath}…`)
      const tarCmd = `tar -czf ${shellQuote(remotePath)} -C ${shellQuote(project.deployPath!)} . 2>&1`
      const tar = await exec(client, tarCmd, { timeoutMs: 300000 })
      if (tar.exitCode !== 0) {
        throw new Error(`tar failed: ${(tar.stderr || tar.stdout).slice(0, 500)}`)
      }

      // Step 2: append database dumps (for each WebsiteDatabase row).
      for (const dbRow of project.websiteDatabases) {
        const container = dbRow.externalRef || dbRow.host
        if (!container) continue
        let dbPass = ''
        try {
          dbPass = decrypt(dbRow.password)
        } catch {
          log(`WARNING: could not decrypt DB password for ${dbRow.name}; skipping DB dump.`)
          dbFailures.push(dbRow.name)
          continue
        }
        log(`Dumping database ${dbRow.name} from container ${container}…`)
        // mysqldump inside the container → pipe through gzip → write a file
        // inside the SAME container's /tmp, then docker cp it out, then
        // append it into the tar. This avoids host-side shell quoting issues
        // around the password.
        const dumpFile = `/tmp/${dbRow.name}-${timestamp}.sql.gz`
        const dumpCmd =
          `docker exec ${shellQuote(container)} sh -c 'if command -v mariadb-dump >/dev/null 2>&1; then mariadb-dump -u${shellQuote(dbRow.username)} -p${shellQuote(dbPass)} --no-tablespaces --single-transaction ${shellQuote(dbRow.name)}; else mysqldump -u${shellQuote(dbRow.username)} -p${shellQuote(dbPass)} --no-tablespaces --single-transaction ${shellQuote(dbRow.name)}; fi 2>/dev/null | gzip > ${shellQuote(dumpFile)}' && ` +
          `docker cp ${shellQuote(container + ':' + dumpFile)} ${shellQuote(remotePath + '.db-' + dbRow.name + '.sql.gz')} && ` +
          `docker exec ${shellQuote(container)} rm -f ${shellQuote(dumpFile)}`
        const dump = await exec(client, dumpCmd, { timeoutMs: 120000 })
        if (dump.exitCode !== 0) {
          log(`WARNING: dump for ${dbRow.name} failed: ${(dump.stderr || dump.stdout).slice(0, 200)}`)
          dbFailures.push(dbRow.name)
          continue
        }
        // "dump | gzip" exits with gzip's status, so a failed dump still
        // "succeeds" with an empty archive. An empty gzip is ~20 bytes.
        const dumpSize = await exec(
          client,
          `stat -c %s ${shellQuote(remotePath + '.db-' + dbRow.name + '.sql.gz')} 2>/dev/null || echo 0`,
          { timeoutMs: 10000 }
        )
        if ((parseInt(dumpSize.stdout.trim(), 10) || 0) < 100) {
          log(`WARNING: dump for ${dbRow.name} is empty; the database is not in this backup.`)
          dbFailures.push(dbRow.name)
          continue
        }
        // Append the dump file into the existing tar (gzip concatenation
        // would not preserve the original tar; instead we re-tar with both).
        const combineCmd = `tar -rf ${shellQuote(remotePath + '.tmp.tar')} -C / ${shellQuote(remotePath + '.db-' + dbRow.name + '.sql.gz').replace(/^\//, '')} 2>/dev/null || true`
        // Simpler approach: just store the dump as a sibling file alongside
        // the tar. The restore step knows to look for *.db-<name>.sql.gz.
        await exec(client, combineCmd, { timeoutMs: 30000 }).catch(() => {})
      }

      // Get final size.
      const sz = await exec(client, `wc -c < ${shellQuote(remotePath)}`, { timeoutMs: 10000 })
      const sizeBytes = parseInt(sz.stdout.trim(), 10) || 0
      log(`Backup complete: ${remotePath} (${sizeBytes} bytes).`)

      // Persist the row from inside the SSH callback so we have the right size.
      await db.websiteBackup.create({
        data: {
          projectId,
          filename,
          sizeBytes,
          ...backupOutcome(dbFailures, opts.note),
          type: backupType,
        },
      })
    })

    // Apply the plan's retention now that a new backup exists. Best-effort:
    // a pruning failure must not make a successful backup look failed.
    const pruned = await pruneBackups(projectId).catch(() => ({ deleted: 0 }))
    if (pruned.deleted > 0) {
      log(`Retention: removed ${pruned.deleted} expired backup(s).`)
    }

    const remoteOutcome = backupOutcome(dbFailures, null)
    return {
      id: '',
      filename,
      sizeBytes: 0,
      status: remoteOutcome.status,
      message:
        remoteOutcome.status === 'partial'
          ? `Backup created at ${remotePath}, but without: ${dbFailures.join(', ')}`
          : `Backup created at ${remotePath}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Backup FAILED: ${msg}`)
    const row = await db.websiteBackup.create({
      data: {
        projectId,
        filename,
        sizeBytes: 0,
        status: 'failed',
        type: backupType,
        note: opts.note || null,
      },
    })
    return { id: row.id, filename, sizeBytes: 0, status: 'failed', message: msg }
  }
}

/**
 * LOCAL-mode backup: tar+gzip the project root + copy SQLite .db files.
 * The tarball is created via `exec(client, 'tar -czf …')` which routes
 * through LocalClient → real local bash. SQLite files are copied directly
 * with `fs.promises.copyFile` (no Docker required).
 */
async function createLocalBackup(
  project: {
    id: string
    name: string
    slug: string | null
    serverId: string | null
    /// Where the site's files actually are. The archive is taken from here.
    deployPath: string | null
    server: { sshHost?: string | null } | null
    websiteDatabases: Array<{
      id: string
      name: string
      type: string
      externalRef: string | null
    }>
  },
  filename: string,
  backupType: string,
  opts: { note?: string; onLog?: (m: string) => void }
): Promise<BackupResult> {
  const log = (m: string) => opts.onLog?.(m)
  const projectId = project.id
  const backupDir = BACKUP_DIR(projectId)
  const backupPath = path.join(backupDir, filename)
  const projectRoot = PROJECT_ROOT(projectId)

  try {
    await ensureDir(backupDir)

    // Archive where the site ACTUALLY lives.
    //
    // This used to archive PROJECT_ROOT(projectId) — a panel-local path — and
    // ensureDir'd it first, so tar happily archived a freshly created empty
    // directory and reported success. Every backup on a single-box install was
    // a valid, complete-looking, 105-byte file containing nothing.
    const sourceDir = project.deployPath || projectRoot
    if (!project.deployPath) {
      log(`WARNING: project has no deployPath; falling back to ${projectRoot}.`)
    }

    const creds: SshCredentials = await getServerCredentials(project.serverId!)
    await withConnection(creds, async (client) => {
      // Refuse to "back up" something that is not there, rather than
      // producing an empty archive that looks fine.
      const check = await exec(
        client,
        `test -d ${shellQuote(sourceDir)} && find ${shellQuote(sourceDir)} -type f | head -1`,
        { timeoutMs: 20000 }
      )
      if (!check.stdout.trim()) {
        throw new Error(
          `Nothing to back up: ${sourceDir} is missing or contains no files.`
        )
      }

      log(`Archiving ${sourceDir}…`)
      const tarCmd = `tar -czf ${shellQuote(backupPath)} -C ${shellQuote(sourceDir)} . 2>&1`
      const tar = await exec(client, tarCmd, { timeoutMs: 300000 })
      if (tar.exitCode !== 0) {
        throw new Error(`tar failed: ${(tar.stderr || tar.stdout).slice(0, 500)}`)
      }
    })

    const dbFailures: string[] = []
    // Step 2: copy SQLite .db files (externalRef) alongside the tar.
    // Non-SQLite DBs require Docker for a real dump — skip with a warning
    // (in practice the database.ts module auto-converts to SQLite for
    // localhost servers without Docker, so this branch is rare).
    for (const dbRow of project.websiteDatabases) {
      const type = (dbRow.type || '').toLowerCase()

      if (type === 'sqlite') {
        const srcPath = dbRow.externalRef
        if (!srcPath) {
          log(`No externalRef for ${dbRow.name}; skipping.`)
          continue
        }
        const destPath = `${backupPath}.db-${dbRow.name}.sqlite`
        try {
          await copyFile(srcPath, destPath)
          log(`Copied SQLite database ${dbRow.name} → ${path.basename(destPath)}.`)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log(`WARNING: copy SQLite ${dbRow.name} failed: ${msg}`)
        dbFailures.push(dbRow.name)
        }
        continue
      }

      // MySQL / MariaDB / PostgreSQL run in containers on this host. The old
      // code skipped them with "requires Docker for dump" on a box that has
      // Docker, so a WordPress site's entire database went unbacked-up while
      // the backup reported success.
      const container = dbRow.externalRef
      if (!container) {
        log(`WARNING: no container recorded for ${dbRow.name}; cannot dump it.`)
        dbFailures.push(dbRow.name)
        continue
      }
      const destPath = `${backupPath}.db-${dbRow.name}.sql.gz`
      const isPg = type === 'postgres' || type === 'postgresql'
      const inner = isPg
        ? `pg_dumpall -U "\${POSTGRES_USER:-postgres}"`
        : `sh -c 'DUMP=$(command -v mariadb-dump || command -v mysqldump); ` +
          `"$DUMP" -u root -p"\${MARIADB_ROOT_PASSWORD:-$MYSQL_ROOT_PASSWORD}" ` +
          `--all-databases --single-transaction --quick 2>/dev/null'`

      try {
        const credsDb: SshCredentials = await getServerCredentials(project.serverId!)
        await withConnection(credsDb, async (client) => {
          const cmd = `docker exec ${shellQuote(container)} ${inner} | gzip > ${shellQuote(destPath)}`
          const r = await exec(client, cmd, { timeoutMs: 300000 })
          if (r.exitCode !== 0) {
            throw new Error((r.stderr || r.stdout).slice(0, 300))
          }
          // An empty dump is a failed dump. Say so instead of leaving a 20-byte
          // file that looks like a database.
          const sz = await exec(client, `stat -c %s ${shellQuote(destPath)} 2>/dev/null || echo 0`, {
            timeoutMs: 15000,
          })
          const n = parseInt(sz.stdout.trim(), 10) || 0
          if (n < 100) {
            await exec(client, `rm -f ${shellQuote(destPath)}`, { timeoutMs: 10000 })
            throw new Error('dump was empty')
          }
          log(`Dumped ${type} database ${dbRow.name} (${n} bytes).`)
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`WARNING: dump of ${dbRow.name} failed: ${msg}`)
        dbFailures.push(dbRow.name)
      }
    }

    // Step 3: stat the tarball for the size.
    let sizeBytes = 0
    try {
      const s = await stat(backupPath)
      sizeBytes = s.size
    } catch {
      /* leave at 0 */
    }

    // An empty gzip is ~100 bytes. A backup that small captured nothing, and
    // recording it as "completed" is how this went unnoticed for so long.
    if (sizeBytes > 0 && sizeBytes < 200) {
      throw new Error(
        `Backup archive is only ${sizeBytes} bytes — nothing was captured from ${sourceDir}.`
      )
    }

    const outcome = backupOutcome(dbFailures, opts.note)
    const row = await db.websiteBackup.create({
      data: {
        projectId,
        filename,
        sizeBytes,
        ...outcome,
        type: backupType,
      },
    })

    log(
      outcome.status === 'partial'
        ? `Backup saved WITHOUT ${dbFailures.join(', ')}: ${backupPath} (${sizeBytes} bytes).`
        : `Backup complete: ${backupPath} (${sizeBytes} bytes).`
    )

    // Apply the plan's retention now that a new backup exists. The remote path
    // has always done this; the local path did not, so on a single-box install
    // the cap was only enforced whenever the periodic sweep happened to run.
    const pruned = await pruneBackups(projectId).catch(() => ({ deleted: 0 }))
    if (pruned.deleted > 0) {
      log(`Retention: removed ${pruned.deleted} older backup(s).`)
    }

    // Copy to the customer's own storage, if they connected any. Deliberately
    // AFTER the row exists and deliberately not awaited into the result: the
    // local backup has already succeeded, and a full Drive or a revoked token
    // must not report that success as a failure. Errors are recorded against
    // the destination so the customer sees them in the panel.
    void replicateToDestinations(projectId, row.id, filename).catch((err) => {
      log(`Offsite copy failed (the local backup is unaffected): ${String(err)}`)
    })

    return {
      id: row.id,
      filename,
      sizeBytes,
      status: outcome.status,
      message:
        outcome.status === 'partial'
          ? `Backup created, but these databases could not be included: ${dbFailures.join(', ')}`
          : `Backup created at ${backupPath}`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Backup FAILED: ${msg}`)
    const row = await db.websiteBackup.create({
      data: {
        projectId,
        filename,
        sizeBytes: 0,
        status: 'failed',
        type: backupType,
        note: opts.note || null,
      },
    })
    return { id: row.id, filename, sizeBytes: 0, status: 'failed', message: msg }
  }
}

// ─── List ────────────────────────────────────────────────────────────────

export async function listBackups(projectId: string): Promise<BackupRow[]> {
  const rows = await db.websiteBackup.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    sizeBytes: r.sizeBytes,
    status: r.status,
    type: r.type,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
  }))
}

// ─── Download ────────────────────────────────────────────────────────────

export async function downloadBackup(
  projectId: string,
  backupId: string
): Promise<{ content: Buffer; filename: string; size: number }> {
  const row = await db.websiteBackup.findFirst({
    where: { id: backupId, projectId },
  })
  if (!row) throw new Error('Backup not found')

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  const localMode = isLocalHost(project.server?.sshHost)
  const backupPath = localMode
    ? path.join(BACKUP_DIR(projectId), row.filename)
    : `/opt/deployhub/backups/${projectSlug(project.name, project.slug)}/${row.filename}`

  if (!localMode && (project.server ? isServerInDemoMode(project.server) : true)) {
    // Synthetic tar.gz-like buffer (gzip header + minimal payload).
    const body = Buffer.from(
      `APSAMO BACKUP (demo)\nproject=${project.slug}\nfile=${row.filename}\ncreated=${row.createdAt.toISOString()}\n`
    )
    return { content: body, filename: row.filename, size: body.length }
  }

  const creds = await getServerCredentials(project.serverId!)
  const content = await withConnection(creds, async (client) => {
    return await getFile(client, backupPath)
  })
  return { content, filename: row.filename, size: content.length }
}

// ─── Streamed download (for the HTTP route) ──────────────────────────────

/** A download that could not be started, with the HTTP status that fits. */
export class BackupDownloadError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502
  ) {
    super(message)
    this.name = 'BackupDownloadError'
  }
}

export interface BackupDownloadStream {
  stream: ReadableStream<Uint8Array>
  filename: string
  size: number
}

/**
 * Archive names are generated by createBackup (`<iso-timestamp>-<hex>.tar.gz`).
 * Anything else in the column — a path separator, `..`, a quote — is refused
 * rather than joined onto a directory.
 */
function isSafeBackupFilename(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) &&
    !name.includes('..') &&
    path.basename(name) === name
  )
}

/**
 * Wrap a Node readable in a web ReadableStream. Pull-based, so the file is read
 * only as fast as the client takes it (a slow download never buffers the whole
 * archive in memory); cancelling the response destroys the source.
 */
function toWebStream(source: Readable): ReadableStream<Uint8Array> {
  const it = source[Symbol.asyncIterator]() as AsyncIterator<Buffer | string>
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next()
        if (done) {
          controller.close()
          return
        }
        const chunk = typeof value === 'string' ? Buffer.from(value) : value
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
      } catch (err) {
        controller.error(err)
      }
    },
    cancel() {
      source.destroy()
    },
  })
}

/**
 * Open a backup archive for download without loading it into memory.
 *
 * The row is looked up by (backupId, projectId), and the file name comes from
 * that row only — never from the request. Callers must already have checked
 * that the user may access the project.
 *
 *   - LOCAL:  streamed from `<STORAGE_ROOT>/backups/<projectId>/<filename>`
 *             with fs.createReadStream, after confirming the resolved path is
 *             still inside that directory.
 *   - REMOTE: streamed over SFTP. The SSH connection stays open until the
 *             stream ends or the client goes away, then is closed.
 *   - DEMO:   the small synthetic placeholder, as before.
 *
 * Completed and partial (database-missing) backups are downloadable; a failed
 * backup has no archive and is refused with 409.
 */
export async function openBackupDownload(
  projectId: string,
  backupId: string
): Promise<BackupDownloadStream> {
  const row = await db.websiteBackup.findFirst({
    where: { id: backupId, projectId },
  })
  if (!row) throw new BackupDownloadError('Backup not found', 404)
  if (row.status !== 'completed' && row.status !== 'partial') {
    throw new BackupDownloadError(
      row.status === 'failed'
        ? 'This backup failed, so there is no archive to download.'
        : 'This backup is not finished yet.',
      409
    )
  }
  if (!isSafeBackupFilename(row.filename)) {
    console.error(`[backups] refusing download of backup ${row.id}: unsafe filename in DB row`)
    throw new BackupDownloadError('Backup file name is invalid', 400)
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new BackupDownloadError('Project not found', 404)

  // ── LOCAL: straight from disk ─────────────────────────────────────────
  if (isLocalHost(project.server?.sshHost)) {
    const dir = path.resolve(BACKUP_DIR(projectId))
    const filePath = path.resolve(dir, row.filename)
    if (path.dirname(filePath) !== dir) {
      throw new BackupDownloadError('Backup file name is invalid', 400)
    }
    let size: number
    try {
      const s = await stat(filePath)
      if (!s.isFile()) throw new Error('not a regular file')
      size = s.size
    } catch {
      throw new BackupDownloadError('The backup archive is no longer on disk.', 404)
    }
    return {
      stream: toWebStream(createReadStream(filePath)),
      filename: row.filename,
      size,
    }
  }

  // ── DEMO: synthetic placeholder ───────────────────────────────────────
  if (project.server ? isServerInDemoMode(project.server) : true) {
    const body = Buffer.from(
      `APSAMO BACKUP (demo)\nproject=${project.slug}\nfile=${row.filename}\ncreated=${row.createdAt.toISOString()}\n`
    )
    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(body))
          controller.close()
        },
      }),
      filename: row.filename,
      size: body.length,
    }
  }

  // ── REMOTE: stream over SFTP ──────────────────────────────────────────
  if (!project.serverId) throw new BackupDownloadError('Project has no server', 409)
  const remotePath = `/opt/deployhub/backups/${projectSlug(project.name, project.slug)}/${row.filename}`
  const creds = await getServerCredentials(project.serverId)

  // withConnection closes the connection when its callback settles, so the
  // callback hands the opened stream out through `ready` and then waits for
  // that stream to finish (or be cancelled) before returning.
  return await new Promise<BackupDownloadStream>((resolveReady, rejectReady) => {
    let handedOut = false
    withConnection(creds, async (client) => {
      const sftp = await new Promise<any>((resolve, reject) => {
        client.sftp((err, s) => (err ? reject(err) : resolve(s)))
      })
      const size = await new Promise<number>((resolve, reject) => {
        sftp.stat(remotePath, (err: Error | undefined, st: { size: number; isFile(): boolean }) => {
          if (err || !st?.isFile()) reject(new BackupDownloadError('The backup archive is no longer on the server.', 404))
          else resolve(st.size)
        })
      })
      const source: Readable = sftp.createReadStream(remotePath)
      const finished = new Promise<void>((resolve) => {
        source.once('close', () => resolve())
        source.once('end', () => resolve())
        source.once('error', () => resolve())
      })
      handedOut = true
      resolveReady({ stream: toWebStream(source), filename: row.filename, size })
      await finished
    }).catch((err) => {
      if (!handedOut) {
        rejectReady(
          err instanceof BackupDownloadError
            ? err
            : new BackupDownloadError('Could not reach the server holding this backup.', 502)
        )
        console.error('[vps-backups] remote download failed:', err instanceof Error ? err.message : err)
      } else {
        console.error('[vps-backups] remote download stream ended with an error:', err)
      }
    })
  })
}

// ─── Restore ─────────────────────────────────────────────────────────────

export async function restoreBackup(
  projectId: string,
  backupId: string,
  opts: { onLog?: (m: string) => void } = {}
): Promise<{ ok: boolean; message: string }> {
  const log = (m: string) => opts.onLog?.(m)
  const row = await db.websiteBackup.findFirst({
    where: { id: backupId, projectId },
  })
  if (!row) return { ok: false, message: 'Backup not found' }
  if (row.status !== 'completed' && row.status !== 'partial') {
    return { ok: false, message: 'Cannot restore a failed backup' }
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true, websiteDatabases: true },
  })
  if (!project) return { ok: false, message: 'Project not found' }

  log(`Restoring backup ${row.filename}…`)

  const localMode = isLocalHost(project.server?.sshHost)
  if (localMode) {
    return await restoreLocalBackup(project, row, opts)
  }

  // ── REMOTE / DEMO path (existing behavior) ─────────────────────────
  if (!project.deployPath) return { ok: false, message: 'Project has no deployPath' }

  const slug = projectSlug(project.name, project.slug)
  const remotePath = `/opt/deployhub/backups/${slug}/${row.filename}`

  if (project.server ? isServerInDemoMode(project.server) : true) {
    log('[demo] Stopping container…')
    await sleep(200)
    log('[demo] Extracting files…')
    await sleep(400)
    log('[demo] Restoring database…')
    await sleep(300)
    log('[demo] Restarting container…')
    await sleep(200)
    return { ok: true, message: '[demo] Backup restored (simulated).' }
  }

  try {
    const creds = await getServerCredentials(project.serverId!)
    await withConnection(creds, async (client) => {
      // 1. Stop the app container.
      //
      // Derived when the column is empty, the same reasoning as teardown: a
      // project whose deploy failed before persisting containerName still has
      // a container, and restoring files underneath a running app is how you
      // get a half-written site.
      const appContainer = project.containerName || `deployhub-${project.slug}`
      log(`Stopping container ${appContainer}…`)
      await exec(client, `docker stop ${shellQuote(appContainer)} 2>/dev/null; true`, {
        timeoutMs: 30000,
      })

      // 2. Clear deployPath + extract tar.
      log(`Clearing ${project.deployPath}…`)
      await exec(
        client,
        `rm -rf ${shellQuote(project.deployPath!)}/* ${shellQuote(project.deployPath!)}/.[!.]* 2>/dev/null; true`,
        { timeoutMs: 30000 }
      )
      log('Extracting backup…')
      const ex = await exec(
        client,
        `tar -xzf ${shellQuote(remotePath)} -C ${shellQuote(project.deployPath!)} 2>&1`,
        { timeoutMs: 300000 }
      )
      if (ex.exitCode !== 0) {
        throw new Error(`tar extract failed: ${(ex.stderr || ex.stdout).slice(0, 500)}`)
      }

      // 3. Restore databases (one .db-<name>.sql.gz sibling per DB).
      for (const dbRow of project.websiteDatabases) {
        const dumpPath = `/opt/deployhub/backups/${slug}/${row.filename}.db-${dbRow.name}.sql.gz`
        const container = dbRow.externalRef || dbRow.host
        if (!container) continue
        const check = await exec(client, `[ -f ${shellQuote(dumpPath)} ] && echo yes || echo no`, {
          timeoutMs: 5000,
        })
        if (check.stdout.trim() !== 'yes') {
          log(`No DB dump found for ${dbRow.name}; skipping.`)
          continue
        }
        let dbPass = ''
        try {
          dbPass = decrypt(dbRow.password)
        } catch {
          log(`Cannot decrypt password for ${dbRow.name}; skipping DB restore.`)
          continue
        }
        log(`Restoring database ${dbRow.name}…`)
        // Pipe the dump file from the host into the container's mysql client.
        const restoreCmd =
          `gunzip -c ${shellQuote(dumpPath)} | ` +
          `docker exec -i ${shellQuote(container)} sh -c 'if command -v mariadb >/dev/null 2>&1; then mariadb -u${shellQuote(dbRow.username)} -p${shellQuote(dbPass)} ${shellQuote(dbRow.name)}; else mysql -u${shellQuote(dbRow.username)} -p${shellQuote(dbPass)} ${shellQuote(dbRow.name)}; fi' 2>&1`
        const r = await exec(client, restoreCmd, { timeoutMs: 300000 })
        if (r.exitCode !== 0) {
          log(`WARNING: restore for ${dbRow.name} failed: ${(r.stderr || r.stdout).slice(0, 200)}`)
        }
      }

      // 4. Restart the app container.
      log(`Starting container ${appContainer}…`)
      await exec(client, `docker start ${shellQuote(appContainer)} 2>&1`, {
        timeoutMs: 30000,
      })
    })

    log('Restore complete.')
    return { ok: true, message: 'Backup restored successfully.' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Restore FAILED: ${msg}`)
    return { ok: false, message: msg }
  }
}

/**
 * LOCAL-mode restore: extract the tar over the project root, then copy each
 * SQLite .db file back over its live `externalRef`. No Docker required.
 *
 * Note: SQLite file restore happens while the panel process may still hold
 * a connection to the live .db file (via better-sqlite3 in database.ts).
 * better-sqlite3 opens connections per-query and closes them, so by the time
 * restore runs the file is unlocked. If a query is in-flight, the copy may
 * fail; the caller will see a clear error and can retry.
 */
async function restoreLocalBackup(
  project: {
    id: string
    serverId: string | null
    server: { sshHost?: string | null } | null
    websiteDatabases: Array<{
      id: string
      name: string
      type: string
      externalRef: string | null
    }>
  },
  row: { id: string; filename: string },
  opts: { onLog?: (m: string) => void }
): Promise<{ ok: boolean; message: string }> {
  const log = (m: string) => opts.onLog?.(m)
  const projectId = project.id
  const backupPath = path.join(BACKUP_DIR(projectId), row.filename)
  const projectRoot = PROJECT_ROOT(projectId)

  try {
    await ensureDir(projectRoot)

    const creds: SshCredentials = await getServerCredentials(project.serverId!)
    await withConnection(creds, async (client) => {
      // 1. Clear the project root (preserve the dir itself).
      log(`Clearing ${projectRoot}…`)
      await exec(
        client,
        `rm -rf ${shellQuote(projectRoot)}/* ${shellQuote(projectRoot)}/.[!.]* 2>/dev/null; true`,
        { timeoutMs: 30000 }
      )

      // 2. Extract the tar back into the project root.
      log('Extracting backup…')
      const ex = await exec(
        client,
        `tar -xzf ${shellQuote(backupPath)} -C ${shellQuote(projectRoot)} 2>&1`,
        { timeoutMs: 300000 }
      )
      if (ex.exitCode !== 0) {
        throw new Error(`tar extract failed: ${(ex.stderr || ex.stdout).slice(0, 500)}`)
      }
    })

    // 3. Restore SQLite .db files (copy over externalRef).
    for (const dbRow of project.websiteDatabases) {
      const isSqlite = (dbRow.type || '').toLowerCase() === 'sqlite'
      if (!isSqlite) {
        log(`Skipping non-SQLite database ${dbRow.name} (requires Docker for restore).`)
        continue
      }
      const livePath = dbRow.externalRef
      if (!livePath) {
        log(`No externalRef for ${dbRow.name}; skipping.`)
        continue
      }
      const srcPath = `${backupPath}.db-${dbRow.name}.sqlite`
      try {
        await ensureDir(path.dirname(livePath))
        await copyFile(srcPath, livePath)
        log(`Restored SQLite database ${dbRow.name} → ${path.basename(livePath)}.`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`WARNING: restore SQLite ${dbRow.name} failed: ${msg}`)
      }
    }

    log('Restore complete.')
    return { ok: true, message: 'Backup restored successfully.' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`Restore FAILED: ${msg}`)
    return { ok: false, message: msg }
  }
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteBackup(
  projectId: string,
  backupId: string
): Promise<{ ok: boolean; message: string }> {
  const row = await db.websiteBackup.findFirst({
    where: { id: backupId, projectId },
  })
  if (!row) return { ok: false, message: 'Backup not found' }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) return { ok: false, message: 'Project not found' }

  const localMode = isLocalHost(project.server?.sshHost)
  const backupPath = localMode
    ? path.join(BACKUP_DIR(projectId), row.filename)
    : `/opt/deployhub/backups/${projectSlug(project.name, project.slug)}/${row.filename}`

  // Delete the backup file (and any sibling .db-<name>.* files) on the host.
  // For LOCAL mode, this runs `rm -f` via LocalClient on the local fs.
  // For REMOTE mode (real VPS), it runs over SSH. For DEMO mode, skip.
  if (!localMode && (project.server ? isServerInDemoMode(project.server) : true)) {
    // Demo mode — no file to delete.
  } else if (project.serverId) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        await exec(
          client,
          // The `.*` must sit OUTSIDE the quotes. shellQuote wraps anything
          // containing a metacharacter in single quotes, so quoting the whole
          // pattern turned the glob into a literal filename: `rm -f 'x.tar.gz.*'`
          // matches a file actually called "x.tar.gz.*", which never exists.
          // The archive itself was removed (its path has no metacharacter) while
          // every sibling database dump survived — nine of them, 6.2 MB, were
          // still on disk for a project deleted days earlier.
          `rm -f ${shellQuote(backupPath)} ${shellQuote(backupPath)}.* 2>/dev/null; true`,
          { timeoutMs: 15000 }
        )
      })
    } catch (err) {
      console.error('[vps-backups] delete file error:', err)
    }
  }

  // Remove the offsite copy as well, so "delete" means deleted rather than
  // "hidden from this list". Done BEFORE the row goes, because the row is
  // where the filename lives.
  await removeFromDestinations(projectId, row.filename).catch((err) => {
    console.error(`[backups] could not remove ${row.filename} from Drive:`, err)
  })

  await db.websiteBackup.delete({ where: { id: backupId } })
  return { ok: true, message: 'Backup deleted' }
}

/**
 * Apply the plan's backup retention to one project.
 *
 * `backupRetentionDays` (7 / 14 / 30 across the catalogue) and `maxBackups`
 * were stored on every plan and read by nothing: backups accumulated forever,
 * so retention was a line on the pricing page rather than a behaviour, and disk
 * on the host grew without bound.
 *
 * Two rules, applied in order:
 *   1. Delete anything older than the plan's retention window.
 *   2. If more than `maxBackups` remain, delete the oldest until the count fits.
 *
 * When the plan sets neither (or there is no active subscription), a default
 * applies instead of keeping everything forever: the newest
 * DEFAULT_KEEP_PRE_DEPLOY pre-deploy backups and the newest DEFAULT_KEEP_MANUAL
 * of every other type (manual, scheduled). On a single small VPS an unbounded
 * backup directory is how the disk fills.
 *
 * Never deleted, whatever the rules say:
 *   - the newest backup (a customer whose plan lapsed can still restore),
 *   - the newest COMPLETED backup, so the last full restore point — and so
 *     the only completed one — always survives a run of partial/failed rows,
 *   - a backup still pending or running.
 * Deletion goes through deleteBackup(), so the archive on disk is removed, not
 * just the row.
 */
export const DEFAULT_KEEP_MANUAL = 10
export const DEFAULT_KEEP_PRE_DEPLOY = 5

export async function pruneBackups(
  projectId: string
): Promise<{
  deleted: number
  retainedDays: number | null
  maxKept: number | null
  policy: 'plan' | 'default' | 'none'
}> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project) return { deleted: 0, retainedDays: null, maxKept: null, policy: 'none' }

  const sub = await db.subscription.findFirst({
    where: {
      userId: project.userId,
      status: { in: ['active', 'trialing', 'past_due'] },
    },
    orderBy: { createdAt: 'desc' },
    include: { plan: true },
  })

  const retentionDays = sub?.plan?.backupRetentionDays ?? null
  const maxBackups = sub?.plan?.maxBackups ?? null
  const policy: 'plan' | 'default' = !retentionDays && !maxBackups ? 'default' : 'plan'

  // Newest first, so index 0 is the one we always keep. The id is the
  // tie-breaker so rows created in the same millisecond order the same way
  // on every run.
  const rows = await db.websiteBackup.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, createdAt: true, status: true, type: true, filename: true },
  })
  if (rows.length <= 1) {
    return { deleted: 0, retainedDays: retentionDays, maxKept: maxBackups, policy }
  }

  const protectedIds = new Set<string>([rows[0].id])
  const newestCompleted = rows.find((r) => r.status === 'completed')
  if (newestCompleted) protectedIds.add(newestCompleted.id)
  for (const r of rows) {
    if (r.status === 'pending' || r.status === 'running') protectedIds.add(r.id)
  }

  const doomed = new Set<string>()

  if (policy === 'plan') {
    if (retentionDays && retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
      for (const r of rows.slice(1)) {
        if (new Date(r.createdAt).getTime() < cutoff) doomed.add(r.id)
      }
    }

    if (maxBackups && maxBackups > 0) {
      const survivors = rows.filter((r) => !doomed.has(r.id))
      for (const r of survivors.slice(maxBackups)) doomed.add(r.id)
    }
  } else {
    // Default: count per bucket, newest first; everything past the limit goes.
    const preDeploy = rows.filter((r) => r.type === 'pre-deploy')
    const others = rows.filter((r) => r.type !== 'pre-deploy')
    for (const r of preDeploy.slice(DEFAULT_KEEP_PRE_DEPLOY)) doomed.add(r.id)
    for (const r of others.slice(DEFAULT_KEEP_MANUAL)) doomed.add(r.id)
  }

  for (const id of protectedIds) doomed.delete(id)
  if (doomed.size === 0) {
    return { deleted: 0, retainedDays: retentionDays, maxKept: maxBackups, policy }
  }

  let deleted = 0
  const removed: string[] = []
  for (const id of doomed) {
    const res = await deleteBackup(projectId, id).catch(() => ({ ok: false, message: '' }))
    if (res.ok) {
      deleted++
      const r = rows.find((x) => x.id === id)
      if (r) removed.push(`${r.filename} (${r.type}, ${r.status})`)
    } else {
      console.error(`[backups] retention could not delete backup ${id} of project ${projectId}`)
    }
  }

  if (deleted > 0) {
    const rule =
      policy === 'default'
        ? `default: keep ${DEFAULT_KEEP_MANUAL} manual + ${DEFAULT_KEEP_PRE_DEPLOY} pre-deploy`
        : `plan: ${retentionDays ? `${retentionDays} days` : 'no age limit'}, ${maxBackups ? `max ${maxBackups}` : 'no count limit'}`
    console.log(
      `[backups] retention (${rule}) pruned ${deleted} backup(s) of project ${projectId}: ${removed.join(', ')}`
    )
  }

  return { deleted, retainedDays: retentionDays, maxKept: maxBackups, policy }
}

/**
 * Prune every project that has backups. Driven by the worker sweep so retention
 * is applied continuously, not only when someone happens to take a new backup.
 */
export async function pruneAllBackups(): Promise<{ projects: number; deleted: number }> {
  const grouped = await db.websiteBackup.groupBy({
    by: ['projectId'],
    _count: { _all: true },
  })

  let deleted = 0
  for (const g of grouped) {
    const res = await pruneBackups(g.projectId).catch(() => ({ deleted: 0 }))
    deleted += res.deleted
  }
  return { projects: grouped.length, deleted }
}


/**
 * Copy a finished backup to whatever external destinations the owner has
 * connected.
 *
 * Reads the archive back through downloadBackup rather than re-reading the
 * remote path directly, so it works identically for local-mode and remote
 * servers and cannot drift from wherever backups actually live.
 */
async function replicateToDestinations(
  projectId: string,
  backupId: string,
  filename: string
): Promise<void> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project) return

  const dests = await db.backupDestination.findMany({
    where: { userId: project.userId, enabled: true },
    select: { id: true, provider: true },
  })
  if (dests.length === 0) return

  // Only pay the download cost if somewhere actually wants it.
  const { content } = await downloadBackup(projectId, backupId)

  for (const dest of dests) {
    if (dest.provider !== 'google_drive') continue
    const { uploadBackup } = await import('@/lib/google-drive')
    const res = await uploadBackup(dest.id, filename, content)
    if (!res.ok) {
      console.error(`[backups] Drive upload failed for ${filename}: ${res.error}`)
    }
  }
}


/**
 * Delete a backup from every external destination its owner has connected.
 *
 * Matched by filename: uploadBackup stores the archive under the same name the
 * local copy has, so the two stay addressable without another column.
 *
 * Best-effort throughout. A revoked token or a Drive outage must not prevent
 * someone deleting their own backup, and must not leave a row behind that the
 * UI still lists.
 */
async function removeFromDestinations(projectId: string, filename: string): Promise<void> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project) return

  const dests = await db.backupDestination.findMany({
    where: { userId: project.userId, enabled: true },
    select: { id: true, provider: true },
  })
  if (dests.length === 0) return

  const { listFiles, deleteFile } = await import('@/lib/google-drive')
  for (const dest of dests) {
    if (dest.provider !== 'google_drive') continue
    const listing = await listFiles(dest.id)
    if (!listing.ok) continue
    // Both the plain name and the .enc form, since the platform path encrypts
    // before upload and the per-site path does not.
    for (const f of listing.files) {
      if (f.name === filename || f.name === `${filename}.enc`) {
        await deleteFile(dest.id, f.id)
      }
    }
  }
}
