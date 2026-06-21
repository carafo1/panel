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

    const servers = await db.server.findMany({
      include: {
        _count: {
          select: { projects: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      servers: servers.map((s) => ({
        id: s.id,
        name: s.name,
        ip: s.ip,
        provider: s.provider,
        status: s.status,
        cpuCores: s.cpuCores,
        ramGB: s.ramGB,
        storageGB: s.storageGB,
        bandwidthGB: s.bandwidthGB,
        usedRamGB: s.usedRamGB,
        usedStorageGB: s.usedStorageGB,
        region: s.region,
        projectCount: s._count.projects,
        ramUsagePercent: Math.round((s.usedRamGB / s.ramGB) * 100),
        storageUsagePercent: Math.round((s.usedStorageGB / s.storageGB) * 100),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    })
  } catch (error) {
    console.error('Admin servers error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
