/**
 * FTP Accounts Module
 * ===================
 *
 * Manages per-project FTP/SFTP accounts. Each account is stored in the
 * FtpAccount Prisma table (with AES-256-GCM encrypted password) and, when a
 * real VPS is configured, is created as a system user inside the project's
 * container via `docker exec`. The user-management commands differ between
 * base images (Debian/Ubuntu ship `useradd`/`userdel`; Alpine/BusyBox ship
 * `adduser -D`/`deluser`), so the scripts below detect which exist. A failure
 * inside the container is reported to the caller — the panel never shows an
 * account as created (or deleted) when the server did not actually do it.
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

/** An FTP failure whose message is safe to show the customer. */
export class FtpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 502 = 400
  ) {
    super(message)
    this.name = 'FtpError'
  }
}

// ─── Container scripts (portable across Debian/Ubuntu/RHEL and Alpine) ──

/**
 * Create the system user if it does not exist, then set its password.
 * Exit codes: 0 ok, 3 no user-management tool, 4 no chpasswd, other = tool error.
 */
export function buildFtpCreateUserScript(username: string, password: string): string {
  const u = shellQuoteLocal(username)
  return [
    'set -e',
    `if ! id ${u} >/dev/null 2>&1; then`,
    '  if command -v useradd >/dev/null 2>&1; then',
    `    useradd -M -s /bin/false ${u}`, // Debian / Ubuntu / RHEL (shadow-utils)
    '  elif command -v adduser >/dev/null 2>&1; then',
    `    adduser -D -H -s /bin/false ${u}`, // Alpine / BusyBox
    '  else',
    "    echo 'neither useradd nor adduser is available in the container' >&2; exit 3",
    '  fi',
    'fi',
    buildFtpSetPasswordScript(username, password),
  ].join('\n')
}

/** Set an existing system user's password. */
export function buildFtpSetPasswordScript(username: string, password: string): string {
  return [
    "command -v chpasswd >/dev/null 2>&1 || { echo 'chpasswd is not available in the container' >&2; exit 4; }",
    `printf '%s\\n' ${shellQuoteLocal(`${username}:${password}`)} | chpasswd`,
  ].join('\n')
}

/** Remove the system user; succeeds if it is already gone. */
export function buildFtpDeleteUserScript(username: string): string {
  const u = shellQuoteLocal(username)
  return [
    `id ${u} >/dev/null 2>&1 || exit 0`,
    `if command -v userdel >/dev/null 2>&1; then userdel ${u}`,
    `elif command -v deluser >/dev/null 2>&1; then deluser ${u}`,
    "else echo 'neither userdel nor deluser is available in the container' >&2; exit 3; fi",
  ].join('\n')
}

/**
 * Run a script inside the project's container. Throws FtpError on any
 * failure, with the password scrubbed from whatever the container printed.
 */
async function runInContainer(
  serverId: string,
  containerName: string,
  script: string,
  what: string,
  secret?: string
): Promise<void> {
  const cmd = `docker exec ${shellQuoteLocal(containerName)} sh -c ${shellQuoteLocal(script)}`
  let result: { exitCode: number | null; stderr: string; stdout: string }
  try {
    const creds = await getServerCredentials(serverId)
    result = await withConnection(creds, (client) => exec(client, cmd, { timeoutMs: 15000 }))
  } catch (err) {
    console.error(`[vps-ftp] ${what}: could not reach the server:`, (err as Error).message)
    throw new FtpError(`Could not ${what}: the server is unreachable. Please try again.`, 502)
  }
  if (result.exitCode === 0) return

  let detail = (result.stderr || result.stdout || '').trim().split('\n').pop() || `exit code ${result.exitCode}`
  if (secret) detail = detail.split(secret).join('***')
  console.error(`[vps-ftp] ${what} failed in ${containerName}: ${detail}`)
  throw new FtpError(`Could not ${what} on the server: ${detail.slice(0, 200)}`, 502)
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
  if (!usernameInput) throw new FtpError('Username is required')
  if (!/^[a-zA-Z][a-zA-Z0-9_\-]{2,31}$/.test(usernameInput)) {
    throw new FtpError(
      'Username must start with a letter, be 3-32 chars, and only contain letters, digits, underscore or hyphen'
    )
  }
  const password = (opts.password || '').trim()
  if (!password) throw new FtpError('Password is required')
  if (password.length < 6) throw new FtpError('Password must be at least 6 characters')
  const directory = (opts.directory || '/').trim() || '/'
  const readOnly = !!opts.readOnly
  const parsedQuota = Number(opts.quotaMB)
  const quotaMB =
    opts.quotaMB === null ||
    opts.quotaMB === undefined ||
    !Number.isFinite(parsedQuota)
      ? null
      : Math.max(1, Math.floor(parsedQuota))

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new FtpError('Project not found', 404)

  const fullUsername = `${usernameInput}_${slug8(project.slug || project.name)}`

  // Unique check
  const existing = await db.ftpAccount.findUnique({
    where: { projectId_username: { projectId, username: fullUsername } },
  })
  if (existing) {
    throw new FtpError(`An FTP account "${fullUsername}" already exists`, 409)
  }

  // Create the system user FIRST: if the container refuses, no DB row is
  // written and the customer is told, instead of seeing an account that
  // cannot log in.
  if (
    project.serverId &&
    project.containerName &&
    !isServerInDemoMode(project.server)
  ) {
    await runInContainer(
      project.serverId,
      project.containerName,
      buildFtpCreateUserScript(fullUsername, password),
      'create the FTP user',
      password
    )
  } else {
    console.log(
      `[demo] ftp create — would create system user ${fullUsername} in ${project.containerName || 'container'}`
    )
  }

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
  if (!existing) throw new FtpError('FTP account not found', 404)

  const data: Record<string, unknown> = {}
  let newPassword: string | null = null
  if (patch.password !== undefined) {
    const pw = patch.password.trim()
    if (!pw) throw new FtpError('Password cannot be empty')
    if (pw.length < 6) throw new FtpError('Password must be at least 6 characters')
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
    const parsed = Number(patch.quotaMB)
    data.quotaMB =
      patch.quotaMB === null || !Number.isFinite(parsed)
        ? null
        : Math.max(1, Math.floor(parsed))
  }
  if (patch.enabled !== undefined) {
    data.enabled = !!patch.enabled
  }

  // Change the password on the server FIRST, so the stored password never
  // disagrees with the one that actually works.
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
      await runInContainer(
        project.serverId,
        project.containerName,
        buildFtpSetPasswordScript(existing.username, newPassword),
        'change the FTP password',
        newPassword
      )
    } else {
      console.log(`[demo] ftp update — would set the password for ${existing.username}`)
    }
  }

  const updated = await db.ftpAccount.update({
    where: { id: accountId },
    data,
  })

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
    // A user left behind in the container could still log in over FTP, so a
    // failure here keeps the row (and tells the customer) rather than hiding
    // a live account. The one safe exception: the container no longer exists,
    // so nothing can log in to it.
    try {
      await runInContainer(
        project.serverId,
        project.containerName,
        buildFtpDeleteUserScript(existing.username),
        'remove the FTP user'
      )
    } catch (err) {
      if (!(err instanceof FtpError && /No such container/i.test(err.message))) throw err
      console.warn(`[vps-ftp] container ${project.containerName} is gone; deleting the account record only`)
    }
  } else {
    console.log(`[demo] ftp delete — would remove system user ${existing.username}`)
  }

  await db.ftpAccount.delete({ where: { id: accountId } })
  return { ok: true }
}

// ─── Random password generator (exported for the UI) ─────────────────────

export { randomPassword }
