import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { semanticSearch, isPgvectorEnabled } from '@/lib/embeddings'

/**
 * GET /api/assistant/search?q=<query>&limit=<n>
 *
 * Direct semantic search across the user's projects, deployments, and audit
 * logs. Returns ranked results with similarity scores.
 *
 * Requires authentication. Uses pgvector when available, falls back to
 * keyword search on SQLite.
 */
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    }
    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const { searchParams } = new URL(request.url)
    const query = searchParams.get('q') || ''
    const limit = Math.min(parseInt(searchParams.get('limit') || '10', 10), 50)

    if (!query.trim()) {
      return NextResponse.json({ error: 'Query parameter "q" is required' }, { status: 400 })
    }

    const pgvectorReady = await isPgvectorEnabled()
    const results = await semanticSearch(decoded.userId, query, limit)

    return NextResponse.json({
      query,
      engine: pgvectorReady ? 'pgvector' : 'keyword-fallback',
      count: results.length,
      results: results.map((r) => ({
        id: r.id,
        table: r.table,
        similarity: Math.max(0, 1 - r.score),  // convert distance to similarity
        data: r.data,
      })),
    })
  } catch (error) {
    console.error('[Assistant Search API Error]', error)
    return NextResponse.json({ error: 'Search failed' }, { status: 500 })
  }
}
