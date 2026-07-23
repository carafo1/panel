import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { IMPORT_SOURCES } from '@/lib/migration'
import { toMigrationView } from '@/lib/migration/view'

/**
 * Import dashboard feed.
 * =====================
 *
 *   GET /api/migrations?status=…&projectId=…&limit=…
 *
 * Returns every import the caller can see, newest first, plus the counters the
 * dashboard header shows. Admins see the whole platform; everyone else sees
 * imports for the projects they own.
 */

export const runtime = 'nodejs'

export async function GET(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const url = new URL(request.url)
    const status = url.searchParams.get('status')
    const projectId = url.searchParams.get('projectId')
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200)

    const scope = isAdmin(decoded.role)
      ? {}
      : { project: { userId: decoded.userId } }

    // "running" in the UI means anything not yet finished, which spans four
    // stored statuses — filtering on the literal string would hide an import
    // that is still detecting or verifying.
    const ACTIVE = ['pending', 'detecting', 'running', 'verifying']
    const statusFilter =
      !status || status === 'all'
        ? {}
        : status === 'running'
          ? { status: { in: ACTIVE } }
          : { status }

    const where = {
      ...scope,
      ...(projectId ? { projectId } : {}),
      ...statusFilter,
    }

    const [rows, counts] = await Promise.all([
      db.siteMigration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: {
          project: { select: { name: true, slug: true } },
          stages: { orderBy: { order: 'asc' } },
        },
      }),
      db.siteMigration.groupBy({
        by: ['status'],
        where: scope,
        _count: { _all: true },
      }),
    ])

    const byStatus: Record<string, number> = {}
    for (const c of counts) byStatus[c.status] = c._count._all

    const active = ['pending', 'detecting', 'running', 'verifying'].reduce(
      (sum, s) => sum + (byStatus[s] ?? 0),
      0
    )

    return NextResponse.json({
      migrations: rows.map((r) => toMigrationView(r as never)),
      counts: {
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
        active,
        completed: byStatus.completed ?? 0,
        failed: (byStatus.failed ?? 0) + (byStatus.rolled_back ?? 0),
        byStatus,
      },
      sources: IMPORT_SOURCES,
    })
  } catch (error) {
    console.error('List migrations error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
