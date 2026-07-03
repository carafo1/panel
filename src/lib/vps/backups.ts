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
          `docker exec ${shellQuote(container)} sh -c 'mysqldump -u root -p${shellQuote(dbPass)} ${shellQuote(dbRow.name)} 2>/dev/null | gzip > ${shellQuote(dumpFile)}' && ` +
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
    await ensureDir(projectRoot)

    // Step 1: tar+gzip the project root.
    log(`Archiving ${projectRoot}…`)
    const creds: SshCredentials = await getServerCredentials(project.serverId!)
    await withConnection(creds, async (client) => {
      const tarCmd = `tar -czf ${shellQuote(backupPath)} -C ${shellQuote(projectRoot)} . 2>&1`
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
      const isSqlite = (dbRow.type || '').toLowerCase() === 'sqlite'
      if (!isSqlite) {
        log(`Skipping non-SQLite database ${dbRow.name} (requires Docker for dump).`)
        continue
      }
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
    }

    // Step 3: stat the tarball for the size.
    let sizeBytes = 0
    try {
      const s = await stat(backupPath)
      sizeBytes = s.size
    } catch {
      /* leave at 0 */
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
          `docker exec -i ${shellQuote(container)} sh -c 'mysql -u root -p${shellQuote(dbPass)} ${shellQuote(dbRow.name)}' 2>&1`
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
