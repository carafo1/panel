/** SSH keys and per-website SFTP access. */
import { describe, it, expect } from 'bun:test'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { parsePublicKey } from '@/lib/ssh-keys'
import { grantScript, revokeScript, hostSetupScript, sftpUsername } from '@/lib/vps/sftp'
import * as keysRoute from '@/app/api/user/ssh-keys/route'
import * as keyRoute from '@/app/api/user/ssh-keys/[id]/route'
import * as sftpRoute from '@/app/api/hosting/[id]/sftp/route'
import { makeUser, makeProject, makePlan, authed, params } from './helpers'

const sshString = (b: Buffer | string) => {
  const v = Buffer.isBuffer(b) ? b : Buffer.from(b)
  const len = Buffer.alloc(4)
  len.writeUInt32BE(v.length)
  return Buffer.concat([len, v])
}
const mpint = (b64url: string) => {
  let v = Buffer.from(b64url, 'base64url')
  if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0]), v])
  return sshString(v)
}
function ed25519Pub(comment = 'me@laptop') {
  const { publicKey } = crypto.generateKeyPairSync('ed25519')
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  return `ssh-ed25519 ${Buffer.concat([sshString('ssh-ed25519'), sshString(raw)]).toString('base64')} ${comment}`
}
function rsaPub(bits: number) {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits })
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string }
  return `ssh-rsa ${Buffer.concat([sshString('ssh-rsa'), mpint(jwk.e), mpint(jwk.n)]).toString('base64')}`
}

