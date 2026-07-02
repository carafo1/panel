/**
 * FTP Accounts Module
 * ===================
 *
 * Manages per-project FTP/SFTP accounts. Each account is stored in the
 * FtpAccount Prisma table (with AES-256-GCM encrypted password) and, when a
 * real VPS is configured, is created as a system user inside the project's
 * container via `docker exec ... adduser + chpasswd`.
 *
 * Operations:
 *   - listFtpAccounts(projectId)            — list (password masked)
 *   - createFtpAccount(projectId, opts)     — validate + create user + DB row
 *   - updateFtpAccount(accountId, patch)    — update DB row + sync system user
 *   - deleteFtpAccount(accountId)           — remove system user + delete row
 *   - getFtpAccount(accountId, reveal?)     — single row
 *
 * In DEMO MODE the SSH-side actions are simulated; the DB rows are still
 * created/updated/deleted so the UI works end-to-end.
 *
 * Username namespacing: full FTP username is `<userInput>_<projectSlug8>` to
 * avoid collisions between projects on the same host.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import {
  withConnection,
  exec,
  isServerInDemoMode,
} from './ssh'
import { getServerCredentials } from './provisioner'

// ─── Types ───────────────────────────────────────────────────────────────

export interface FtpAccountRow {
  id: string
  projectId: string
  username: string
  /** Masked password (first 2 chars + ****). */
  passwordMasked: string
  /** Plaintext password, only populated when reveal=true. */
  passwordPlain?: string
  directory: string
  readOnly: boolean
  quotaMB: number | null
  enabled: boolean
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateFtpAccountInput {
  username: string
  password: string
  directory?: string
  readOnly?: boolean
  quotaMB?: number | null
}

export interface UpdateFtpAccountPatch {
  password?: string
  directory?: string
  readOnly?: boolean
  quotaMB?: number | null
  enabled?: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function slug8(s: string): string {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 8)
  return slug || 'project'
}

function randomPassword(len = 16): string {
  const alphabet =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.randomBytes(len)
  let out = ''
  for (let i = 0; i < len; i++) {
    out += alphabet[bytes[i] % alphabet.length]
  }
  return out
}

function maskPassword(p: string): string {
  if (!p) return '****'
  if (p.length <= 2) return '****'
  return p.slice(0, 2) + '****'
}

function shellQuoteLocal(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function toRow(
  r: {
    id: string
    projectId: string
    username: string
    password: string
    directory: string
    readOnly: boolean
    quotaMB: number | null
    enabled: boolean
    lastLoginAt: Date | null
    createdAt: Date
    updatedAt: Date
  },
  reveal: boolean
): FtpAccountRow {
  let plain = ''
  try {
    plain = decrypt(r.password)
  } catch {
    plain = ''
  }
  return {
    id: r.id,
    projectId: r.projectId,
    username: r.username,
    passwordMasked: maskPassword(plain),
    passwordPlain: reveal ? plain : undefined,
    directory: r.directory,
    readOnly: r.readOnly,
    quotaMB: r.quotaMB,
    enabled: r.enabled,
    lastLoginAt: r.lastLoginAt ? r.lastLoginAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

// ─── List ────────────────────────────────────────────────────────────────

export async function listFtpAccounts(
  projectId: string
): Promise<FtpAccountRow[]> {
  const rows = await db.ftpAccount.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'asc' }],
  })
  return rows.map((r) => toRow(r, false))
}

// ─── Get ─────────────────────────────────────────────────────────────────

export async function getFtpAccount(
  projectId: string,
  accountId: string,
  reveal = false
): Promise<FtpAccountRow | null> {
  const row = await db.ftpAccount.findFirst({
    where: { id: accountId, projectId },
  })
  if (!row) return null
  return toRow(row, reveal)
}

// ─── Create ──────────────────────────────────────────────────────────────

