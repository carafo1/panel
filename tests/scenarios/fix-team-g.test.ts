/**
 * Regression scenarios for:
 *   - team member PATCH/DELETE reaching a member of ANOTHER team by id
 *   - team invitations revealing whether an email address is registered
 *   - the automation job list showing every tenant's jobs to any user
 *   - terminal / cron on a localhost server running customer commands on the
 *     host when the project has no container (they must refuse instead)
 */
import { describe, it, expect, beforeAll } from 'bun:test'
import { db } from '@/lib/db'
import * as member from '@/app/api/teams/[teamId]/members/[memberId]/route'
import * as members from '@/app/api/teams/[teamId]/members/route'
import * as jobs from '@/app/api/automation/jobs/route'
import * as terminal from '@/app/api/hosting/[id]/terminal/route'
import * as cronJob from '@/app/api/hosting/[id]/cron/[jobId]/route'
import { makeUser, makeProject, authed, params, uid } from './helpers'

type U = Awaited<ReturnType<typeof makeUser>>
let ownerA: U, ownerB: U, victim: U, admin: U
let teamA: string, teamB: string
let victimMemberId: string

beforeAll(async () => {
  ownerA = await makeUser('g-owner-a')
  ownerB = await makeUser('g-owner-b')
  victim = await makeUser('g-victim')
  admin = await makeUser('g-admin', 'admin')
  teamA = (await db.team.create({ data: { name: 'A', slug: uid('team-a'), ownerId: ownerA.id } })).id
  teamB = (await db.team.create({ data: { name: 'B', slug: uid('team-b'), ownerId: ownerB.id } })).id
  await db.teamMember.create({ data: { teamId: teamA, userId: ownerA.id, role: 'owner' } })
  await db.teamMember.create({ data: { teamId: teamB, userId: ownerB.id, role: 'owner' } })
  victimMemberId = (
    await db.teamMember.create({ data: { teamId: teamB, userId: victim.id, role: 'viewer' } })
  ).id
})

describe('team members are scoped to their team', () => {
  it("another team's owner cannot change a member's role through their own team", async () => {
    const res = await member.PATCH(
      authed(ownerA.token, `/api/teams/${teamA}/members/${victimMemberId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'admin' }),
      }) as never,
      params({ teamId: teamA, memberId: victimMemberId })
    )
    expect(res.status).toBe(404)
    expect((await db.teamMember.findUnique({ where: { id: victimMemberId } }))?.role).toBe('viewer')
  })

  it("another team's owner cannot remove a member through their own team", async () => {
    const res = await member.DELETE(
      authed(ownerA.token, `/api/teams/${teamA}/members/${victimMemberId}`, { method: 'DELETE' }) as never,
      params({ teamId: teamA, memberId: victimMemberId })
    )
    expect(res.status).toBe(404)
    expect(await db.teamMember.findUnique({ where: { id: victimMemberId } })).not.toBeNull()
  })

  it('the real owner still can', async () => {
    const res = await member.PATCH(
      authed(ownerB.token, `/api/teams/${teamB}/members/${victimMemberId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role: 'developer' }),
      }) as never,
      params({ teamId: teamB, memberId: victimMemberId })
    )
    expect(res.status).toBe(200)
  })
})

describe('team invitations do not reveal registered emails', () => {
  const invite = (email: string) =>
    members.POST(
      authed(ownerA.token, `/api/teams/${teamA}/members`, {
        method: 'POST',
        body: JSON.stringify({ email, role: 'viewer' }),
      }),
      params({ teamId: teamA })
    )

  it('answers the same for a registered and an unknown address', async () => {
    const known = await invite(victim.email)
    const unknown = await invite(`${uid('nobody')}@example.test`)
    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    expect(await known.json()).toEqual(await unknown.json())
  })

  it('still adds an existing account', async () => {
    const m = await db.teamMember.findFirst({ where: { teamId: teamA, userId: victim.id } })
    expect(m?.role).toBe('viewer')
  })

  it('rejects a malformed address', async () => {
    expect((await invite('not-an-email')).status).toBe(400)
  })
})

describe('automation job list', () => {
  const list = (u: U | null) => jobs.GET(authed(u ? u.token : null, '/api/automation/jobs'))
  it('requires a session', async () => {
    expect((await list(null)).status).toBe(401)
  })
  it('is refused to ordinary users', async () => {
    expect((await list(ownerA)).status).toBe(403)
  })
  it('is available to platform admins', async () => {
    expect((await list(admin)).status).toBe(200)
  })
})

describe('terminal and cron never fall back to the host', () => {
  let projectId: string
  let jobId: string

  beforeAll(async () => {
    const server = await db.server.create({
      data: {
        name: uid('local'),
        ip: '127.0.0.1',
        sshHost: 'localhost',
        cpuCores: 1,
        ramGB: 1,
        storageGB: 10,
        bandwidthGB: 100,
      },
    })
    // A localhost project WITHOUT a container: previously the terminal and
    // cron ran commands straight on the panel host for it.
    projectId = (await makeProject(ownerA.id, { serverId: server.id, containerName: null })).id
    jobId = (
      await db.cronJob.create({
        data: { projectId, expression: '* * * * *', command: 'touch /tmp/apsamo-should-not-exist' },
      })
    ).id
  })

  it('terminal session creation is refused with 409', async () => {
    const res = await terminal.POST(
      authed(ownerA.token, `/api/hosting/${projectId}/terminal`, {
        method: 'POST',
        body: JSON.stringify({ action: 'create' }),
      }),
      params({ id: projectId })
    )
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/container/i)
  })

  it('running a cron job is refused with 409 and nothing runs', async () => {
    const res = await cronJob.POST(
      authed(ownerA.token, `/api/hosting/${projectId}/cron/${jobId}?action=run`, { method: 'POST' }),
      params({ id: projectId, jobId })
    )
    expect(res.status).toBe(409)
    const row = await db.cronJob.findUnique({ where: { id: jobId } })
    expect(row?.lastStatus).toBeNull()
  })
})