describe('SSH public keys', () => {
  it('accepts ed25519 and strong RSA, strips options and comments, fingerprints like OpenSSH', () => {
    const k = parsePublicKey(`no-pty,command="rm -rf /" ${ed25519Pub()}`)
    expect(k.type).toBe('ssh-ed25519')
    expect(k.normalized.startsWith('ssh-ed25519 AAAA')).toBe(true)
    expect(k.normalized).not.toContain('command')
    expect(k.normalized.split(' ')).toHaveLength(2)
    expect(k.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(k.comment).toBe('me@laptop')
    expect(parsePublicKey(rsaPub(2048)).bits).toBe(2048)
  })

  it('refuses weak, damaged, mismatched and private keys', () => {
    expect(() => parsePublicKey(rsaPub(1024))).toThrow(/2048/)
    expect(() => parsePublicKey('-----BEGIN OPENSSH PRIVATE KEY-----')).toThrow(/PRIVATE/)
    expect(() => parsePublicKey('ssh-dss AAAAB3NzaC1kc3M=')).toThrow(/Unsupported/)
    const ed = ed25519Pub().split(' ')[1]
    expect(() => parsePublicKey(`ssh-rsa ${ed}`)).toThrow(/does not match/)
    expect(() => parsePublicKey(`ssh-ed25519 ${ed.slice(0, 30)}`)).toThrow()
    expect(() => parsePublicKey(`${ed25519Pub()}\n${ed25519Pub()}`)).toThrow(/one key/)
  })
})

describe('SFTP server scripts', () => {
  it('validates the sshd drop-in and removes it again if sshd rejects it', () => {
    const s = hostSetupScript()
    expect(s).toContain('sshd -t')
    expect(s).toMatch(/if ! sshd -t[^\n]*then rm -f \/etc\/ssh\/sshd_config\.d\/50-apsamo-sftp\.conf/)
    expect(s).not.toMatch(/systemctl restart/)
    expect(s).toContain('ForceCommand internal-sftp')
    expect(s).toContain('PasswordAuthentication no')
  })

  it('grants keys with restrict and only for real site paths and safe usernames', () => {
    const g = grantScript('sftp_shop_ab12', '/opt/deployhub/projects/shop', ['ssh-ed25519 AAAAkey'])
    expect(g).toContain('restrict ssh-ed25519 AAAAkey')
    expect(g).toContain("usermod --password '*'")
    expect(() => grantScript('root; rm -rf /', '/opt/deployhub/projects/shop', [])).toThrow()
    expect(() => grantScript('sftp_shop_ab12', '/etc', [])).toThrow()
    expect(() => grantScript('sftp_shop_ab12', '/opt/deployhub/projects/../../etc', [])).toThrow()
    expect(sftpUsername('My Shop!!', 'ab12')).toBe('sftp_myshop_ab12')
  })

  it('revoking never deletes site files and never kills other sites’ processes', () => {
    const r = revokeScript('sftp_shop_ab12', '/opt/deployhub/projects/shop')
    expect(r).not.toContain('rm -rf')
    expect(r).not.toMatch(/pkill -u/)
    expect(r).toContain('rmdir')
    // Refuses to continue if the site is still mounted.
    expect(r).toMatch(/still mounted; nothing was deleted/)
    expect(r.indexOf('rm -f /etc/ssh/apsamo-keys/sftp_shop_ab12')).toBeLessThan(r.indexOf('umount'))
  })
})

describe('SFTP access API', () => {
  async function addKey(token: string, publicKey: string, extra: Record<string, string> = {}) {
    return keysRoute.POST(authed(token, '/api/user/ssh-keys', { method: 'POST', body: JSON.stringify({ name: 'laptop', publicKey }), headers: { 'x-forwarded-for': `10.66.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...extra } }))
  }
  const put = (token: string, id: string, keyIds: string[]) =>
    sftpRoute.PUT(authed(token, `/api/hosting/${id}/sftp`, { method: 'PUT', body: JSON.stringify({ keyIds }), headers: { 'x-forwarded-for': `10.67.${Math.floor(Math.random() * 250)}.1` } }), params({ id }))

  it('adds keys, refuses duplicates and refuses during support access', async () => {
    const u = await makeUser('sftp-keys')
    const pub = ed25519Pub()
    expect((await addKey(u.token, pub)).status).toBe(201)
    expect((await addKey(u.token, pub)).status).toBe(409)
    const imp = generateToken({ userId: u.id, email: u.email, role: 'user', impersonatedBy: 'admin-id' } as never)
    expect((await addKey(imp, ed25519Pub())).status).toBe(403)
    const list = await (await keysRoute.GET(authed(u.token, '/api/user/ssh-keys'))).json()
    expect(list.keys).toHaveLength(1)
    expect(list.keys[0]).not.toHaveProperty('publicKey', expect.any(String))
  })

  it('turns SFTP on with your own keys only, respects the plan, and follows key removal', async () => {
    const u = await makeUser('sftp-owner')
    const other = await makeUser('sftp-other')
    const plan = await makePlan({ sshAccess: true })
    await db.subscription.create({ data: { userId: u.id, planId: plan.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) } })
    const site = await makeProject(u.id)

    const mine = (await (await addKey(u.token, ed25519Pub())).json()).key
    const theirs = (await (await addKey(other.token, ed25519Pub())).json()).key

    expect((await put(u.token, site.id, [])).status).toBe(400)
    expect((await put(u.token, site.id, [theirs.id])).status).toBe(404)
    expect((await put(other.token, site.id, [theirs.id])).status).toBeGreaterThanOrEqual(403)

    const on = await put(u.token, site.id, [mine.id])
    expect(on.status).toBe(200)
    const info = await on.json()
    expect(info.enabled).toBe(true)
    expect(info.connection.username).toMatch(/^sftp_[a-z0-9]+_[a-f0-9]{4}$/)
    expect(info.keys.map((k: { id: string }) => k.id)).toEqual([mine.id])

    // Removing the key takes it off the website.
    const del = await keyRoute.DELETE(authed(u.token, `/api/user/ssh-keys/${mine.id}`, { method: 'DELETE' }), params({ id: mine.id }))
    expect(del.status).toBe(200)
    const access = await db.sftpAccess.findUnique({ where: { projectId: site.id } })
    expect(JSON.parse(access!.keyIds)).toEqual([])

    const off = await sftpRoute.DELETE(authed(u.token, `/api/hosting/${site.id}/sftp`, { method: 'DELETE' }), params({ id: site.id }))
    expect(off.status).toBe(200)
    expect(await db.sftpAccess.findUnique({ where: { projectId: site.id } })).toBeNull()
  })

  it('is refused when the plan does not include SSH access', async () => {
    const u = await makeUser('sftp-noplan')
    const plan = await makePlan({ sshAccess: false })
    await db.subscription.create({ data: { userId: u.id, planId: plan.id, status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) } })
    const site = await makeProject(u.id)
    const k = (await (await addKey(u.token, ed25519Pub())).json()).key
    expect((await put(u.token, site.id, [k.id])).status).toBe(403)
  })
})
