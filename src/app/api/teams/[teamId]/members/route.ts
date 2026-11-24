import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { createNotification } from '@/lib/notifications'
import { sendTeamInvitationEmail } from '@/lib/email'
import crypto from 'crypto'

export async function POST(
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

    // Only owner or admin can invite
    const membership = team.members.find((m) => m.userId === decoded.userId)
    if (!membership || (membership.role !== 'owner' && membership.role !== 'admin')) {
      return NextResponse.json({ error: 'Only owner or admin can invite members' }, { status: 403 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { email, role } = body

    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const invitedEmail = email.trim().toLowerCase()

    if (invitedEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(invitedEmail)) {
      return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 })
    }

    // viewer: read-only access to the team's projects (see lib/project-access).
    const memberRole = role === 'admin' || role === 'viewer' ? role : 'developer'

    // The answer is the same whether or not an account exists for this
    // email, so the endpoint cannot be used to discover who is registered.
    // (It used to answer 404 "User not found with this email".)
    const uniform = NextResponse.json(
      {
        message:
          'If an account exists for this email address, it has been added to the team and notified by email.',
      },
      { status: 202 }
    )

    const targetUser = await db.user.findUnique({
      where: { email: invitedEmail },
      select: { id: true, email: true },
    })
    if (!targetUser) return uniform

    // Already a member: the inviter can see the member list anyway, so this
    // reveals nothing new — but keep the same answer to stay uniform.
    if (team.members.some((m) => m.userId === targetUser.id)) return uniform

    // NOTE: membership is still granted immediately (there is no pending
    // invitation model in the schema). A consent step with a single-use,
    // expiring token needs a schema change.
    const newMember = await db.teamMember.create({
      data: {
        teamId,
        userId: targetUser.id,
        role: memberRole,
      },
    })

    await createNotification({
      userId: targetUser.id,
      title: 'Team Invitation',
      message: `You've been added to the team ${team.name}`,
      type: 'info',
    })

    const inviteToken = crypto
      .createHash('sha256')
      .update(`${newMember.id}:${team.id}:${Date.now()}`)
      .digest('hex')
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const inviteUrl = `${appUrl}?team_invite=${inviteToken}`

    // Not awaited: the response time must not depend on whether a mail was
    // sent (another way to tell registered addresses apart).
    void sendTeamInvitationEmail(targetUser.email, team.name, inviteUrl).catch((err) =>
      console.error('[teams] invitation email failed:', err instanceof Error ? err.message : err)
    )

    return uniform
  } catch (error) {
    console.error('Invite member error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
