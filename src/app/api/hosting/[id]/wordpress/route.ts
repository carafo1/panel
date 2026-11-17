import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import {
  getWordPressOverview,
  runWordPressAction,
  wpActionPermission,
  WP_ACTIONS,
  SiteToolError,
  type WpActionInput,
} from '@/lib/vps/wordpress'

/**
 * GET  /api/hosting/[id]/wordpress   core, plugins, themes, maintenance/debug state
 * POST /api/hosting/[id]/wordpress   { action, slug?, activate?, from?, to?, dryRun?, user? }
 *
 * WordPress management via WP-CLI (lib/vps/wordpress.ts). Reading needs
 * 'view'; changes need 'configure', search-replace 'data', and resetting the
 * admin password 'owner'.
 */

async function auth(request: Request) {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  return token ? verifyTokenFresh(token) : null
}

function failure(error: unknown, label: string) {
  if (error instanceof SiteToolError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error(label, error)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const decoded = await auth(request)
    if (!decoded) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    const { id } = await params
    const access = await requireProjectAccess(decoded, id, 'view')
    if (!access.ok) return access.response
    return NextResponse.json(await getWordPressOverview(id), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return failure(error, '[wordpress] GET failed:')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const decoded = await auth(request)
    if (!decoded) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    const { id } = await params

    const body = (await request.json().catch(() => null)) as Partial<WpActionInput> | null
    if (!body || typeof body.action !== 'string' || !WP_ACTIONS.includes(body.action as WpActionInput['action'])) {
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    }
    const input: WpActionInput = {
      action: body.action as WpActionInput['action'],
      slug: typeof body.slug === 'string' ? body.slug : undefined,
      activate: body.activate === true,
      from: typeof body.from === 'string' ? body.from : undefined,
      to: typeof body.to === 'string' ? body.to : undefined,
      dryRun: body.dryRun === true,
      user: typeof body.user === 'string' ? body.user : undefined,
    }

    const access = await requireProjectAccess(decoded, id, wpActionPermission(input.action))
    if (!access.ok) return access.response

    const result = await runWordPressAction(id, input)

    // Dry runs change nothing; everything else is recorded.
    if (!(input.action === 'search_replace' && input.dryRun)) {
      await logAudit({
        userId: decoded.userId,
        action: `project.wordpress.${input.action}`,
        resource: 'project',
        resourceId: id,
        req: request,
        metadata: {
          slug: input.slug,
          ...(input.action === 'search_replace' ? { from: input.from, to: input.to, replacements: result.replacements } : {}),
          ...(decoded.impersonatedBy ? { impersonatedBy: decoded.impersonatedBy } : {}),
        },
      }).catch(() => {})
    }

    return NextResponse.json(result)
  } catch (error) {
    return failure(error, '[wordpress] POST failed:')
  }
}
