import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { withRateLimit } from '@/lib/rate-limit'
import { parseSiteMailAction } from '@/lib/site-mail-config'
import {
  getSiteMailStatus,
  enableSiteMail,
  disableSiteMail,
  rotateSiteMailPassword,
  sendSiteMailTest,
  SiteMailError,
} from '@/lib/site-mail'
import { applySiteMailConfig, runSiteMailTestInContainer } from '@/lib/vps/deployer'

/**
 * Outgoing email for a WordPress / PHP website (its own Mailcow mailbox).
 *
 * GET  /api/hosting/[id]/mail                 status (never the password)
 * POST /api/hosting/[id]/mail  { action }
 *        enable   { fromAddress?: string|null, fromName?: string|null }
 *        disable
 *        rotate   new random mailbox password, pushed to the site
 *        test     send a test email to the project owner's account address
 *
 * GET and test need 'configure'; enable / disable / rotate change mailbox
 * credentials and need 'data' (the same as mailboxes and FTP accounts).
 */
function failure(error: unknown) {
  if (error instanceof SiteMailError) {
    const headers: Record<string, string> = error.status === 429 ? { 'Retry-After': '60' } : {}
    return NextResponse.json({ error: error.message }, { status: error.status, headers })
  }
  console.error('[site-mail] failed:', error instanceof Error ? error.message : error)
  return NextResponse.json({ error: 'Outgoing mail operation failed' }, { status: 500 })
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params
  const access = await requireProjectAccess(auth, id, 'configure')
  if (!access.ok) return access.response
  try {
    return NextResponse.json(await getSiteMailStatus(id), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return failure(error)
  }
}

async function postHandler(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  const { id } = await params

  let input
  try {
    const body = await request.json().catch(() => {
      throw new Error('Request body must be valid JSON')
    })
    input = parseSiteMailAction(body)
  } catch (error) {
    // Authorize before revealing anything about the project.
    const access = await requireProjectAccess(auth, id, 'configure')
    if (!access.ok) return access.response
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid request' }, { status: 400 })
  }

  const access = await requireProjectAccess(auth, id, input.action === 'test' ? 'configure' : 'data')
  if (!access.ok) return access.response
  if (input.action !== 'test' && auth.impersonatedBy) {
    return NextResponse.json({ error: 'Not available during support access' }, { status: 403 })
  }

  try {
    if (input.action === 'test') {
      const result = await sendSiteMailTest(id, (method, script, to) => runSiteMailTestInContainer(id, method, script, to))
      await logAudit({
        userId: auth.userId, action: 'project.mail.test', resource: 'project', resourceId: id, req: request,
        status: result.ok ? 'success' : 'failure', metadata: { via: result.via },
      })
      return NextResponse.json({ test: result, status: await getSiteMailStatus(id) })
    }

    if (input.action === 'enable') {
      await enableSiteMail(id, { fromAddress: input.fromAddress, fromName: input.fromName })
    } else if (input.action === 'disable') {
      await disableSiteMail(id)
    } else {
      await rotateSiteMailPassword(id)
    }
    const apply = await applySiteMailConfig(id)
    await logAudit({
      userId: auth.userId, action: `project.mail.${input.action}`, resource: 'project', resourceId: id, req: request,
      status: 'success',
      metadata: input.action === 'enable' && input.fromAddress !== undefined ? { fromAddress: input.fromAddress } : undefined,
    })
    return NextResponse.json({ apply, status: await getSiteMailStatus(id) })
  } catch (error) {
    return failure(error)
  }
}

export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })
