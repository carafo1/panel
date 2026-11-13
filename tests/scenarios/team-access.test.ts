/**
 * Team access: who may do what to a shared project, through the real route
 * handlers. Also guards two security fixes:
 *   - .env import wrote variables into ANY project before checking ownership
 *   - the realtime service let anyone join any room (live logs, notifications)
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import * as list from '@/app/api/hosting/route'
import * as project from '@/app/api/hosting/[id]/route'
import * as env from '@/app/api/hosting/[id]/env/route'
import * as cron from '@/app/api/hosting/[id]/cron/route'
import * as restart from '@/app/api/hosting/[id]/container/restart/route'
import * as databases from '@/app/api/hosting/[id]/databases/route'
import * as terminal from '@/app/api/hosting/[id]/terminal/route'
import * as deployments from '@/app/api/deployments/route'
import * as teamProjects from '@/app/api/teams/[teamId]/projects/route'
import * as realtimeAuth from '@/app/api/realtime/authorize/route'
import { makeUser, makeProject, authed, params, uid } from './helpers'

type U = Awaited<ReturnType<typeof makeUser>>
let owner: U, teamAdmin: U, dev: U, viewer: U, outsider: U, platform: U
let projectId: string
let teamId: string

/** Got past the access check (anything but 403/404). */
const allowed = (status: number) => status !== 403 && status !== 404

beforeAll(async () => {
  owner = await makeUser('owner')
  teamAdmin = await makeUser('team-admin')
  dev = await makeUser('dev')
  viewer = await makeUser('viewer')
  outsider = await makeUser('outsider')
  platform = await makeUser('platform', 'admin')
  projectId = (await makeProject(owner.id)).id
  await db.deployment.create({ data: { projectId, userId: owner.id, commit: 'abc', branch: 'main', status: 'live', triggeredBy: 'manual' } })
  const team = await db.team.create({ data: { name: 'Crew', slug: uid('crew'), ownerId: owner.id } })
  teamId = team.id
  await db.teamMember.createMany({
    data: [
      { teamId, userId: owner.id, role: 'owner' },
      { teamId, userId: teamAdmin.id, role: 'admin' },
      { teamId, userId: dev.id, role: 'developer' },
      { teamId, userId: viewer.id, role: 'viewer' },
    ],
  })
})

const share = (u: U, pid: string) =>
  teamProjects.POST(authed(u.token, `/api/teams/${teamId}/projects`, { method: 'POST', body: JSON.stringify({ projectId: pid }) }), params({ teamId }))
const view = (u: U) => project.GET(authed(u.token, `/api/hosting/${projectId}`), params({ id: projectId }))

describe('sharing', () => {
  it('a project is private until shared', async () => {
    expect((await view(dev)).status).toBe(404)
  })
  it('a developer cannot add projects to the team', async () => {
    expect((await share(dev, projectId)).status).toBe(403)
  })
  it("a team admin cannot share someone else's project", async () => {
    const other = await makeProject(outsider.id)
    expect((await share(teamAdmin, other.id)).status).toBe(404)
  })
  it('the owner shares it', async () => {
    expect((await share(owner, projectId)).status).toBe(201)
  })
  it('members see it in their lists, outsiders do not', async () => {
    const ids = async (u: U) => ((await (await list.GET(authed(u.token, '/api/hosting'))).json()).projects as { id: string }[]).map((p) => p.id)
    expect(await ids(viewer)).toContain(projectId)
    expect(await ids(outsider)).not.toContain(projectId)
    const deps = await (await deployments.GET(authed(dev.token, '/api/deployments'))).json()
    expect((deps.deployments as { projectId: string }[]).map((d) => d.projectId)).toContain(projectId)
  })
})

