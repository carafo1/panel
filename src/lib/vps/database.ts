/**
 * Database Provisioning Module
 * ============================
 *
 * Provisions and manages per-project databases (MariaDB / MySQL / PostgreSQL)
 * running as Docker containers on the deployhub docker network. Each project
 * can have one primary database (auto-created for WordPress / Laravel) and
 * any number of additional databases the user creates later from the panel.
 *
 * Each database is a dedicated container. MySQL / MariaDB uses MYSQL_* env
 * vars and `mysqladmin ping` for health checks; PostgreSQL uses POSTGRES_*
 * env vars and `pg_isready` for health checks.
 *
 *   docker run -d --name deployhub-db-<slug> --network deployhub \
 *     -e MYSQL_ROOT_PASSWORD=<rand> \
 *     -e MYSQL_DATABASE=<wp_<slug>> \
 *     -e MYSQL_USER=<wp_<slug>> \
 *     -e MYSQL_PASSWORD=<rand> \
 *     mariadb:11
 *
 *   docker run -d --name deployhub-db-<slug> --network deployhub \
 *     -e POSTGRES_PASSWORD=<rand> \
 *     -e POSTGRES_DB=<wp_<slug>> \
 *     -e POSTGRES_USER=<wp_<slug>> \
 *     postgres:16-alpine
 *
 * The password is stored AES-256-GCM encrypted in the WebsiteDatabase row.
 * Only the host/port/name/username are returned to the UI by default; the
 * password is returned ONCE at create time, and only re-revealed via
 * `?reveal=true` from the API route.
 *
 * In DEMO MODE (no real SSH), we still create the WebsiteDatabase row with
 * realistic-looking fake credentials so the UI works end-to-end.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import {
  withConnection,
  exec,
  isServerInDemoMode,
  type SshCredentials,
} from './ssh'
import { getServerCredentials } from './provisioner'
import { isDockerAvailable, isLocalHost, execLocal, ensureDir } from './local-exec'
import path from 'path'
import fs from 'fs'

// ─── Storage paths ────────────────────────────────────────────────────────

const STORAGE_ROOT =
  process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage')
const DB_DIR = path.join(STORAGE_ROOT, 'databases')

// ─── Types ───────────────────────────────────────────────────────────────

export interface ProvisionedDatabase {
  name: string
  type: 'mysql' | 'mariadb' | 'postgres' | 'sqlite'
  host: string // docker container name on deployhub network, or localhost for sqlite
  port: number
  username: string
  /** Plaintext password — caller is responsible for encrypting at rest. */
  password: string
  externalRef: string // docker container name, or sqlite file path
}

