/**
 * SFTP access for websites (see lib/vps/sftp.ts for what runs on the server)
 * and the account SSH keys it uses.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { CONNECT_HOSTNAME } from '@/lib/brand-config'
import { isAdmin } from '@/lib/security'
import { parsePublicKey, SshKeyError } from '@/lib/ssh-keys'
import { getServerCredentials } from '@/lib/vps/provisioner'
import { withConnection, exec, isServerInDemoMode, shellQuote } from '@/lib/vps/ssh'
import { hostSetupScript, grantScript, revokeScript, sftpUsername } from '@/lib/vps/sftp'

export class SftpError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

const MAX_KEYS = 20
const SFTP_HOST = () => process.env.SFTP_HOSTNAME || CONNECT_HOSTNAME
const SFTP_PORT = () => Number(process.env.SFTP_PORT) || 22

// ── Account keys ──────────────────────────────────────────────────────

export async function listKeys(userId: string) {
  return db.sshKey.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, fingerprint: true, publicKey: true, createdAt: true },
  }).then((rows) => rows.map((r) => ({ ...r, type: r.publicKey.split(' ')[0], publicKey: undefined })))
}

export async function addKey(userId: string, input: { name?: unknown; publicKey?: unknown }) {
  let parsed
  try {
    parsed = parsePublicKey(typeof input.publicKey === 'string' ? input.publicKey : '')
  } catch (e) {
    if (e instanceof SshKeyError) throw new SftpError(e.message)
    throw e
  }
  const name = (typeof input.name === 'string' && input.name.trim() ? input.name.trim() : parsed.comment || 'SSH key').slice(0, 60)
  if ((await db.sshKey.count({ where: { userId } })) >= MAX_KEYS) throw new SftpError(`You can add up to ${MAX_KEYS} keys.`)
  if (await db.sshKey.findFirst({ where: { userId, fingerprint: parsed.fingerprint }, select: { id: true } })) {
    throw new SftpError('That key is already on your account.', 409)
  }
  const key = await db.sshKey.create({ data: { userId, name, publicKey: parsed.normalized, fingerprint: parsed.fingerprint } })
  return { id: key.id, name: key.name, fingerprint: key.fingerprint, type: parsed.type, createdAt: key.createdAt }
}

/** Remove a key and take it off every site it was granted to. */
export async function deleteKey(userId: string, keyId: string) {
  const key = await db.sshKey.findFirst({ where: { id: keyId, userId } })
  if (!key) throw new SftpError('Key not found.', 404)
  const grants = await db.sftpAccess.findMany({ where: { keyIds: { contains: keyId } } })
  await db.sshKey.delete({ where: { id: keyId } })
  const warnings: string[] = []
  for (const g of grants) {
    const ids = parseIds(g.keyIds).filter((k) => k !== keyId)
    try {
      await applyGrant(g.projectId, g.username, ids)
      await db.sftpAccess.update({ where: { id: g.id }, data: { keyIds: JSON.stringify(ids), status: 'active', lastError: null } })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await db.sftpAccess.update({ where: { id: g.id }, data: { keyIds: JSON.stringify(ids), status: 'failed', lastError: msg } })
      warnings.push(msg)
    }
  }
  return { ok: true, warnings }
}

// ── Site access ───────────────────────────────────────────────────────

function parseIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}

export async function planAllowsSsh(ownerId: string, role?: string) {
  if (role && isAdmin(role)) return { allowed: true, planName: null as string | null }
  const sub = await db.subscription.findFirst({
    where: { userId: ownerId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: { select: { name: true, sshAccess: true } } },
  })
  if (!sub?.plan) return { allowed: true, planName: null }
  return { allowed: sub.plan.sshAccess, planName: sub.plan.name }
}

async function loadSite(projectId: string) {
  const p = await db.project.findUnique({ where: { id: projectId }, include: { server: true, sftpAccess: true } })
  if (!p) throw new SftpError('Website not found.', 404)
  return p
}

