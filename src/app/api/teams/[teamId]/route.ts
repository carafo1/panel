import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const { teamId } = await params

    const team = await db.team.findUnique({
      where: { id: teamId },
      include: {
        members: {
          include: {
            user: {
              select: { id: true, name: true, email: true, avatar: true },
            },
          },
          orderBy: { joinedAt: 'asc' },
        },
        projects: {
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            framework: true,
            subdomain: true,
            createdAt: true,
          },
        },
        owner: {
          select: { id: true, name: true, email: true },
        },
      },
    })

    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }

    // Verify user is a member
    const membership = team.members.find((m) => m.userId === decoded.userId)
    if (!membership) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 })
    }

    return NextResponse.json({
      team: {
        id: team.id,
        name: team.name,
        slug: team.slug,
        ownerId: team.ownerId,
        owner: team.owner,
        yourRole: membership.role,
        members: team.members.map((m) => ({
          id: m.id,
          userId: m.userId,
          role: m.role,
          joinedAt: m.joinedAt.toISOString(),
          user: m.user,
        })),
        projects: team.projects.map((p) => ({
          ...p,
          createdAt: p.createdAt.toISOString(),
        })),
        createdAt: team.createdAt.toISOString(),
        updatedAt: team.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Get team error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const { teamId } = await params

    const team = await db.team.findUnique({
      where: { id: teamId },
      include: { members: true },
    })

    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }

    // Only owner or admin can update
    const membership = team.members.find((m) => m.userId === decoded.userId)
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return NextResponse.json({ error: 'Only owner or admin can update team' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { name } = body

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: 'Team name is required' }, { status: 400 })
    }

    const updated = await db.team.update({
      where: { id: teamId },
      data: { name: name.trim() },
    })

    return NextResponse.json({
      team: {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        updatedAt: updated.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Update team error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ teamId: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const { teamId } = await params

    const team = await db.team.findUnique({
      where: { id: teamId },
    })

    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }

    // Only owner can delete
    if (team.ownerId !== decoded.userId) {
      return NextResponse.json({ error: 'Only the owner can delete the team' }, { status: 403 })
    }

    await db.team.delete({ where: { id: teamId } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Delete team error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
