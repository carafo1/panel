import { NextResponse } from 'next/server'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { listAppTools, runAppTool, appToolPermission } from '@/lib/vps/app-tools'
import { SiteToolError } from '@/lib/vps/wordpress'

/**
 * GET  /api/hosting/[id]/app-tools   the stack's maintenance commands
 * POST /api/hosting/[id]/app-tools   { tool }  run one ("__log" = tail the app log)
 *
 * Only catalogue commands can run (lib/vps/app-tools.ts); each declares the
 * project permission it needs.
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
    return NextResponse.json(await listAppTools(id))
  } catch (error) {
    return failure(error, '[app-tools] GET failed:')
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const decoded = await auth(request)
    if (!decoded) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    const { id } = await params
    const body = (await request.json().catch(() => null)) as { tool?: unknown } | null
    const toolId = typeof body?.tool === 'string' ? body.tool : ''

    const permission = toolId ? await appToolPermission(id, toolId) : null
    if (!permission) return NextResponse.json({ error: 'Unknown tool' }, { status: 400 })
    const access = await requireProjectAccess(decoded, id, permission)
    if (!access.ok) return access.response

    const result = await runAppTool(id, toolId)

    if (permission !== 'view') {
      await logAudit({
        userId: decoded.userId,
        action: `project.app_tool.${toolId}`,
        resource: 'project',
        resourceId: id,
        req: request,
        status: result.exitCode === 0 ? 'success' : 'failure',
        metadata: { exitCode: result.exitCode, ...(decoded.impersonatedBy ? { impersonatedBy: decoded.impersonatedBy } : {}) },
      }).catch(() => {})
    }
    return NextResponse.json(result)
  } catch (error) {
    return failure(error, '[app-tools] POST failed:')
  }
}
