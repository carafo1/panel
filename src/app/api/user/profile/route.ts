import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'

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

    const body = await request.json()
    const { name, email } = body

    // At least one field must be provided
    if (!name && !email) {
      return NextResponse.json(
        { error: 'At least one field (name or email) must be provided' },
        { status: 400 }
      )
    }

    // Validate email format if provided
    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailRegex.test(email)) {
        return NextResponse.json(
          { error: 'Invalid email format' },
          { status: 400 }
        )
      }

      // Check if email is already taken by another user
      const existingUser = await db.user.findUnique({ where: { email } })
      if (existingUser && existingUser.id !== decoded.userId) {
        return NextResponse.json(
          { error: 'Email is already in use' },
          { status: 409 }
        )
      }
    }

    // Build update data
    const updateData: { name?: string; email?: string; emailVerified?: boolean } = {}
    if (name) updateData.name = name
    if (email) {
      updateData.email = email
      // If email changes, set emailVerified to false
      const currentUser = await db.user.findUnique({ where: { id: decoded.userId } })
      if (currentUser && currentUser.email !== email) {
        updateData.emailVerified = false
      }
    }

    const user = await db.user.update({
      where: { id: decoded.userId },
      data: updateData,
    })

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        avatar: user.avatar,
        emailVerified: user.emailVerified,
      },
    })
  } catch (error) {
    console.error('Update profile error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
