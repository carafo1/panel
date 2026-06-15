import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
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

    const decoded = verifyToken(token)
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

    const body = await request.json()
    const { email, role } = body

    if (!email || typeof email !== 'string' || email.trim().length === 0) {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 })
    }

    const invitedEmail = email.trim().toLowerCase()

    // Look up user by email
    const targetUser = await db.user.findUnique({
      where: { email: invitedEmail },
    })

    if (!targetUser) {
      return NextResponse.json({ error: 'User not found with this email' }, { status: 404 })
    }

    // Check if already a member
    const existingMember = team.members.find((m) => m.userId === targetUser.id)
    if (existingMember) {
      return NextResponse.json({ error: 'User is already a member of this team' }, { status: 409 })
    }

    const memberRole = role === 'admin' ? 'admin' : 'developer'

    const newMember = await db.teamMember.create({
      data: {
        teamId,
        userId: targetUser.id,
        role: memberRole,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatar: true },
        },
      },
    })

    // Create notification for the invited user
    await createNotification({
      userId: targetUser.id,
      title: 'Team Invitation',
      message: `You've been invited to join ${team.name}`,
      type: 'info',
    })

    // Send the real team-invitation email.
    // We use the new member's id as the invite token (unique + traceable).
    // In demo mode (no SMTP env vars) this simply logs to console.
    const inviteToken = crypto
      .createHash('sha256')
      .update(`${newMember.id}:${team.id}:${Date.now()}`)
      .digest('hex')
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const inviteUrl = `${appUrl}?team_invite=${inviteToken}`

    console.log(`[email] Team invitation for ${targetUser.email}`)
    console.log(`[email] Invite link: ${inviteUrl}`)

    await sendTeamInvitationEmail(targetUser.email, team.name, inviteUrl)

    return NextResponse.json({
      member: {
        id: newMember.id,
        userId: newMember.userId,
        role: newMember.role,
        joinedAt: newMember.joinedAt.toISOString(),
        user: newMember.user,
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Invite member error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
