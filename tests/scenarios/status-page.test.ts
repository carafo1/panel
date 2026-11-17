/** Public status page and staff incident posting. */
import { describe, it, expect, beforeEach } from 'bun:test'
import { db } from '@/lib/db'
import * as status from '@/app/api/status/route'
import * as incidents from '@/app/api/admin/incidents/route'
import * as incident from '@/app/api/admin/incidents/[id]/route'
import { makeUser, authed, params } from './helpers'

const post = (token: string, body: Record<string, unknown>) =>
  incidents.POST(authed(token, '/api/admin/incidents', { method: 'POST', body: JSON.stringify(body) }))
const update = (token: string, id: string, body: Record<string, unknown>) =>
  incident.POST(authed(token, `/api/admin/incidents/${id}`, { method: 'POST', body: JSON.stringify(body) }), params({ id }))
const page = async () => (await status.GET()).json()

describe('status page', () => {
  beforeEach(async () => {
    await db.incident.deleteMany({})
  })

  it('is public and never exposes server details', async () => {
    await db.server.create({
      data: { name: 'secret-node-7', ip: '203.0.113.77', cpuCores: 2, ramGB: 4, storageGB: 40, bandwidthGB: 1000, healthStatus: 'healthy', lastHealthCheckAt: new Date() },
    })
    const res = await status.GET()
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain('secret-node-7')
    expect(text).not.toContain('203.0.113.77')
    const data = JSON.parse(text)
    expect(data.components.find((c: { key: string }) => c.key === 'panel').status).toBe('operational')
    expect(data.components.find((c: { key: string }) => c.key === 'hosting').auto).toBe(true)
  })

  it('only staff can post incidents', async () => {
    const c = await makeUser('st-cust')
    expect((await post(c.token, { title: 'x', message: 'y', components: ['email'] })).status).toBe(403)
    expect((await incidents.GET(authed(c.token, '/api/admin/incidents'))).status).toBe(403)
  })

  it('an incident marks its components, shows updates, and resolving clears it', async () => {
    const admin = await makeUser('st-admin', 'admin')
    expect((await post(admin.token, { title: 'Mail delays', impact: 'major', message: 'Looking into it', components: [] })).status).toBe(400)
    const res = await post(admin.token, { title: 'Mail delays', impact: 'major', message: 'Looking into it', components: ['email', 'bogus'] })
    expect(res.status).toBe(201)
    const { incident: inc } = await res.json()

    let p = await page()
    expect(p.components.find((c: { key: string }) => c.key === 'email').status).toBe('partial_outage')
    expect(p.overall).toBe('partial_outage')
    expect(p.active).toHaveLength(1)
    expect(p.active[0].components).toEqual(['email'])

    expect((await update(admin.token, inc.id, { status: 'completed', message: 'x' })).status).toBe(400)
    expect((await update(admin.token, inc.id, { status: 'identified', message: 'Queue backlog' })).status).toBe(200)
    expect((await update(admin.token, inc.id, { status: 'resolved', message: 'All delivered' })).status).toBe(200)
    expect((await update(admin.token, inc.id, { status: 'monitoring', message: 'again' })).status).toBe(400)

    p = await page()
    expect(p.active).toHaveLength(0)
    expect(p.components.find((c: { key: string }) => c.key === 'email').status).toBe('operational')
    expect(p.recent[0].updates.map((u: { status: string }) => u.status)).toEqual(['resolved', 'identified', 'investigating'])
  })

  it('future maintenance is listed as upcoming without affecting status', async () => {
    const admin = await makeUser('st-maint', 'admin')
    const startsAt = new Date(Date.now() + 86400_000).toISOString()
    expect((await post(admin.token, { title: 'DB upgrade', impact: 'maintenance', message: 'Planned', components: ['panel'], startsAt })).status).toBe(201)
    const p = await page()
    expect(p.upcoming).toHaveLength(1)
    expect(p.active).toHaveLength(0)
    expect(p.components.find((c: { key: string }) => c.key === 'panel').status).toBe('operational')
  })

  it('staff can delete an incident posted by mistake', async () => {
    const admin = await makeUser('st-del', 'admin')
    const { incident: inc } = await (await post(admin.token, { title: 'Oops', message: 'wrong', components: ['billing'] })).json()
    const del = await incident.DELETE(authed(admin.token, `/api/admin/incidents/${inc.id}`, { method: 'DELETE' }), params({ id: inc.id }))
    expect(del.status).toBe(200)
    expect((await page()).active).toHaveLength(0)
  })
})
