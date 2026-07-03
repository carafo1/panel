/**
 * POST /api/templates/[id]/rate
 * Rate a template (1-5 stars). One rating per user per template.
 *
 * Body: { rating: number }  (1-5)
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { sanitizeError } from '@/lib/security'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) return NextResponse.json({ error: 'Authorization required' }, { status: 401 })
    const decoded = verifyToken(token)
    if (!decoded) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const { id } = await params
    const body = await request.json()
    const rating = Number(body.rating)

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return NextResponse.json({ error: 'Rating must be an integer 1-5' }, { status: 400 })
    }

    const template = await db.template.findFirst({
      where: { id, status: { in: ['approved', 'featured'] } },
    })
    if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

    if (template.submittedById === decoded.userId) {
      return NextResponse.json({ error: 'You cannot rate your own template' }, { status: 403 })
    }

    const existing = await db.templateRating.findUnique({
      where: { templateId_userId: { templateId: id, userId: decoded.userId } },
    })

    let oldRating = 0
    if (existing) {
      oldRating = existing.rating
      await db.templateRating.update({
        where: { id: existing.id },
        data: { rating },
      })
    } else {
      await db.templateRating.create({
        data: { templateId: id, userId: decoded.userId, rating },
      })
    }

    const newRatingCount = existing ? template.ratingCount : template.ratingCount + 1
    const newRatingSum = template.ratingSum - oldRating + rating
    await db.template.update({
      where: { id },
      data: { ratingCount: newRatingCount, ratingSum: newRatingSum },
    })

    return NextResponse.json({
      rating,
      avgRating: (newRatingSum / newRatingCount).toFixed(1),
      ratingCount: newRatingCount,
      message: existing ? 'Rating updated' : 'Rating added',
    })
  } catch (error) {
    console.error('[templates/rate] error:', error)
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 })
  }
}

/**
 * GET /api/templates/[id]/rate — current user's rating
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) return NextResponse.json({ error: 'Authorization required' }, { status: 401 })
    const decoded = verifyToken(token)
    if (!decoded) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

    const { id } = await params
    const rating = await db.templateRating.findUnique({
      where: { templateId_userId: { templateId: id, userId: decoded.userId } },
      select: { rating: true, updatedAt: true },
    })

    return NextResponse.json({ rating: rating?.rating ?? null })
  } catch (error) {
    console.error('[templates/rate GET] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
