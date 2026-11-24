/**
 * API keys stored as hashes, the per-login 2FA attempt budget, git URL rules
 * on project PATCH, what counts as owning a domain (email ownership and mail
 * tenancy), the admin job retry budget and the pre-deploy compose command.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { db } from '@/lib/db'
import {
  hashApiKey,
  verifyApiKey,
  generateTwoFactorTempToken,
  invalidateUserAuthCache,
  TWO_FACTOR_MAX_ATTEMPTS,
} from '@/lib/auth'
import { generateSecret, generateToken as totpCode } from '@/lib/totp'
import { isDomainOwnedInPanel } from '@/lib/domain-verification'
import { resolveMailTenant, MailAccessError } from '@/lib/mailcow-tenant'
import { buildPreDeployStageCommand } from '@/lib/pipeline-runner'
import * as apiKeys from '@/app/api/user/api-keys/route'
import * as loginVerify from '@/app/api/auth/2fa/login-verify/route'
import * as verifyBackup from '@/app/api/auth/2fa/verify-backup/route'
import * as project from '@/app/api/hosting/[id]/route'
import * as jobRetry from '@/app/api/admin/jobs/[id]/retry/route'
import { makeUser, makeProject, authed, params, uid } from './helpers'

let ip = 0
/** Each request from a different IP, so only the per-token budget can stop it. */
const freshIp = () => ({ 'x-forwarded-for': `10.77.${++ip & 255}.${(ip >> 8) & 255}` })

describe('API keys are stored hashed', () => {
  it('stores only the digest and returns the raw key once', async () => {
    const u = await makeUser('apikey-owner')
    const res = await apiKeys.POST(
      authed(u.token, '/api/user/api-keys', { method: 'POST', body: JSON.stringify({ name: 'cli' }) })
    )
    expect(res.status).toBe(200)
    const raw: string = (await res.json()).apiKey.key
    expect(raw.startsWith('dh_')).toBe(true)

    const row = await db.apiKey.findFirst({ where: { userId: u.id } })
    expect(row!.key).toBe(hashApiKey(raw))
    expect(row!.key).not.toContain(raw)
    expect(row!.prefix).toBe(raw.slice(0, 8))

    const list = await (await apiKeys.GET(authed(u.token, '/api/user/api-keys'))).json()
    expect(JSON.stringify(list)).not.toContain(raw)
    expect(JSON.stringify(list)).not.toContain(row!.key)

    expect((await verifyApiKey(raw))?.userId).toBe(u.id)
    // The stored digest is not itself a credential.
    expect(await verifyApiKey(row!.key)).toBeNull()
    expect(await verifyApiKey(`dh_${'0'.repeat(64)}`)).toBeNull()
  })

  it('accepts a legacy plain-text row once and rewrites it to the digest', async () => {
    const u = await makeUser('apikey-legacy')
    const raw = `dh_${uid('legacy').replace(/[^a-z0-9]/g, '')}${'a'.repeat(20)}`
    const row = await db.apiKey.create({ data: { userId: u.id, name: 'old', key: raw, prefix: raw.slice(0, 8) } })

    expect((await verifyApiKey(raw))?.userId).toBe(u.id)
    const after = await db.apiKey.findUnique({ where: { id: row.id } })
    expect(after!.key).toBe(hashApiKey(raw))
    // Still works after the migration, now through the digest.
    expect((await verifyApiKey(raw))?.userId).toBe(u.id)
  })

  it('rejects a non-string name', async () => {
    const u = await makeUser('apikey-badname')
    const res = await apiKeys.POST(
      authed(u.token, '/api/user/api-keys', { method: 'POST', body: JSON.stringify({ name: { x: 1 } }) })
    )
    expect(res.status).toBe(400)
  })
})

