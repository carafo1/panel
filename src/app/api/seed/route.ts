import { NextResponse } from 'next/server'
import { seedDatabase } from '@/lib/seed'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { isAdmin } from '@/lib/security'

/**
 * POST /api/seed
 *
 * SECURITY: Requires admin auth. Previously unauthenticated — anyone could
 * trigger a DB re-seed.
 */
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json(
        { error: 'Admin authorization required' },
        { status: 401 }
      )
    }
    const decoded = verifyToken(token)
    if (!decoded || !isAdmin(decoded.role)) {
      return NextResponse.json(
        { error: 'Admin privileges required' },
        { status: 403 }
      )
    }

    await seedDatabase()
    return NextResponse.json({ success: true, message: 'Database seeded successfully' })
  } catch (error) {
    console.error('Seed error:', error)
    return NextResponse.json(
      { error: 'Failed to seed database' },
      { status: 500 }
    )
  }
}
