import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // Check admin role (super_admin OR admin - backward compatible)
    if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const [
      totalUsers,
      totalProjects,
      totalDomains,
      totalServers,
      paymentStats,
      activeProjects,
    ] = await Promise.all([
      db.user.count(),
      db.project.count(),
      db.domain.count(),
      db.server.count(),
      db.payment.aggregate({
        _sum: { amount: true },
        _count: true,
        where: { status: 'completed' },
      }),
      db.project.count({ where: { status: 'running' } }),
    ])

    // Get recent signups (last 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const recentSignups = await db.user.count({
      where: { createdAt: { gte: thirtyDaysAgo } },
    })

    // Get active subscriptions
    const activeSubscriptions = await db.subscription.count({
      where: { status: 'active' },
    })

    // Get monthly revenue (current month)
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
    const monthlyRevenue = await db.payment.aggregate({
      _sum: { amount: true },
      where: {
        status: 'completed',
        createdAt: { gte: monthStart },
      },
    })

    return NextResponse.json({
      stats: {
        totalUsers,
        recentSignups,
        totalProjects,
        activeProjects,
        totalDomains,
        totalServers,
        activeSubscriptions,
        totalRevenue: paymentStats._sum.amount || 0,
        totalPayments: paymentStats._count,
        monthlyRevenue: monthlyRevenue._sum.amount || 0,
      },
    })
  } catch (error) {
    console.error('Admin stats error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
