/**
 * GET  /api/templates/[id]/reviews — list reviews for a template
 * POST /api/templates/[id]/reviews — add a review (with rating)
 *
 * Review body: { rating: 1-5, title: string, body: string }
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { sanitizeError } from '@/lib/security'

/**
 * GET /api/templates/[id]/reviews?page=1&limit=10&sort=recent|helpful|rating
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { searchParams } = new URL(request.url)
    const page = Math.max(parseInt(searchParams.get('page') || '1', 10), 1)
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 50)
    const sort = searchParams.get('sort') || 'recent'
    const skip = (page - 1) * limit

    let orderBy: Record<string, 'asc' | 'desc'>
    switch (sort) {
      case 'helpful': orderBy = { helpfulCount: 'desc' }; break
      case 'rating':  orderBy = { rating: 'desc' }; break
      case 'recent':
      default:        orderBy = { createdAt: 'desc' }; break
    }

    const [reviews, total] = await Promise.all([
      db.templateReview.findMany({
        where: { templateId: id, status: 'published' },
        include: {
          user: { select: { id: true, name: true, email: true, avatar: true } },
        },
        orderBy,
        skip,
        take: limit,
      }),
      db.templateReview.count({ where: { templateId: id, status: 'published' } }),
    ])

    return NextResponse.json({
      reviews: reviews.map((r) => ({
        id: r.id,
        rating: r.rating,
        title: r.title,
        body: r.body,
        helpfulCount: r.helpfulCount,
        createdAt: r.createdAt.toISOString(),
        user: {
          name: r.user.name,
          avatar: r.user.avatar,
          // Mask email for privacy
          email: r.user.email.replace(/^(.).*@(.*$)/, '$1***@$2'),
        },
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    })
  } catch (error) {
    console.error('[templates/reviews GET] error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/templates/[id]/reviews
 * Body: { rating: 1-5, title: string, body: string }
 */
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
    const { rating, title, body: reviewBody } = body

    // Validation
    const ratingNum = Number(rating)
    if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
      return NextResponse.json({ error: 'Rating must be 1-5' }, { status: 400 })
    }
    if (!title || typeof title !== 'string' || title.trim().length < 3) {
      return NextResponse.json({ error: 'Title must be at least 3 characters' }, { status: 400 })
    }
    if (!reviewBody || typeof reviewBody !== 'string' || reviewBody.trim().length < 10) {
      return NextResponse.json({ error: 'Review must be at least 10 characters' }, { status: 400 })
    }
    if (reviewBody.length > 5000) {
      return NextResponse.json({ error: 'Review must be under 5000 characters' }, { status: 400 })
    }

    // Check template
    const template = await db.template.findFirst({
      where: { id, status: { in: ['approved', 'featured'] } },
    })
    if (!template) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

    if (template.submittedById === decoded.userId) {
      return NextResponse.json({ error: 'You cannot review your own template' }, { status: 403 })
    }

    // Check if user already reviewed (one review per user per template)
    const existingReview = await db.templateReview.findFirst({
      where: { templateId: id, userId: decoded.userId },
    })
    if (existingReview) {
      return NextResponse.json({ error: 'You have already reviewed this template. Edit your existing review instead.' }, { status: 409 })
    }

    // Create review
    const review = await db.templateReview.create({
      data: {
        templateId: id,
        userId: decoded.userId,
        rating: ratingNum,
        title: title.trim(),
        body: reviewBody.trim(),
      },
    })

    // Also upsert the rating (reviews include a rating)
    const existingRating = await db.templateRating.findUnique({
      where: { templateId_userId: { templateId: id, userId: decoded.userId } },
    })
    if (existingRating) {
      const oldR = existingRating.rating
      await db.templateRating.update({
        where: { id: existingRating.id },
        data: { rating: ratingNum },
      })
      await db.template.update({
        where: { id },
        data: { ratingSum: template.ratingSum - oldR + ratingNum },
      })
    } else {
      await db.templateRating.create({
        data: { templateId: id, userId: decoded.userId, rating: ratingNum },
      })
      await db.template.update({
        where: { id },
        data: {
          ratingCount: template.ratingCount + 1,
          ratingSum: template.ratingSum + ratingNum,
        },
      })
    }

    return NextResponse.json({
      review: {
        id: review.id,
        rating: review.rating,
        title: review.title,
        body: review.body,
        createdAt: review.createdAt.toISOString(),
      },
      message: 'Review published',
    }, { status: 201 })
  } catch (error) {
    console.error('[templates/reviews POST] error:', error)
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 })
  }
}
