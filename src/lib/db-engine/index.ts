/**
 * Database Studio — access guard + engine factory
 * ================================================
 *
 * `resolveTenantDatabase` is the single security choke point for the whole
 * module: it authenticates the request, enforces project ownership (a non-admin
 * may only reach their OWN project's databases), loads the WebsiteDatabase row,
 * decrypts the tenant's non-root credentials, and returns a ready connection.
 * Every Studio API route MUST go through it before touching a database.
 */
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { decrypt } from '@/lib/encryption'
import { isLocalHost } from '@/lib/vps/local-exec'
import type { DbEngine, TenantDbConnection } from './types'

export * from './types'

/** An error carrying the HTTP status a route should respond with. */
export class DbAccessError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'DbAccessError'
    this.status = status
  }
}

export function normalizeEngine(type: string): DbEngine | 'sqlite' {
  const t = (type || '').toLowerCase()
  if (t === 'mysql') return 'mysql'
  if (t === 'postgres' || t === 'postgresql') return 'postgres'
  if (t === 'sqlite') return 'sqlite'
  return 'mariadb'
}

export interface ResolvedTenantDb {
  conn: TenantDbConnection
  auth: { userId: string; email: string; role: string }
  project: { id: string; name: string; slug: string | null; userId: string }
}

/**
 * Authenticate + authorize + resolve a single tenant database into a usable
 * connection. Throws {@link DbAccessError} with the right HTTP status on any
 * failure — routes should catch it and map `.status`/`.message` to the response.
 */
export async function resolveTenantDatabase(
  request: Request,
  projectId: string,
  dbId: string
): Promise<ResolvedTenantDb> {
  const auth = await authenticateRequest(request)
  if (!auth) throw new DbAccessError('Invalid or expired token', 401)

  // Ownership: admins may reach any project; everyone else only their own.
  const project = await db.project.findFirst({
    where: isAdmin(auth.role)
      ? { id: projectId }
      : { id: projectId, userId: auth.userId },
    include: { server: true },
  })
  if (!project) throw new DbAccessError('Project not found', 404)

  const row = await db.websiteDatabase.findFirst({
    where: { id: dbId, projectId },
  })
  if (!row) throw new DbAccessError('Database not found', 404)

  const engine = normalizeEngine(row.type)
  if (engine === 'sqlite') {
    throw new DbAccessError('SQLite databases are not managed in Database Studio', 400)
  }
  // MySQL/MariaDB and PostgreSQL are both supported; the engine-specific work
  // is behind `driverFor()` (see ./driver).

  // The docker-exec transport runs on THIS host. Databases whose project is
  // pinned to a remote server aren't reachable yet.
  const local = isLocalHost(project.server?.sshHost ?? null)
  if (!local) {
    throw new DbAccessError(
      'Database Studio currently supports databases hosted on this server only',
      400
    )
  }

  const container = row.externalRef || row.host
  if (!container) throw new DbAccessError('Database container is not provisioned', 409)

  let password: string
  try {
    password = decrypt(row.password)
  } catch {
    throw new DbAccessError('Stored database credentials could not be decrypted', 500)
  }

  const conn: TenantDbConnection = {
    id: row.id,
    engine,
    container,
    host: row.host,
    port: row.port,
    database: row.name,
    user: row.username,
    password,
    local,
  }

  return {
    conn,
    auth,
    project: {
      id: project.id,
      name: project.name,
      slug: project.slug ?? null,
      userId: project.userId,
    },
  }
}
