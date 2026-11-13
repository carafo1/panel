import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createNotification } from '@/lib/notifications'

/**
 * Share a project with a team, or stop sharing it.
 *
 *   POST   /api/teams/[teamId]/projects   { projectId }
 *   DELETE /api/teams/[teamId]/projects?projectId=…
 *
 * Sharing gives every member access according to their team role (see
 * lib/project-access). The project keeps its owner: billing, plan limits and
 * deletion stay with them.
 *
 * Adding: only the PROJECT OWNER, and only into a team where they are owner
 * or admin — so nobody can push a project into a team they don't run, and
 * nobody can share someone else's project.
 * Removing: the project owner, or the team's owner/admin.
 */

async function auth(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  return token ? verifyTokenFresh(token) : null
}

async function teamRole(teamId: string, userId: string): Promise<string | null> {
  const m = await db.teamMember.findUnique({
    where: { teamId_userId: { teamId, userId } },
    select: { role: true },
  })
  return m?.role ?? null
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> }
) {
  try {
    const decoded = await auth(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { teamId } = await params
    const body = (await request.json().catch(() => null)) as { projectId?: unknown } | null
    const projectId = typeof body?.projectId === 'string' ? body.projectId : ''
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    }

    const team = await db.team.findUnique({
      where: { id: teamId },
      select: { id: true, name: true, members: { select: { userId: true } } },
    })
    const myRole = team ? await teamRole(teamId, decoded.userId) : null
    if (!team || !myRole) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }
    if (myRole !== 'owner' && myRole !== 'admin') {
      return NextResponse.json(
        { error: 'Only a team owner or admin can add projects to this team.' },
        { status: 403 }
      )
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, userId: true, teamId: true },
    })
    if (!project || project.userId !== decoded.userId) {
      return NextResponse.json(
        { error: 'Project not found. You can only share projects you own.' },
        { status: 404 }
      )
    }
    if (project.teamId === teamId) {
      return NextResponse.json({ message: 'Project is already shared with this team' })
    }

    await db.project.update({ where: { id: projectId }, data: { teamId } })

    await logAudit({
      userId: decoded.userId,
      action: 'team.project_add',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { teamId, previousTeamId: project.teamId },
    })

    // Let members know a project appeared in their list.
    await Promise.all(
      team.members
        .filter((m) => m.userId !== decoded.userId)
        .map((m) =>
          createNotification({
            userId: m.userId,
            title: 'Project shared with your team',
            message: `${project.name} is now shared with ${team.name}.`,
            type: 'info',
            link: '/?tab=hosting',
          }).catch(() => {})
        )
    )

    return NextResponse.json({ message: 'Project shared with the team' }, { status: 201 })
  } catch (error) {
    console.error('Add team project error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> }
) {
  try {
    const decoded = await auth(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { teamId } = await params
    const projectId = new URL(request.url).searchParams.get('projectId') || ''
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 })
    }

    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, userId: true, teamId: true },
    })
    const myRole = await teamRole(teamId, decoded.userId)
    if (!project || project.teamId !== teamId || (!myRole && project.userId !== decoded.userId)) {
      return NextResponse.json({ error: 'Project not found in this team' }, { status: 404 })
    }
    const isProjectOwner = project.userId === decoded.userId
    if (!isProjectOwner && myRole !== 'owner' && myRole !== 'admin') {
      return NextResponse.json(
        { error: 'Only the project owner or a team owner/admin can remove it from the team.' },
        { status: 403 }
      )
    }

    await db.project.update({ where: { id: projectId }, data: { teamId: null } })

    await logAudit({
      userId: decoded.userId,
      action: 'team.project_remove',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { teamId },
    })

    return NextResponse.json({ message: 'Project removed from the team' })
  } catch (error) {
    console.error('Remove team project error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
