import { NextResponse } from 'next/server'
import { requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { listAllForStaff, createArticle, HelpError } from '@/lib/help'

/** GET /api/admin/help — every article, drafts included.  POST — create one. */
export async function GET(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  return NextResponse.json({ articles: await listAllForStaff() })
}

export async function POST(request: Request) {
  const auth = await requireAdminRole(request)
  if (!auth) return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  try {
    const article = await createArticle(auth.userId, await request.json().catch(() => ({})))
    await logAudit({ userId: auth.userId, action: 'admin.help.create', resource: 'help_article', resourceId: article.id, req: request, status: 'success', metadata: { slug: article.slug } })
    return NextResponse.json({ article }, { status: 201 })
  } catch (error) {
    if (error instanceof HelpError) return NextResponse.json({ error: error.message }, { status: error.status })
    console.error('[help] create failed:', error)
    return NextResponse.json({ error: 'Could not save the article' }, { status: 500 })
  }
}
