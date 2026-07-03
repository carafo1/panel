/**
 * GET  /api/admin/templates?status=pending&page=1&limit=20
 *   - Lists templates by status for admin review
 *
 * PATCH /api/admin/templates/[id]
 *   - body: { action: "approve" | "reject" | "feature" | "unfeature", reason?: string }
 *   - Changes template status
 *
 * DELETE /api/admin/templates/[id]
 *   - Removes a template from the marketplace
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { isAdmin, sanitizeError } from '@/lib/security'
import { logAudit } from '@/lib/audit'

/**
 * GET /api/admin/templates?status=pending
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) return NextResponse.json({ error: 'Authorization required' }, { status: 401 })
    const decoded = verifyToken(token)
    if (!decoded || !isAdmin(decoded.role)) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }

    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'all'
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10), 1)
    const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100)
    const skip = (page - 1) * limit

    const where = status === 'all' ? {} : { status }
    const [templates, total] = await Promise.all([
      db.template.findMany({
        where,
        include: {
          submittedBy: { select: { id: true, name: true, email: true } },
          _count: { select: { ratings: true, reviews: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      db.template.count({ where }),
    ])

    return NextResponse.json({
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        slug: t.slug,
        description: t.description,
        category: t.category,
        framework: t.framework,
        icon: t.icon,
        author: t.author,
        status: t.status,
        isOfficial: t.isOfficial,
        version: t.version,
        repoUrl: t.repoUrl,
        demoUrl: t.demoUrl,
        license: t.license,
        installCount: t.installCount,
        avgRating: t.ratingCount > 0 ? (t.ratingSum / t.ratingCount).toFixed(1) : null,
        ratingCount: t.ratingCount,
        reviewCount: t._count.reviews,
        rejectedReason: t.rejectedReason,
        createdAt: t.createdAt.toISOString(),
        submittedBy: t.submittedBy
          ? { name: t.submittedBy.name, email: t.submittedBy.email }
          : null,
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    })
  } catch (error) {
    console.error('[admin/templates GET] error:', error)
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 })
  }
}
