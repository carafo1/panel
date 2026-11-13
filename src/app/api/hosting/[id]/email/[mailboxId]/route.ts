import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { requireProjectAccess } from '@/lib/project-access'
import { encrypt } from '@/lib/encryption'
import { deleteMailbox as mailcowDeleteMailbox } from '@/lib/mailcow'

/**
 * Project Email Mailbox Endpoint (single)
 * =========================================
 *
 *   PATCH   /api/hosting/[id]/email/[mailboxId]
 *              body: { password?, quota?, active? }
 *              — update the mailbox password (re-encrypted), quota, or active
 *                flag. Any subset of fields may be supplied.
 *
 *   DELETE  /api/hosting/[id]/email/[mailboxId]
 *              — delete the mailbox row and best-effort remove it from Mailcow.
 *
 * Access: the caller needs 'data' on the project in the URL (owner, platform
 * admin, team owner/admin). The mailbox is then verified to belong to that
 * project: its Domain must be owned by the project's owner (Domain.userId)
 * AND be linked to the project — either Domain.projectId, or its name is one
 * of the project's domains (customDomain / WebsiteDomain rows), the same set
 * the list endpoint shows. Without the project check a team member with
 * access to one project could reach the owner's mailboxes on every domain.
 */

function maskPassword(_encrypted: string): string {
  return '••••••••'
}

const normaliseDomain = (value: string) => value.toLowerCase().trim().replace(/\.+$/, '')

async function loadProjectMailbox(mailboxId: string, projectId: string, ownerId: string) {
  const mailbox = await db.emailMailbox.findUnique({
    where: { id: mailboxId },
    include: { domain: { select: { id: true, userId: true, name: true, projectId: true } } },
  })
  if (!mailbox) return null
  if (!mailbox.domain || mailbox.domain.userId !== ownerId) return null
  if (mailbox.domain.projectId === projectId) return mailbox

  const [project, websiteDomains] = await Promise.all([
    db.project.findUnique({ where: { id: projectId }, select: { customDomain: true } }),
    db.websiteDomain.findMany({ where: { projectId }, select: { domain: true } }),
  ])
  const names = new Set<string>()
  if (project?.customDomain) names.add(normaliseDomain(project.customDomain))
  for (const r of websiteDomains) if (r.domain) names.add(normaliseDomain(r.domain))
  return names.has(normaliseDomain(mailbox.domain.name)) ? mailbox : null
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; mailboxId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, mailboxId } = await params

    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response

    const mailbox = await loadProjectMailbox(mailboxId, projectId, access.ownerId)
    if (!mailbox) {
      return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const data: {
      password?: string
      quota?: number
      active?: boolean
    } = {}

    let plaintextPassword: string | null = null

    if (typeof body.password === 'string' && body.password.length > 0) {
      if (body.password.length < 8) {
        return NextResponse.json(
          { error: 'Password must be at least 8 characters long.' },
          { status: 400 }
        )
      }
      data.password = encrypt(body.password)
      plaintextPassword = body.password
    }

    if (typeof body.quota === 'number') {
      if (body.quota <= 0 || body.quota > 50 * 1024 * 1024 * 1024) {
        return NextResponse.json(
          { error: 'Quota must be between 1 byte and 50 GB.' },
          { status: 400 }
        )
      }
      data.quota = Math.floor(body.quota)
    }

    if (typeof body.active === 'boolean') {
      data.active = body.active
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: 'No updatable fields supplied (password, quota, active).' },
        { status: 400 }
      )
    }

    const updated = await db.emailMailbox.update({
      where: { id: mailboxId },
      data,
    })

    await logAudit({
      userId: decoded.userId,
      action: 'project.email.mailbox.update',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: {
        mailboxId,
        address: updated.address,
        updatedFields: Object.keys(data),
      },
    })

    return NextResponse.json({
      mailbox: {
        id: updated.id,
        address: updated.address,
        localPart: updated.localPart,
        domainId: updated.domainId,
        domainName: mailbox.domain.name,
        password: maskPassword(updated.password),
        // Only present when the caller changed the password. Returned ONCE so
        // the UI can show the "save these credentials" dialog.
        plaintextPassword,
        quota: updated.quota,
        active: updated.active,
        isDefault: updated.isDefault,
        mailcowId: updated.mailcowId || null,
        dkimEnabled: updated.dkimEnabled,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Patch email mailbox error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; mailboxId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, mailboxId } = await params

    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response

    const mailbox = await loadProjectMailbox(mailboxId, projectId, access.ownerId)
    if (!mailbox) {
      return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
    }

    // Best-effort: ask Mailcow to delete the mailbox. Demo mode returns
    // simulated success. Failures don't block the DB row deletion because the
    // DB is the source of truth for what the user sees.
    try {
      await mailcowDeleteMailbox(mailbox.address)
    } catch (err) {
      console.warn('[email] mailcow deleteMailbox failed (continuing):', err)
    }

    await db.emailMailbox.delete({ where: { id: mailboxId } })

    await logAudit({
      userId: decoded.userId,
      action: 'project.email.mailbox.delete',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { mailboxId, address: mailbox.address },
    })

    return NextResponse.json({ message: 'Mailbox deleted' })
  } catch (error) {
    console.error('Delete email mailbox error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
