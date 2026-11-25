/**
 * Website outgoing mail API (/api/hosting/[id]/mail).
 *
 * Mailcow is blank in scenarios (preload), so mailbox calls run in demo mode
 * and the projects have no server: nothing leaves the process.
 */
import { describe, it, expect } from 'bun:test'
import { db } from '@/lib/db'
import { generateToken } from '@/lib/auth'
import { decrypt } from '@/lib/encryption'
import * as mailRoute from '@/app/api/hosting/[id]/mail/route'
import { ensureSiteMail, removeSiteMail, getSiteMailRuntime } from '@/lib/site-mail'
import { makeUser, makeProject, makePlan, authed, params, uid } from './helpers'

let ip = 0
const fresh = () => ({ 'x-forwarded-for': `10.88.${Math.floor(++ip / 250)}.${ip % 250}` })
const get = (token: string | null, id: string) =>
  mailRoute.GET(authed(token, `/api/hosting/${id}/mail`), params({ id }))
const post = (token: string | null, id: string, body: unknown) =>
  mailRoute.POST(
    authed(token, `/api/hosting/${id}/mail`, { method: 'POST', body: JSON.stringify(body), headers: fresh() }),
    params({ id })
  )

describe('website outgoing mail API', () => {
  it('requires a session and hides other people’s projects', async () => {
    const owner = await makeUser('mail-owner')
    const stranger = await makeUser('mail-stranger')
    const site = await makeProject(owner.id, { deploymentMethod: 'wordpress' })
    expect((await get(null, site.id)).status).toBe(401)
    expect((await post(null, site.id, { action: 'test' })).status).toBe(401)
    expect((await get(stranger.token, site.id)).status).toBe(404)
    expect((await post(stranger.token, site.id, { action: 'enable' })).status).toBe(404)
    // Bad input from a stranger still answers 404, not 400 (no existence leak).
    expect((await post(stranger.token, site.id, { action: 'nope' })).status).toBe(404)
  })

  it('validates the body', async () => {
    const owner = await makeUser('mail-valid')
    const site = await makeProject(owner.id, { deploymentMethod: 'wordpress' })
    expect((await post(owner.token, site.id, { action: 'nope' })).status).toBe(400)
    expect((await post(owner.token, site.id, { action: 'test', to: 'x@y.com' })).status).toBe(400)
    expect((await post(owner.token, site.id, { action: 'enable', fromAddress: 'bad' })).status).toBe(400)
  })

  it('enables, sends a test to the OWNER, rotates and disables', async () => {
    const owner = await makeUser('mail-flow')
    const site = await makeProject(owner.id, { deploymentMethod: 'wordpress' })

    const before = await (await get(owner.token, site.id)).json()
    expect(before.supported).toBe(true)
    expect(before.enabled).toBe(false)

    const on = await post(owner.token, site.id, { action: 'enable' })
    expect(on.status).toBe(200)
    const onBody = await on.json()
    expect(onBody.status.enabled).toBe(true)
    expect(onBody.status.provisioned).toBe(true)
    expect(onBody.status.address).toMatch(/^site-[a-z0-9-]+@/)
    expect(JSON.stringify(onBody)).not.toMatch(/password/i)

    const row = await db.siteMail.findUnique({ where: { projectId: site.id } })
    const pw1 = decrypt(row!.passwordEnc)
    expect(pw1).toMatch(/^[A-Za-z0-9]{32}$/)
    expect(row!.passwordEnc).not.toContain(pw1)

    const test = await post(owner.token, site.id, { action: 'test' })
    expect(test.status).toBe(200)
    const t = await test.json()
    expect(t.test.to).toBe(owner.email)
    expect(t.test.via).toBe('simulated')
    expect(t.status.lastTest.ok).toBe(true)
    // Cooldown between tests.
    expect((await post(owner.token, site.id, { action: 'test' })).status).toBe(429)

    expect((await post(owner.token, site.id, { action: 'rotate' })).status).toBe(200)
    const pw2 = decrypt((await db.siteMail.findUnique({ where: { projectId: site.id } }))!.passwordEnc)
    expect(pw2).not.toBe(pw1)

    const off = await post(owner.token, site.id, { action: 'disable' })
    expect(off.status).toBe(200)
    expect((await off.json()).status.enabled).toBe(false)
    expect(await getSiteMailRuntime(site.id)).toBeNull()
    // A deploy must not switch it back on.
    expect(await ensureSiteMail(site.id)).toBeNull()
    expect((await db.siteMail.findUnique({ where: { projectId: site.id } }))!.enabled).toBe(false)
    expect((await post(owner.token, site.id, { action: 'test' })).status).toBe(409)
  })

  it('only allows a From address on a mail domain the owner hosts with us', async () => {
    const owner = await makeUser('mail-from')
    const site = await makeProject(owner.id, { deploymentMethod: 'wordpress' })
    const plan = await makePlan()
    const domain = `${uid('shop')}.test`
    await db.emailService.create({ data: { userId: owner.id, planId: plan.id, domain, status: 'active' } })
    const other = `${uid('other')}.test`

    expect((await post(owner.token, site.id, { action: 'enable', fromAddress: `info@${other}` })).status).toBe(422)
    const ok = await post(owner.token, site.id, { action: 'enable', fromAddress: `info@${domain}`, fromName: 'Shop' })
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.status.fromAddress).toBe(`info@${domain}`)
    expect(body.status.fromDomains).toEqual([domain])
    const rt = await getSiteMailRuntime(site.id)
    expect(rt!.from).toBe(`info@${domain}`)
    expect(rt!.user).toMatch(/^site-/)

    const reset = await post(owner.token, site.id, { action: 'enable', fromAddress: null })
    expect((await reset.json()).status.fromAddress).toBeNull()
  })

  it('applies team roles: developers may view and test, only data roles change credentials', async () => {
    const owner = await makeUser('mail-team-owner')
    const dev = await makeUser('mail-team-dev')
    const team = await db.team.create({ data: { name: 'Crew', slug: uid('crew'), ownerId: owner.id } })
    await db.teamMember.create({ data: { teamId: team.id, userId: dev.id, role: 'developer' } })
    const site = await makeProject(owner.id, { deploymentMethod: 'php', teamId: team.id })
    expect((await get(dev.token, site.id)).status).toBe(200)
    expect((await post(dev.token, site.id, { action: 'enable' })).status).toBe(403)
    expect((await post(dev.token, site.id, { action: 'rotate' })).status).toBe(403)
    // PHP sites need a redeploy to rebuild msmtp.
    const on = await post(owner.token, site.id, { action: 'enable' })
    expect((await on.json()).apply.requiresRedeploy).toBe(true)
  })

  it('refuses credential changes during support access', async () => {
    const owner = await makeUser('mail-imp')
    const site = await makeProject(owner.id, { deploymentMethod: 'wordpress' })
    const imp = generateToken({ userId: owner.id, email: owner.email, role: 'user', impersonatedBy: 'admin-id' } as never)
    expect((await post(imp, site.id, { action: 'rotate' })).status).toBe(403)
  })

  it('is not offered for other site types', async () => {
    const owner = await makeUser('mail-node')
    const site = await makeProject(owner.id, { deploymentMethod: 'nodejs' })
    expect((await (await get(owner.token, site.id)).json()).supported).toBe(false)
    expect((await post(owner.token, site.id, { action: 'enable' })).status).toBe(422)
    expect(await ensureSiteMail(site.id)).toBeNull()
  })

  it('deploy provisioning is idempotent and project deletion removes the mailbox', async () => {
    const owner = await makeUser('mail-deploy')
    const site = await makeProject(owner.id, { deploymentMethod: 'wordpress' })
    const a = await ensureSiteMail(site.id)
    const b = await ensureSiteMail(site.id)
    expect(a).not.toBeNull()
    expect(b!.user).toBe(a!.user)
    expect(b!.password).toBe(a!.password)
    expect(await db.siteMail.count({ where: { projectId: site.id } })).toBe(1)
    expect(await removeSiteMail(site.id)).toBeNull()
    expect(await db.siteMail.findUnique({ where: { projectId: site.id } })).toBeNull()
  })
})