export interface WebsiteDatabaseRow {
  id: string
  name: string
  type: string
  host: string
  port: number
  username: string
  /** Masked password (first 2 chars + ****). Caller decides whether to reveal. */
  passwordMasked: string
  /** Plaintext password, only populated when reveal=true. */
  passwordPlain?: string
  externalRef: string | null
  isPrimary: boolean
  createdAt: string
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function randomHex(len: number): string {
  return crypto.randomBytes(len).toString('hex')
}

function randomPassword(len = 32): string {
  // Alphanumeric only — avoid shell-escaping headaches.
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

function slug8(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 8)
  return slug || 'project'
}

function maskPassword(p: string): string {
  if (!p) return '****'
  if (p.length <= 2) return '****'
  return p.slice(0, 2) + '****'
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function toRow(
  row: {
    id: string
    name: string
    type: string
    host: string
    port: number
    username: string
    password: string
    externalRef: string | null
    isPrimary: boolean
    createdAt: Date
  },
  reveal: boolean
): WebsiteDatabaseRow {
  let plain = ''
  try {
    plain = decrypt(row.password)
  } catch {
    plain = ''
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    host: row.host,
    port: row.port,
    username: row.username,
    passwordMasked: maskPassword(plain),
    passwordPlain: reveal ? plain : undefined,
    externalRef: row.externalRef,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt.toISOString(),
  }
}

// ─── Provision ───────────────────────────────────────────────────────────

/**
 * Provision a new database container for a project. Generates a secure name,
 * username, password, and (in real mode) starts a MariaDB/MySQL container on
 * the deployhub docker network. Persists a WebsiteDatabase row with the
 * encrypted password and isPrimary=true (when it's the first DB for the
 * project).
 */
export async function provisionProjectDatabase(
  projectId: string,
  opts: {
    type?: 'mysql' | 'mariadb' | 'postgres' | 'postgresql'
    name?: string
    onLog?: (m: string) => void
  } = {}
): Promise<ProvisionedDatabase> {
  const log = (m: string) => opts.onLog?.(m)
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)
  if (!project.serverId || !project.server) {
    throw new Error('Project has no server assigned')
  }

  // Normalize the requested type. Accept 'postgresql' as an alias for 'postgres'.
  const rawType = (opts.type || 'mariadb').toLowerCase()
  let type: 'mysql' | 'mariadb' | 'postgres' | 'sqlite' =
    rawType === 'mysql'
      ? 'mysql'
      : rawType === 'postgres' || rawType === 'postgresql'
        ? 'postgres'
        : rawType === 'sqlite'
          ? 'sqlite'
          : 'mariadb'

  const isLocal = isLocalHost(project.server?.sshHost)
  const dockerUp = isLocal ? await isDockerAvailable() : true
  const requestedType = type
  // If the user asked for a server DB (MySQL/MariaDB/Postgres) but Docker is
  // unavailable on the local host, transparently fall back to a REAL SQLite
  // database file so the project still gets a working, queryable database.
  // The row is stored with type='sqlite' and a note in the log.
  if (isLocal && !dockerUp && type !== 'sqlite') {
    log(
      `Docker is not available on this host — provisioning a real SQLite database instead of ${type}. (In production with Docker, ${type} would be used.)`
    )
    type = 'sqlite'
  }

  const isPostgres = type === 'postgres'
  const isSqlite = type === 'sqlite'
  const image = isPostgres
    ? 'postgres:16-alpine'
    : type === 'mysql'
      ? 'mysql:8'
      : 'mariadb:11'
  const defaultPort = isPostgres ? 5432 : isSqlite ? 0 : 3306
  const slug = slug8(project.slug || project.name)
  const short = randomHex(4)
  const dbName = opts.name || (isSqlite ? `${slug}_${short}` : `wp_${slug}_${short}`)
  const dbUser = isSqlite ? 'sqlite' : `wp_${slug}_${short}`
  const dbPass = randomPassword(32)
  const rootPass = randomPassword(32)
  const containerName = `deployhub-db-${slug}-${short}`
  const sqlitePath = path.join(DB_DIR, projectId, `${dbName}.db`)
  const isPrimary = (await db.websiteDatabase.count({ where: { projectId } })) === 0

  log(`Provisioning ${type} database "${dbName}"…`)

  const demoMode = isServerInDemoMode(project.server)

  // ── SQLite path: real local file via better-sqlite3 ─────────────────
  if (isSqlite && !demoMode) {
    try {
      await ensureDir(path.dirname(sqlitePath))
      // Dynamically import better-sqlite3 (native dep) only when needed.
      const { default: Database } = await import('better-sqlite3')
      const sqlite = new Database(sqlitePath)
      // Create a metadata table so the DB isn't empty + proves it's real.
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS _apsamo_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          data TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT OR REPLACE INTO _apsamo_meta (key, value) VALUES ('created_by', 'apsamo-panel');
        INSERT OR REPLACE INTO _apsamo_meta (key, value) VALUES ('created_at', datetime('now'));
        INSERT OR REPLACE INTO _apsamo_meta (key, value) VALUES ('project_slug', '${slug}');
        INSERT OR REPLACE INTO _apsamo_meta (key, value) VALUES ('requested_type', '${requestedType}');
      `)
      sqlite.close()
      log(`SQLite database created at ${sqlitePath}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`SQLite provisioning failed: ${msg}`)
      throw err
    }
  } else if (!demoMode && !isSqlite) {
    const creds: SshCredentials = await getServerCredentials(project.serverId)
    try {
      await withConnection(creds, async (client) => {
        // Pull image first (so the run command is fast + can stream progress).
        log(`Pulling ${image}…`)
        await exec(client, `docker pull ${image}`, { timeoutMs: 300000 })

        // Run the container. Env vars differ between MySQL/MariaDB (MYSQL_*)
        // and PostgreSQL (POSTGRES_*).
        log(`Starting container ${containerName}…`)
        const envFlags = isPostgres
          ? [
              `-e POSTGRES_PASSWORD=${shellQuote(rootPass)}`,
              `-e POSTGRES_DB=${shellQuote(dbName)}`,
              `-e POSTGRES_USER=${shellQuote(dbUser)}`,
            ]
          : [
              `-e MYSQL_ROOT_PASSWORD=${shellQuote(rootPass)}`,
              `-e MYSQL_DATABASE=${shellQuote(dbName)}`,
              `-e MYSQL_USER=${shellQuote(dbUser)}`,
              `-e MYSQL_PASSWORD=${shellQuote(dbPass)}`,
            ]
        const runCmd = [
          'docker run -d',
          `--name ${containerName}`,
          '--network deployhub',
          '--restart unless-stopped',
          ...envFlags,
          image,
        ].join(' ')
        const run = await exec(client, runCmd, { timeoutMs: 60000 })
        if (run.exitCode !== 0) {
          throw new Error(`docker run failed: ${run.stderr || run.stdout}`)
        }

        // Wait for the DB to be ready. mysqladmin ping for MySQL/MariaDB,
        // pg_isready for PostgreSQL. Up to 30 retries (60s).
        log('Waiting for database to accept connections…')
        const readyCmd = isPostgres
          ? `docker exec ${containerName} pg_isready -U ${shellQuote(dbUser)} -d ${shellQuote(dbName)}`
          : `docker exec ${containerName} mysqladmin ping -h localhost --silent 2>/dev/null`
        for (let i = 0; i < 30; i++) {
          const ping = await exec(client, readyCmd, { timeoutMs: 10000 })
          const ready = isPostgres
            ? ping.exitCode === 0 && /accepting connections/i.test(ping.stdout)
            : ping.exitCode === 0 && ping.stdout.trim() === 'mysqld is alive'
          if (ready) {
            log('Database is ready.')
            break
          }
          await sleep(2000)
          if (i === 29) {
            log('WARNING: database did not become ready within 60s — continuing anyway.')
          }
        }
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`Database provisioning failed: ${msg}`)
      throw err
    }
  } else {
    const envPreview = isPostgres
      ? `-e POSTGRES_PASSWORD=*** -e POSTGRES_DB=${dbName} -e POSTGRES_USER=${dbUser}`
      : `-e MYSQL_ROOT_PASSWORD=*** -e MYSQL_DATABASE=${dbName} -e MYSQL_USER=${dbUser} -e MYSQL_PASSWORD=***`
    log(
      `[demo] Would run: docker run -d --name ${containerName} --network deployhub ${envPreview} ${image}`
    )
    await sleep(300)
    log('[demo] Simulated database container is ready.')
  }

  // Persist a WebsiteDatabase row.
  await db.websiteDatabase.create({
    data: {
      projectId,
      name: dbName,
      type,
      host: isSqlite ? 'localhost' : containerName,
      port: defaultPort,
      username: dbUser,
      password: encrypt(dbPass),
      externalRef: isSqlite ? sqlitePath : containerName,
      isPrimary,
    },
  })

  // Mirror the primary DB info onto the Project row (legacy compat for
  // WordPress/Laravel which read from project.databaseName etc.).
  if (isPrimary) {
    await db.project.update({
      where: { id: projectId },
      data: {
        databaseType: type,
        databaseName: dbName,
        databaseUser: dbUser,
        databasePassword: encrypt(dbPass),
        databaseHost: isSqlite ? 'localhost' : containerName,
        databasePort: defaultPort,
      },
    })
  }

  log(`Database "${dbName}" provisioned (${type}).`)

  return {
    name: dbName,
    type,
    host: isSqlite ? 'localhost' : containerName,
    port: defaultPort,
    username: dbUser,
    password: dbPass,
    externalRef: isSqlite ? sqlitePath : containerName,
  }
}

// ─── Drop ────────────────────────────────────────────────────────────────

/**
 * Stop + remove a database container and delete the WebsiteDatabase row.
 * In demo mode we just delete the row.
 */
export async function dropProjectDatabase(
  projectId: string,
  dbId: string
): Promise<{ ok: boolean; message: string }> {
  const row = await db.websiteDatabase.findFirst({
    where: { id: dbId, projectId },
  })
  if (!row) return { ok: false, message: 'Database not found' }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) return { ok: false, message: 'Project not found' }

