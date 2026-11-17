import { NextResponse } from 'next/server'
import { listPublished, suggestArticles, HELP_CATEGORIES } from '@/lib/help'
import { withRateLimit } from '@/lib/rate-limit'

/**
 * GET /api/help              published articles (public)
 * GET /api/help?q=...        search
 * GET /api/help?suggest=...  up to 3 articles matching free text (new-ticket form)
 */
async function getHandler(request: Request) {
  const sp = new URL(request.url).searchParams
  const suggest = sp.get('suggest')
  const articles = suggest !== null ? await suggestArticles(suggest.slice(0, 500)) : await listPublished(sp.get('q') || undefined)
  return NextResponse.json({ articles, categories: HELP_CATEGORIES }, { headers: { 'Cache-Control': 'public, max-age=60' } })
}

export const GET = withRateLimit(getHandler, { limit: 60, windowMs: 60_000 })