describe('role matrix', () => {
  const call = {
    view: (u: U) => view(u),
    envRead: (u: U) => env.GET(authed(u.token, `/api/hosting/${projectId}/env`), params({ id: projectId })),
    cronRead: (u: U) => cron.GET(authed(u.token, `/api/hosting/${projectId}/cron`), params({ id: projectId })),
    restart: (u: U) => restart.POST(authed(u.token, `/api/hosting/${projectId}/container/restart`, { method: 'POST' }), params({ id: projectId })),
    settings: (u: U) => project.PATCH(authed(u.token, `/api/hosting/${projectId}`, { method: 'PATCH', body: JSON.stringify({ autoDeploy: false }) }), params({ id: projectId })),
    databases: (u: U) => databases.GET(authed(u.token, `/api/hosting/${projectId}/databases`), params({ id: projectId })),
    terminal: (u: U) => terminal.GET(authed(u.token, `/api/hosting/${projectId}/terminal`), params({ id: projectId })),
  }
  const cases: Array<[keyof typeof call, Record<string, boolean>]> = [
    ['view', { viewer: true, dev: true, teamAdmin: true, outsider: false }],
    ['envRead', { viewer: false, dev: true, teamAdmin: true, outsider: false }],
    ['cronRead', { viewer: false, dev: true, teamAdmin: true, outsider: false }],
    ['restart', { viewer: false, dev: true, teamAdmin: true, outsider: false }],
    ['settings', { viewer: false, dev: true, teamAdmin: true, outsider: false, platform: false }],
    ['databases', { viewer: false, dev: false, teamAdmin: true, outsider: false }],
    ['terminal', { viewer: false, dev: false, teamAdmin: true, outsider: false }],
  ]
  for (const [action, expected] of cases) {
    it(`${action}: ${Object.entries(expected).map(([who, ok]) => `${who}${ok ? '✓' : '✗'}`).join(' ')}`, async () => {
      const users: Record<string, U> = { viewer, dev, teamAdmin, outsider, platform }
      const got: Record<string, boolean> = {}
      for (const who of Object.keys(expected)) got[who] = allowed((await call[action](users[who])).status)
      expect(got).toEqual(expected)
    })
  }

  it('a refused member is told why', async () => {
    const body = await (await call.envRead(viewer)).json()
    expect(body.error).toMatch(/team role/i)
  })

  it('the project response tells the UI what the caller may do', async () => {
    const d = (await (await view(dev)).json()).project.access
    expect(d).toMatchObject({ canDeploy: true, canConfigure: true, canAccessData: false, isOwner: false })
  })

  it('only the owner may delete (members 403, outsiders and platform admins 404)', async () => {
    const del = (u: U) => project.DELETE(authed(u.token, `/api/hosting/${projectId}`, { method: 'DELETE' }), params({ id: projectId }))
    expect((await del(teamAdmin)).status).toBe(403)
    expect((await del(outsider)).status).toBe(404)
    expect((await del(platform)).status).toBe(404)
  })
})

describe('security regressions', () => {
  it('a stranger cannot import a .env into someone else\'s project', async () => {
    const victimProject = await makeProject(owner.id)
    const res = await env.POST(
      authed(outsider.token, `/api/hosting/${victimProject.id}/env`, {
        method: 'POST',
        body: JSON.stringify({ action: 'import', content: 'INJECTED=1\nNODE_OPTIONS=--require /tmp/x.js' }),
      }),
      params({ id: victimProject.id })
    )
    expect(res.status).toBe(404)
    expect(await db.environmentVariable.count({ where: { projectId: victimProject.id } })).toBe(0)
  })

  it('live-log and notification rooms are authorized per user', async () => {
    const dep = await db.deployment.findFirstOrThrow({ where: { projectId } })
    const ask = async (u: U | null, room: string) =>
      (await realtimeAuth.POST(authed(u?.token ?? null, '/api/realtime/authorize', { method: 'POST', body: JSON.stringify({ room }) }))).status
    expect(await ask(null, `user:${owner.id}`)).toBe(401)
    expect(await ask(owner, `user:${owner.id}`)).toBe(200)
    expect(await ask(outsider, `user:${owner.id}`)).toBe(403)
    expect(await ask(viewer, `deployment:${dep.id}`)).toBe(200)
    expect(await ask(outsider, `deployment:${dep.id}`)).toBe(403)
    expect(await ask(outsider, `project:${projectId}`)).toBe(403)
    expect(await ask(owner, 'admin:everything')).toBe(403)
  })
})

describe('losing access', () => {
  it('a removed member loses access immediately', async () => {
    await db.teamMember.deleteMany({ where: { teamId, userId: dev.id } })
    expect((await view(dev)).status).toBe(404)
  })
  it('unsharing removes access for the team but not the owner', async () => {
    const res = await teamProjects.DELETE(authed(teamAdmin.token, `/api/teams/${teamId}/projects?projectId=${projectId}`, { method: 'DELETE' }), params({ teamId }))
    expect(res.status).toBe(200)
    expect((await view(viewer)).status).toBe(404)
    expect((await view(owner)).status).toBe(200)
  })
})
