import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh } from '@/lib/auth'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string; memberId: string }> }
) {
  try {
    const { teamId, memberId } = await params
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.split(' ')[1]
    const payload = await verifyTokenFresh(token)
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { role } = body

    if (!role || !['admin', 'developer', 'viewer'].includes(role)) {
      return NextResponse.json({ error: 'Valid role is required (admin, developer, viewer)' }, { status: 400 })
    }

    // Check if user is team owner
    const team = await db.team.findUnique({ where: { id: teamId } })
    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }

    if (team.ownerId !== payload.userId) {
      return NextResponse.json({ error: 'Only the team owner can change roles' }, { status: 403 })
    }

    // Don't allow changing the owner's role
    const member = await db.teamMember.findUnique({ where: { id: memberId } })
    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 })
    }

    if (member.role === 'owner') {
      return NextResponse.json({ error: 'Cannot change owner role' }, { status: 400 })
    }

    const updatedMember = await db.teamMember.update({
      where: { id: memberId },
      data: { role },
    })

    return NextResponse.json({ member: updatedMember })
  } catch (error) {
    console.error('Error updating team member:', error)
    return NextResponse.json({ error: 'Failed to update team member' }, { status: 500 })
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ teamId: string; memberId: string }> }
) {
  try {
    const { teamId, memberId } = await params
    const authHeader = req.headers.get('authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const token = authHeader.split(' ')[1]
    const payload = await verifyTokenFresh(token)
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Get the member to remove
    const member = await db.teamMember.findUnique({ where: { id: memberId } })
    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 })
    }

    // Check permissions: owner/admin can remove others, any member can remove themselves
    const team = await db.team.findUnique({ where: { id: teamId } })
    if (!team) {
      return NextResponse.json({ error: 'Team not found' }, { status: 404 })
    }

    const requesterMember = await db.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: payload.userId } },
    })

    const isOwner = team.ownerId === payload.userId
    const isAdmin = requesterMember?.role === 'admin'
    const isSelf = member.userId === payload.userId

    if (!isOwner && !isAdmin && !isSelf) {
      return NextResponse.json({ error: 'Not authorized to remove this member' }, { status: 403 })
    }

    // Don't allow removing the owner
    if (member.role === 'owner') {
      return NextResponse.json({ error: 'Cannot remove team owner' }, { status: 400 })
    }

    await db.teamMember.delete({ where: { id: memberId } })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error removing team member:', error)
    return NextResponse.json({ error: 'Failed to remove team member' }, { status: 500 })
  }
}
