import { NextResponse } from 'next/server'
import { getFullSiteContent } from '@/lib/cms'

/**
 * GET /api/site/content
 *
 * Public endpoint returning the full CMS payload (published services +
 * global site text) for rendering the marketing site. Auto-seeds the DB
 * from static data on first run.
 */
export async function GET() {
  try {
    const content = await getFullSiteContent()
    return NextResponse.json(content, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60',
      },
    })
  } catch (error) {
    console.error('[/api/site/content] error:', error)
    return NextResponse.json(
      { error: 'Failed to load site content' },
      { status: 500 }
    )
  }
}