export async function createFtpAccount(
  projectId: string,
  opts: CreateFtpAccountInput
): Promise<FtpAccountRow> {
  const usernameInput = (opts.username || '').trim()
  if (!usernameInput) throw new Error('Username is required')
  if (!/^[a-zA-Z][a-zA-Z0-9_\-]{2,31}$/.test(usernameInput)) {
    throw new Error(
      'Username must start with a letter, be 3-32 chars, and only contain letters, digits, underscore or hyphen'
    )
  }
  const password = (opts.password || '').trim()
  if (!password) throw new Error('Password is required')
  if (password.length < 6) throw new Error('Password must be at least 6 characters')
  const directory = (opts.directory || '/').trim() || '/'
  const readOnly = !!opts.readOnly
  const quotaMB =
    opts.quotaMB === null || opts.quotaMB === undefined
      ? null
      : Math.max(1, Math.floor(Number(opts.quotaMB)) || null)

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  const fullUsername = `${usernameInput}_${slug8(project.slug || project.name)}`

  // Unique check
  const existing = await db.ftpAccount.findUnique({
    where: { projectId_username: { projectId, username: fullUsername } },
  })
  if (existing) {
    throw new Error(`An FTP account "${fullUsername}" already exists`)
  }

  // Create the DB row first (with encrypted password).
  const row = await db.ftpAccount.create({
    data: {
      projectId,
      username: fullUsername,
      password: encrypt(password),
      directory,
      readOnly,
      quotaMB,
      enabled: true,
    },
  })

  // Best-effort: create system user inside the container.
  if (
    project.serverId &&
    project.containerName &&
    !isServerInDemoMode(project.server)
  ) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        // Create a non-login system user then set their password via chpasswd.
        // -D: no password (we'll set it next), -H: no home dir, -s /bin/false: no shell.
        const adduserCmd = `docker exec ${shellQuoteLocal(project.containerName!)} sh -c ${shellQuoteLocal(
          `adduser -D -H -s /bin/false ${shellQuoteLocal(fullUsername)} 2>/dev/null; echo ${shellQuoteLocal(`${fullUsername}:${password}`)} | chpasswd 2>/dev/null; true`
        )}`
        await exec(client, adduserCmd, { timeoutMs: 15000 })
      })
    } catch (err) {
      console.error('[vps-ftp] failed to create system user:', err)
    }
  } else {
    console.log(
      `[demo] ftp create — would adduser + chpasswd for ${fullUsername} in ${project.containerName || 'container'}`
    )
  }

  return toRow(row, true) // reveal the password ONCE on creation
}

// ─── Update ──────────────────────────────────────────────────────────────

export async function updateFtpAccount(
  projectId: string,
  accountId: string,
  patch: UpdateFtpAccountPatch
): Promise<FtpAccountRow> {
  const existing = await db.ftpAccount.findFirst({
    where: { id: accountId, projectId },
  })
  if (!existing) throw new Error('FTP account not found')

  const data: Record<string, unknown> = {}
  let newPassword: string | null = null
  if (patch.password !== undefined) {
    const pw = patch.password.trim()
    if (!pw) throw new Error('Password cannot be empty')
    if (pw.length < 6) throw new Error('Password must be at least 6 characters')
    data.password = encrypt(pw)
    newPassword = pw
  }
  if (patch.directory !== undefined) {
    data.directory = (patch.directory || '/').trim() || '/'
  }
  if (patch.readOnly !== undefined) {
    data.readOnly = !!patch.readOnly
  }
  if (patch.quotaMB !== undefined) {
    data.quotaMB =
      patch.quotaMB === null
        ? null
        : Math.max(1, Math.floor(Number(patch.quotaMB)) || null)
  }
  if (patch.enabled !== undefined) {
    data.enabled = !!patch.enabled
  }

  const updated = await db.ftpAccount.update({
    where: { id: accountId },
    data,
  })

  // Best-effort: update system user password if changed.
  if (newPassword) {
    const project = await db.project.findUnique({
      where: { id: projectId },
      include: { server: true },
    })
    if (
      project?.serverId &&
      project.containerName &&
      !isServerInDemoMode(project.server)
    ) {
      try {
        const creds = await getServerCredentials(project.serverId)
        await withConnection(creds, async (client) => {
          const cmd = `docker exec ${shellQuoteLocal(project.containerName!)} sh -c ${shellQuoteLocal(
            `echo ${shellQuoteLocal(`${existing.username}:${newPassword}`)} | chpasswd 2>/dev/null; true`
          )}`
          await exec(client, cmd, { timeoutMs: 15000 })
        })
      } catch (err) {
        console.error('[vps-ftp] failed to update system user password:', err)
      }
    } else {
      console.log(
        `[demo] ftp update — would chpasswd for ${existing.username}`
      )
    }
  }

  return toRow(updated, !!newPassword)
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteFtpAccount(
  projectId: string,
  accountId: string
): Promise<{ ok: boolean }> {
  const existing = await db.ftpAccount.findFirst({
    where: { id: accountId, projectId },
  })
  if (!existing) return { ok: false }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })

  if (
    project?.serverId &&
    project.containerName &&
    !isServerInDemoMode(project.server)
  ) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        const cmd = `docker exec ${shellQuoteLocal(project.containerName!)} sh -c ${shellQuoteLocal(
          `deluser ${shellQuoteLocal(existing.username)} 2>/dev/null; true`
        )}`
        await exec(client, cmd, { timeoutMs: 15000 })
      })
    } catch (err) {
      console.error('[vps-ftp] failed to delete system user:', err)
    }
  } else {
    console.log(`[demo] ftp delete — would deluser ${existing.username}`)
  }

  await db.ftpAccount.delete({ where: { id: accountId } })
  return { ok: true }
}

// ─── Random password generator (exported for the UI) ─────────────────────

export { randomPassword }