  const container = row.externalRef || row.host
  const isSqlite = (row.type || '').toLowerCase() === 'sqlite'
  if (!isServerInDemoMode(project.server) && project.serverId && container && !isSqlite) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        await exec(
          client,
          `docker stop ${shellQuote(container)} 2>/dev/null; docker rm ${shellQuote(container)} 2>/dev/null; true`,
          { timeoutMs: 30000 }
        )
      })
    } catch (err) {
      // Best-effort — still delete the row so the UI updates.
      console.error('[vps-database] drop container error:', err)
    }
  } else if (!isServerInDemoMode(project.server) && isSqlite && container) {
    // SQLite: delete the real .db file from disk.
    try {
      if (fs.existsSync(container)) {
        fs.unlinkSync(container)
      }
    } catch (err) {
      console.error('[vps-database] delete sqlite file error:', err)
    }
  }

  await db.websiteDatabase.delete({ where: { id: dbId } })

  // If it was the primary, clear the project-level mirror.
  if (row.isPrimary) {
    await db.project.update({
      where: { id: projectId },
      data: {
        databaseType: 'none',
        databaseName: null,
        databaseUser: null,
        databasePassword: null,
        databaseHost: null,
        databasePort: null,
      },
    })
  }

  return { ok: true, message: 'Database dropped' }
}