describe('2FA attempt budget per pending login', () => {
  async function twoFactorUser(tag: string) {
    const u = await makeUser(tag)
    const secret = generateSecret()
    await db.user.update({ where: { id: u.id }, data: { twoFactorEnabled: true, twoFactorSecret: secret } })
    invalidateUserAuthCache(u.id)
    return { ...u, secret }
  }
  const verify = (tempToken: string, token: string) =>
    loginVerify.POST(
      authed(null, '/api/auth/2fa/login-verify', {
        method: 'POST',
        body: JSON.stringify({ tempToken, token }),
        headers: freshIp(),
      })
    )

  it(`rejects the pending token after ${TWO_FACTOR_MAX_ATTEMPTS} attempts, even with the right code`, async () => {
    const u = await twoFactorUser('2fa-brute')
    const temp = generateTwoFactorTempToken(u.id)
    for (let i = 0; i < TWO_FACTOR_MAX_ATTEMPTS; i++) {
      expect((await verify(temp, '000000')).status).toBe(400)
    }
    const blocked = await verify(temp, totpCode(u.secret))
    expect(blocked.status).toBe(401)
    expect((await blocked.json()).code).toBe('two_factor_attempts_exceeded')

    // Signing in again gives a fresh budget.
    const again = await verify(generateTwoFactorTempToken(u.id), totpCode(u.secret))
    expect(again.status).toBe(200)
  })

  it('shares the budget between the TOTP and backup-code endpoints', async () => {
    const u = await twoFactorUser('2fa-shared')
    await db.user.update({ where: { id: u.id }, data: { twoFactorBackupCodes: JSON.stringify([]) } })
    const temp = generateTwoFactorTempToken(u.id)
    for (let i = 0; i < TWO_FACTOR_MAX_ATTEMPTS; i++) {
      const r = await verifyBackup.POST(
        authed(null, '/api/auth/2fa/verify-backup', {
          method: 'POST',
          body: JSON.stringify({ tempToken: temp, backupCode: 'WRONG-CODE' }),
          headers: freshIp(),
        })
      )
      expect(r.status).toBe(401)
    }
    const blocked = await verify(temp, totpCode(u.secret))
    expect(blocked.status).toBe(401)
    expect((await blocked.json()).code).toBe('two_factor_attempts_exceeded')
  })

  it('two logins never share a token (each carries its own jti)', async () => {
    const u = await makeUser('2fa-jti')
    expect(generateTwoFactorTempToken(u.id)).not.toBe(generateTwoFactorTempToken(u.id))
  })
})

describe('PATCH /api/hosting/[id] repoUrl uses the create-time git URL rule', () => {
  const patch = (token: string, id: string, repoUrl: string) =>
    project.PATCH(
      authed(token, `/api/hosting/${id}`, { method: 'PATCH', body: JSON.stringify({ repoUrl }) }),
      params({ id })
    )

  it('refuses http://, local and non-git URLs; accepts https:// and git@', async () => {
    const u = await makeUser('patch-git')
    const site = await makeProject(u.id)
    for (const bad of ['http://github.com/a/b.git', 'file:///etc', '/opt/deployhub/projects/x', 'https://127.0.0.1/r.git', '--upload-pack=x']) {
      expect((await patch(u.token, site.id, bad)).status).toBe(400)
    }
    expect((await db.project.findUnique({ where: { id: site.id } }))!.repoUrl).toBeNull()

    expect((await patch(u.token, site.id, ' https://github.com/acme/site.git ')).status).toBe(200)
    expect((await db.project.findUnique({ where: { id: site.id } }))!.repoUrl).toBe('https://github.com/acme/site.git')
    expect((await patch(u.token, site.id, 'git@github.com:acme/site.git')).status).toBe(200)
    expect((await patch(u.token, site.id, '')).status).toBe(200)
    expect((await db.project.findUnique({ where: { id: site.id } }))!.repoUrl).toBeNull()
  })
})

