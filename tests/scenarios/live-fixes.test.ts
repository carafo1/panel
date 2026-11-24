/**
 * Fixes for problems reproduced on the live panel:
 *   - connecting a domain by nameservers: the DNS zone is published when the
 *     domain is added (it used to wait for a delegation that could never
 *     resolve without it), and removed with the domain;
 *   - uploads above the proxy body limit are refused with a clear 413 instead
 *     of arriving truncated ("Could not parse multipart form").
 *
 * PowerDNS is never reached: dns-zones is wrapped so tests record calls.
 * Unset hooks delegate to the real module, so other files are unaffected.
 */
import { describe, it, expect, beforeAll, mock } from 'bun:test'
import * as realDnsZonesNs from '@/lib/dns-zones'

const realDnsZones = { ...realDnsZonesNs }
const calls = { created: [] as string[], deleted: [] as string[], snapshots: [] as string[] }
let fakeDns = false

mock.module('@/lib/dns-zones', () => ({
  ...realDnsZones,
  isDnsHostingConfigured: () => (fakeDns ? true : realDnsZones.isDnsHostingConfigured()),
  snapshotExistingRecords: (domain: string) => {
    if (!fakeDns) return realDnsZones.snapshotExistingRecords(domain)
    calls.snapshots.push(domain)
    return Promise.resolve({ hasComplexDns: false, extra: [] } as unknown as Awaited<ReturnType<typeof realDnsZones.snapshotExistingRecords>>)
  },
  createZone: (opts: Parameters<typeof realDnsZones.createZone>[0]) => {
    if (!fakeDns) return realDnsZones.createZone(opts)
    calls.created.push(opts.domain)
    return Promise.resolve({ ok: true, detail: 'created (test)' })
  },
  deleteZone: (domain: string) => {
    if (!fakeDns) return realDnsZones.deleteZone(domain)
    calls.deleted.push(domain)
    return Promise.resolve(true)
  },
}))

const { db } = await import('@/lib/db')
const domainsRoute = await import('@/app/api/hosting/[id]/domains/route')
const domainRoute = await import('@/app/api/hosting/[id]/domains/[domainId]/route')
const filesRoute = await import('@/app/api/hosting/[id]/files/route')
const uploadRoute = await import('@/app/api/hosting/upload/route')
const { PROXY_BODY_LIMIT_BYTES } = await import('@/lib/request-limits')
const { makeUser, makeProject, authed, params, uid } = await import('./helpers')

type U = Awaited<ReturnType<typeof makeUser>>
let owner: U

beforeAll(async () => {
  owner = await makeUser('lf-owner')
  // A server with an IP, so the zone has an address to point at.
  await db.server.create({
    data: { name: uid('lf'), ip: '203.0.113.50', sshHost: 'localhost', cpuCores: 1, ramGB: 1, storageGB: 10, bandwidthGB: 100, status: 'active' },
  })
})

describe('connecting a domain by nameservers', () => {
  it('publishes the DNS zone as soon as the domain is added', async () => {
    fakeDns = true
    const p = await makeProject(owner.id)
    const domain = `${uid('connect')}.com`.toLowerCase()
    const res = await domainsRoute.POST(
      authed(owner.token, `/api/hosting/${p.id}/domains`, { method: 'POST', body: JSON.stringify({ domain }) }),
      params({ id: p.id })
    )
    expect(res.status).toBeLessThan(300)
    expect(calls.created).toContain(domain)
    // Existing records are copied while the old nameservers still answer.
    expect(calls.snapshots).toContain(domain)
    const row = await db.websiteDomain.findFirst({ where: { domain } })
    expect(row?.zoneCreated).toBe(true)
    expect(row?.verified).toBe(false) // publishing the zone is not verification
    fakeDns = false
  })

  it('removes the zone it published when the domain is removed', async () => {
    fakeDns = true
    const p = await makeProject(owner.id)
    const domain = `${uid('remove')}.com`.toLowerCase()
    const row = await db.websiteDomain.create({ data: { projectId: p.id, domain, zoneCreated: true } })
    const res = await domainRoute.DELETE(
      authed(owner.token, `/api/hosting/${p.id}/domains/${row.id}`, { method: 'DELETE' }),
      params({ id: p.id, domainId: row.id })
    )
    expect(res.status).toBe(200)
    expect(calls.deleted).toContain(domain)
    fakeDns = false
  })

  it('never removes the zone of a domain the customer holds with us', async () => {
    fakeDns = true
    const p = await makeProject(owner.id)
    const domain = `${uid('held')}.com`.toLowerCase()
    await db.domain.create({ data: { userId: owner.id, name: domain, status: 'active', provider: 'dynadot' } })
    const row = await db.websiteDomain.create({ data: { projectId: p.id, domain, zoneCreated: true } })
    await domainRoute.DELETE(
      authed(owner.token, `/api/hosting/${p.id}/domains/${row.id}`, { method: 'DELETE' }),
      params({ id: p.id, domainId: row.id })
    )
    expect(calls.deleted).not.toContain(domain)
    fakeDns = false
  })
})

describe('uploads above the proxy body limit', () => {
  const tooBig = String(PROXY_BODY_LIMIT_BYTES + 1)

  it('file manager upload: clear 413, never a truncated parse', async () => {
    const p = await makeProject(owner.id)
    const res = await filesRoute.POST(
      new Request(`http://localhost/api/hosting/${p.id}/files`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${owner.token}`,
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': tooBig,
        },
        body: '--x--',
      }),
      params({ id: p.id })
    )
    expect(res.status).toBe(413)
    expect((await res.json()).error).toMatch(/too large/i)
  })

  it('site upload (streamed): refused instead of stored cut off', async () => {
    const res = await uploadRoute.POST(
      new Request('http://localhost/api/hosting/upload', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${owner.token}`,
          'content-type': 'application/octet-stream',
          'x-upload-filename': 'site.zip',
          'content-length': tooBig,
        },
        body: 'x',
      })
    )
    expect(res.status).toBe(413)
  })
})
