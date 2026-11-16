import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  verifyTokenFresh,
  extractTokenFromHeader,
  hashPassword,
  verifyPassword,
  revokeAllSessions,
  issueSession,
} from '@/lib/auth'
import { attachSession } from '@/lib/session'

export async function PATCH(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { currentPassword, newPassword } = body

    if (!currentPassword || !newPassword) {
      return NextResponse.json(
        { error: 'Current password and new password are required' },
        { status: 400 }
      )
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: 'New password must be at least 8 characters' },
        { status: 400 }
      )
    }

    // Get current user with password
    const user = await db.user.findUnique({
      where: { id: decoded.userId },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    // Verify current password
    const isValid = await verifyPassword(currentPassword, user.password)
    if (!isValid) {
      return NextResponse.json(
        { error: 'Current password is incorrect' },
        { status: 400 }
      )
    }

    // Hash and save new password
    const hashedPassword = await hashPassword(newPassword)
    await db.user.update({
      where: { id: decoded.userId },
      data: { password: hashedPassword },
    })

    // A password change is often a response to suspected compromise: end
    // every other login (any device, any copied token) and keep only this one,
    // on a fresh session.
    await revokeAllSessions(decoded.userId, 'password_change')
    const fresh = await issueSession(
      { userId: decoded.userId, email: decoded.email, role: decoded.role },
      request
    )

    return attachSession(
      NextResponse.json({ message: 'Password updated. You have been signed out on all other devices.' }),
      fresh,
      request
    )
  } catch (error) {
    console.error('Change password error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
