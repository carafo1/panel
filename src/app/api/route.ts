import { NextResponse } from 'next/server'
import { seedDatabase } from '@/lib/seed'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { isAdmin } from '@/lib/security'

/**
 * GET /api
 *
 * SECURITY: This endpoint triggers a full database re-seed (writes plans,
 * servers, admin user). It MUST require admin auth. Previously it was
 * unauthenticated — anyone could hit `curl /api` and wipe/reset the DB.
 *
 * Auth: Bearer JWT with role='admin' or 'super_admin'.
 */
export async function GET(request: Request) {
  try {
    // SECURITY: require admin auth
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json(
        { error: 'Admin authorization required' },
        { status: 401 }
      )
    }
    const decoded = await verifyTokenFresh(token)
    if (!decoded || !isAdmin(decoded.role)) {
      return NextResponse.json(
        { error: 'Admin privileges required' },
        { status: 403 }
      )
    }

    await seedDatabase()
    return NextResponse.json({ message: 'Database seeded successfully' })
  } catch (error) {
    console.error('Seed error:', error)
    return NextResponse.json(
      { error: 'Failed to seed database' },
      { status: 500 }
    )
  }
}
