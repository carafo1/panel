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
import { copyFile, stat } from 'fs/promises'
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

const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage')

function PROJECT_ROOT(projectId: string): string {
  return path.join(STORAGE_ROOT, 'projects', projectId)
}

function BACKUP_DIR(projectId: string): string {
  return path.join(STORAGE_ROOT, 'backups', projectId)
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface BackupResult {
  id: string
  filename: string
  sizeBytes: number
  status: 'completed' | 'failed'
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
          status: 'completed',
          type: backupType,
          note: opts.note || null,
        },
      })
    })

    // Apply the plan's retention now that a new backup exists. Best-effort:
    // a pruning failure must not make a successful backup look failed.
    const pruned = await pruneBackups(projectId).catch(() => ({ deleted: 0 }))
    if (pruned.deleted > 0) {
      log(`Retention: removed ${pruned.deleted} expired backup(s).`)
    }

    return {
      id: '',
      filename,
      sizeBytes: 0,
      status: 'completed',
      message: `Backup created at ${remotePath}`,
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

    const row = await db.websiteBackup.create({
      data: {
        projectId,
        filename,
        sizeBytes,
        status: 'completed',
        type: backupType,
        note: opts.note || null,
      },
    })

    log(`Backup complete: ${backupPath} (${sizeBytes} bytes).`)

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
      status: 'completed',
      message: `Backup created at ${backupPath}`,
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
  if (row.status !== 'completed') {
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
      if (project.containerName) {
        log(`Stopping container ${project.containerName}…`)
        await exec(client, `docker stop ${shellQuote(project.containerName)} 2>/dev/null; true`, {
          timeoutMs: 30000,
        })
      }

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
      if (project.containerName) {
        log(`Starting container ${project.containerName}…`)
        await exec(client, `docker start ${shellQuote(project.containerName)} 2>&1`, {
          timeoutMs: 30000,
        })
      }
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
          `rm -f ${shellQuote(backupPath)} ${shellQuote(backupPath + '.*')} 2>/dev/null; true`,
          { timeoutMs: 15000 }
        )
      })
    } catch (err) {
      console.error('[vps-backups] delete file error:', err)
    }
  }

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
 * The newest backup is never deleted, whatever the rules say — a customer whose
 * plan lapsed should still be able to restore something. Deletion goes through
 * deleteBackup(), so the archive on disk is removed, not just the row.
 */
export async function pruneBackups(
  projectId: string
): Promise<{ deleted: number; retainedDays: number | null; maxKept: number | null }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { userId: true },
  })
  if (!project) return { deleted: 0, retainedDays: null, maxKept: null }

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
  if (!retentionDays && !maxBackups) {
    return { deleted: 0, retainedDays: null, maxKept: null }
  }

  // Newest first, so index 0 is the one we always keep.
  const rows = await db.websiteBackup.findMany({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  })
  if (rows.length <= 1) {
    return { deleted: 0, retainedDays: retentionDays, maxKept: maxBackups }
  }

  const doomed = new Set<string>()

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

  let deleted = 0
  for (const id of doomed) {
    const res = await deleteBackup(projectId, id).catch(() => ({ ok: false, message: '' }))
    if (res.ok) deleted++
  }

  return { deleted, retainedDays: retentionDays, maxKept: maxBackups }
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
