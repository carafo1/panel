/**
 * Database user password rotation
 * ===============================
 *
 * Lets a customer reset the password of their own database user without ever
 * involving root. We run `ALTER USER USER() IDENTIFIED BY …` inside the tenant's
 * container **authenticated as that same tenant user**, which MySQL/MariaDB
 * always permits for one's own account. That matters because the container's
 * root password is generated at provision time and deliberately never stored —
 * so there is no root path available even if we wanted one.
 *
 * On success the new secret is re-encrypted into the WebsiteDatabase row (and
 * mirrored onto the Project row when it is the primary database, which is what
 * WordPress/Laravel installs read), then returned to the caller exactly once.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import { execSql } from './exec'
import { parseSqlError } from './mariadb'
import type { DbEngine } from './types'

/**
 * Alphanumeric only — the value is interpolated into a SQL string literal and
 * passed through a shell-free docker exec, and keeping it to [A-Za-z0-9]
 * removes every quoting/escaping edge case (this mirrors how the provisioner
 * generates the original password).
 */
export function generateDbPassword(len = 32): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

export interface ResetResult {
  ok: boolean
  /** Plaintext new password — returned once, never persisted unencrypted. */
  password?: string
  message: string
}

/**
 * Reset the password for a project database's user.
 * `projectId` must already have been authorised by the caller.
 */
export async function resetDatabasePassword(
  projectId: string,
  dbId: string
): Promise<ResetResult> {
  const row = await db.websiteDatabase.findFirst({ where: { id: dbId, projectId } })
  if (!row) return { ok: false, message: 'Database not found' }

  const type = (row.type || '').toLowerCase()
  if (type === 'sqlite') {
    return { ok: false, message: 'SQLite databases have no user password to reset' }
  }
  if (type === 'postgres' || type === 'postgresql') {
    return {
      ok: false,
      message: 'Password reset for PostgreSQL databases is not supported yet',
    }
  }

  const container = row.externalRef || row.host
  if (!container) return { ok: false, message: 'Database container is not provisioned' }

  let current: string
  try {
    current = decrypt(row.password)
  } catch {
    current = ''
  }
  if (!current) {
    return {
      ok: false,
      message:
        'The current password could not be decrypted, so it cannot be rotated automatically. Please contact support.',
    }
  }

  const next = generateDbPassword(32)
  const engine: DbEngine = type === 'mysql' ? 'mysql' : 'mariadb'

  // Authenticate as the tenant user and change that same account's password.
  //
  // Two forms are tried because the accepted syntax differs across engines and
  // versions: MariaDB takes `SET PASSWORD = PASSWORD(…)`, while MySQL 8 dropped
  // the PASSWORD() function and wants `ALTER USER USER() IDENTIFIED BY …`.
  // (`ALTER USER USER()` is rejected outright by MariaDB, so it cannot be the
  // only attempt.) No FLUSH PRIVILEGES: it needs RELOAD, which a tenant user
  // does not have, and a password change takes effect without it.
  const attempts = [
    `SET PASSWORD = PASSWORD('${next}')`,
    `ALTER USER USER() IDENTIFIED BY '${next}'`,
    `ALTER USER CURRENT_USER() IDENTIFIED BY '${next}'`,
  ]

  let lastError = 'The database refused the password change'
  let changed = false
  for (const sql of attempts) {
    const r = await execSql({
      engine,
      container,
      user: row.username,
      password: current,
      sql,
      timeoutMs: 20_000,
      clientArgs: ['--batch'],
    })
    if (r.ok) {
      changed = true
      break
    }
    lastError = parseSqlError(r.stderr).message || lastError
  }

  if (!changed) {
    return { ok: false, message: lastError }
  }

  // Persist only after the engine actually accepted the change, so a failure
  // can never leave the stored secret out of sync with the live account.
  await db.websiteDatabase.update({
    where: { id: row.id },
    data: { password: encrypt(next) },
  })
  if (row.isPrimary) {
    await db.project.update({
      where: { id: projectId },
      data: { databasePassword: encrypt(next) },
    })
  }

  return { ok: true, password: next, message: 'Database password reset' }
}
