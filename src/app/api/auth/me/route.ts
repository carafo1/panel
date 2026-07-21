import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'

export async function GET(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const user = await db.user.findUnique({
      where: { id: decoded.userId },
      include: {
        subscriptions: {
          include: { plan: true },
          orderBy: { createdAt: 'desc' },
        },
      },
    })

    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    // Account standing is re-checked here, not just at login. Tokens live for
    // 7 days, so without this a user suspended mid-session would keep full
    // access until their token happened to expire. Every page load calls this
    // endpoint, so a 401 here ends the session promptly.
    const accountStatus = (user as { status?: string }).status || 'active'
    if (accountStatus !== 'active') {
      return NextResponse.json(
        {
          error:
            accountStatus === 'closed'
              ? 'This account has been closed.'
              : 'Your account is not active. Please contact support.',
          accountStatus,
        },
        { status: 401 }
      )
    }

    return NextResponse.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        // Deliberately the DB role, not the role baked into the token: a
        // promotion or demotion must take effect on the next page load
        // rather than whenever the 7-day token expires.
        role: user.role,
        accountStatus,
        avatar: user.avatar,
        emailVerified: user.emailVerified,
        twoFactorEnabled: user.twoFactorEnabled,
        createdAt: user.createdAt,
        subscriptions: user.subscriptions.map((sub) => ({
          id: sub.id,
          status: sub.status,
          currentPeriodStart: sub.currentPeriodStart,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
          plan: sub.plan,
        })),
      },
    })
  } catch (error) {
    console.error('Get current user error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