describe('domain ownership', () => {
  it('a pending_verification Domain row is not proof of ownership; an active one is', async () => {
    const u = await makeUser('own-domain')
    const name = `${uid('claim')}.example.test`
    const d = await db.domain.create({ data: { userId: u.id, name, status: 'pending_verification', provider: 'custom' } })
    expect(await isDomainOwnedInPanel(u.id, name)).toBe(false)
    await db.domain.update({ where: { id: d.id }, data: { status: 'active' } })
    expect(await isDomainOwnedInPanel(u.id, name)).toBe(true)
  })

  describe('mail tenancy trusts customDomain only when it is proven', () => {
    const saved = { url: process.env.MAILCOW_API_URL, key: process.env.MAILCOW_API_KEY }
    beforeAll(() => {
      process.env.MAILCOW_API_URL = 'https://mailcow.fake.test'
      process.env.MAILCOW_API_KEY = 'fake-key-for-tests'
    })
    afterAll(() => {
      if (saved.url === undefined) delete process.env.MAILCOW_API_URL
      else process.env.MAILCOW_API_URL = saved.url
      if (saved.key === undefined) delete process.env.MAILCOW_API_KEY
      else process.env.MAILCOW_API_KEY = saved.key
    })

    const tenant = (token: string, id: string) => resolveMailTenant(authed(token, `/api/hosting/${id}/email`), id)

    it('an unbacked customDomain is ignored', async () => {
      const u = await makeUser('mail-unbacked')
      const victim = `${uid('victim')}.example.test`
      const site = await makeProject(u.id, { customDomain: victim })
      const err = await tenant(u.token, site.id).catch((e) => e)
      expect(err).toBeInstanceOf(MailAccessError)
      expect((err as MailAccessError).status).toBe(409)

      // A pending claim on the Domain table does not change that.
      await db.domain.create({ data: { userId: u.id, name: victim, status: 'pending_verification', provider: 'custom' } })
      expect(await tenant(u.token, site.id).catch((e) => e)).toBeInstanceOf(MailAccessError)
    })

    it('counts when backed by an active Domain of the owner or a verified WebsiteDomain', async () => {
      const u = await makeUser('mail-backed')
      const owned = `${uid('owned')}.example.test`
      const siteA = await makeProject(u.id, { customDomain: owned })
      await db.domain.create({ data: { userId: u.id, name: owned, status: 'active' } })
      expect((await tenant(u.token, siteA.id)).domains).toEqual([owned])

      const viaSite = `${uid('viasite')}.example.test`
      const siteB = await makeProject(u.id, { customDomain: viaSite })
      await db.websiteDomain.create({ data: { projectId: siteB.id, domain: viaSite, verified: true } })
      expect((await tenant(u.token, siteB.id)).domains).toEqual([viaSite])
    })

    it("another user's active Domain does not back this project's customDomain", async () => {
      const owner = await makeUser('mail-real-owner')
      const attacker = await makeUser('mail-attacker')
      const name = `${uid('theirs')}.example.test`
      await db.domain.create({ data: { userId: owner.id, name, status: 'active' } })
      const site = await makeProject(attacker.id, { customDomain: name })
      expect(await tenant(attacker.token, site.id).catch((e) => e)).toBeInstanceOf(MailAccessError)
    })
  })
})

describe('admin job retry', () => {
  it('resets attempts so the retried job runs under the normal budget', async () => {
    const admin = await makeUser('job-admin', 'admin')
    await db.user.update({ where: { id: admin.id }, data: { twoFactorEnabled: true, twoFactorSecret: generateSecret() } })
    invalidateUserAuthCache(admin.id)
    const job = await db.jobQueue.create({
      data: { type: 'no_such_job_type_for_tests', payload: '{}', status: 'failed', attempts: 3, maxAttempts: 3, error: 'old' },
    })

    const res = await jobRetry.POST(authed(admin.token, `/api/admin/jobs/${job.id}/retry`, { method: 'POST' }), params({ id: job.id }))
    expect(res.status).toBe(200)
    const after = await db.jobQueue.findUnique({ where: { id: job.id } })
    // Reset to 0, then this run claimed attempt 1 (it was 4 before the fix).
    expect(after!.attempts).toBe(1)
    expect(after!.error).toContain('Unknown job type')

    const queued = await db.jobQueue.create({ data: { type: 'x', payload: '{}', status: 'queued' } })
    const refused = await jobRetry.POST(authed(admin.token, `/x`, { method: 'POST' }), params({ id: queued.id }))
    expect(refused.status).toBe(400)
  })
})

describe('pre-deploy pipeline checks', () => {
  it('run compose with the stripped environment and a pinned project name', () => {
    const cmd = buildPreDeployStageCommand(
      { command: 'npm test', workingDir: null, env: [['CI', '1']] },
      '/opt/deployhub/projects/shop'
    )
    expect(cmd).toContain('env -i PATH="$PATH" HOME="$HOME" ')
    expect(cmd).toContain('docker compose -p shop run --rm --no-deps -e CI=1 --entrypoint sh app -c')
    expect(cmd.indexOf('env -i')).toBeLessThan(cmd.indexOf('docker compose'))
  })
})