// ─── List / test ─────────────────────────────────────────────────────────

/**
 * List all databases for a project. Passwords are masked by default; pass
 * `reveal=true` to include the plaintext password.
 */
export async function listProjectDatabases(
  projectId: string,
  reveal = false
): Promise<WebsiteDatabaseRow[]> {
  const rows = await db.websiteDatabase.findMany({
    where: { projectId },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  return rows.map((r) => toRow(r, reveal))
}

/**
 * Test that the database container responds to a readiness probe. For
 * MySQL / MariaDB we use `mysqladmin ping`; for PostgreSQL we use
 * `pg_isready`. Returns `{ ok, message }`. Demo mode returns a simulated
 * success.
 */
export async function testDatabaseConnection(
  projectId: string,
  dbId: string
): Promise<{ ok: boolean; message: string }> {
  const row = await db.websiteDatabase.findFirst({
    where: { id: dbId, projectId },
  })
  if (!row) return { ok: false, message: 'Database not found' }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) return { ok: false, message: 'Project not found' }

  const container = row.externalRef || row.host
  const isPostgres = (row.type || '').toLowerCase() === 'postgres'
  const isSqlite = (row.type || '').toLowerCase() === 'sqlite'

  if (isServerInDemoMode(project.server)) {
    return { ok: true, message: '[demo] Database is reachable (simulated).' }
  }

  // ── SQLite: open the file and run SELECT 1 ───────────────────────────
  if (isSqlite) {
    try {
      if (!fs.existsSync(container)) {
        return { ok: false, message: `SQLite file not found: ${container}` }
      }
      const { default: Database } = await import('better-sqlite3')
      const sqlite = new Database(container, { readonly: true })
      const row = sqlite.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined
      sqlite.close()
      if (row && row.ok === 1) {
        return { ok: true, message: `SQLite database is reachable (${container}).` }
      }
      return { ok: false, message: 'SQLite SELECT 1 returned no row' }
    } catch (err) {
      return {
        ok: false,
        message: `SQLite error: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  try {
    const creds = await getServerCredentials(project.serverId!)
    return await withConnection(creds, async (client) => {
      const cmd = isPostgres
        ? `docker exec ${shellQuote(container)} pg_isready -U ${shellQuote(row.username)} -d ${shellQuote(row.name)} 2>&1`
        : `docker exec ${shellQuote(container)} mysqladmin ping -h localhost --silent 2>&1`
      const r = await exec(client, cmd, { timeoutMs: 15000 })
      if (
        r.exitCode === 0 &&
        (isPostgres
          ? /accepting connections/i.test(r.stdout)
          : r.stdout.trim() === 'mysqld is alive')
      ) {
        return { ok: true, message: 'Database is reachable.' }
      }
      return {
        ok: false,
        message: `${isPostgres ? 'pg_isready' : 'mysqladmin ping'} failed: ${(
          r.stderr || r.stdout
        )
          .trim()
          .slice(0, 200)}`,
      }
    })
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Get a single DB (for API routes) ─────────────────────────────────────

/**
 * Look up a single database row for a project. Returns null when missing.
 */
export async function getProjectDatabase(
  projectId: string,
  dbId: string,
  reveal = false
): Promise<WebsiteDatabaseRow | null> {
  const row = await db.websiteDatabase.findFirst({
    where: { id: dbId, projectId },
  })
  if (!row) return null
  return toRow(row, reveal)
}