async function runOnServer(project: Awaited<ReturnType<typeof loadSite>>, script: string) {
  if (!project.server || isServerInDemoMode(project.server)) return // simulated outside production
  const creds = await getServerCredentials(project.serverId!)
  const r = await withConnection(creds, (c) => exec(c, `sh -c ${shellQuote(script)}`, { timeoutMs: 300_000 }))
  if (r.exitCode !== 0) {
    const out = `${r.stderr || ''}\n${r.stdout || ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)
    throw new Error(out || `exit code ${r.exitCode}`)
  }
}

async function applyGrant(projectId: string, username: string, keyIds: string[]) {
  const p = await loadSite(projectId)
  if (!p.deployPath && p.server && !isServerInDemoMode(p.server)) throw new SftpError('The website has not been deployed yet.', 409)
  const keys = keyIds.length ? await db.sshKey.findMany({ where: { id: { in: keyIds } }, select: { publicKey: true } }) : []
  await runOnServer(p, hostSetupScript())
  await runOnServer(p, grantScript(username, p.deployPath || `/opt/deployhub/projects/${p.slug}`, keys.map((k) => k.publicKey)))
}

export async function sftpInfo(projectId: string, viewer: { userId: string; role?: string }) {
  const p = await loadSite(projectId)
  const plan = await planAllowsSsh(p.userId, viewer.role)
  const a = p.sftpAccess
  const granted = a ? await db.sshKey.findMany({ where: { id: { in: parseIds(a.keyIds) } }, select: { id: true, name: true, fingerprint: true, userId: true } }) : []
  return {
    planAllows: plan.allowed,
    planName: plan.planName,
    enabled: !!a,
    status: a?.status ?? null,
    lastError: a?.lastError ?? null,
    connection: a ? { host: SFTP_HOST(), port: SFTP_PORT(), username: a.username, directory: '/site' } : null,
    keys: granted.map((k) => ({ id: k.id, name: k.name, fingerprint: k.fingerprint, mine: k.userId === viewer.userId })),
    myKeys: await listKeys(viewer.userId),
  }
}

/** Turn SFTP on (or change which keys may log in). */
export async function setSftpKeys(projectId: string, actor: { userId: string; role?: string }, input: { keyIds?: unknown }) {
  const p = await loadSite(projectId)
  if (p.status === 'suspended') throw new SftpError('This website is suspended.', 402)
  const plan = await planAllowsSsh(p.userId, actor.role)
  if (!plan.allowed) throw new SftpError(`SSH/SFTP access is not included in the ${plan.planName} plan.`, 403)
  const requested = Array.isArray(input.keyIds) ? [...new Set(input.keyIds.filter((x): x is string => typeof x === 'string'))] : []
  if (requested.length === 0) throw new SftpError('Choose at least one SSH key. Add keys in Settings → Security.')
  if (requested.length > MAX_KEYS) throw new SftpError(`At most ${MAX_KEYS} keys per website.`)

  // You may grant your own keys, and keep keys someone else already granted.
  const already = p.sftpAccess ? parseIds(p.sftpAccess.keyIds) : []
  const rows = await db.sshKey.findMany({ where: { id: { in: requested } }, select: { id: true, userId: true } })
  for (const id of requested) {
    const row = rows.find((r) => r.id === id)
    if (!row || (row.userId !== actor.userId && !already.includes(id))) throw new SftpError('One of the keys was not found on your account.', 404)
  }

  const username = p.sftpAccess?.username ?? sftpUsername(p.slug, crypto.randomBytes(2).toString('hex'))
  try {
    await applyGrant(projectId, username, requested)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (p.sftpAccess) await db.sftpAccess.update({ where: { id: p.sftpAccess.id }, data: { status: 'failed', lastError: msg } })
    if (e instanceof SftpError) throw e
    throw new SftpError(`The server could not set up SFTP: ${msg}`, 502)
  }
  const data = { keyIds: JSON.stringify(requested), status: 'active', lastError: null }
  await db.sftpAccess.upsert({
    where: { projectId },
    create: { projectId, username, createdById: actor.userId, ...data },
    update: data,
  })
  return sftpInfo(projectId, actor)
}

export async function disableSftp(projectId: string) {
  const p = await loadSite(projectId)
  if (!p.sftpAccess) throw new SftpError('SFTP is not enabled for this website.', 404)
  try {
    await runOnServer(p, revokeScript(p.sftpAccess.username, p.deployPath))
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await db.sftpAccess.update({ where: { id: p.sftpAccess.id }, data: { status: 'failed', lastError: msg } })
    throw new SftpError(`The server could not remove SFTP access: ${msg}`, 502)
  }
  await db.sftpAccess.delete({ where: { id: p.sftpAccess.id } })
  return { ok: true }
}

/** For teardown: revoke without throwing (the site is going away). */
export async function revokeSftpQuietly(projectId: string): Promise<string | null> {
  const p = await db.project.findUnique({ where: { id: projectId }, include: { server: true, sftpAccess: true } })
  if (!p?.sftpAccess) return null
  try {
    await runOnServer(p, revokeScript(p.sftpAccess.username, p.deployPath))
    return null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}
