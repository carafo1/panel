import { NextResponse } from 'next/server'
import { getStatusPage } from '@/lib/status'

/** GET /api/status — public platform status (no sign-in). */
export async function GET() {
  try {
    return NextResponse.json(await getStatusPage(), { headers: { 'Cache-Control': 'public, max-age=30' } })
  } catch (error) {
    console.error('[status] failed:', error)
    return NextResponse.json({ error: 'Status is temporarily unavailable' }, { status: 503 })
  }
}
