import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { requireProjectAccess } from '@/lib/project-access'
import { encrypt } from '@/lib/encryption'
import {
  addDomain as mailcowAddDomain,
  createMailbox as mailcowCreateMailbox,
  generateDkim as mailcowGenerateDkim,
} from '@/lib/mailcow'

/**
 * Project Email Mailboxes Endpoint (collection)
 * ===============================================
 *
 *   GET  /api/hosting/[id]/email            — list all EmailMailbox rows for the
 *                                              project's domains (passwords masked).
 *   POST /api/hosting/[id]/email            — create a new mailbox.
 *            body: { localPart, domainName, password, quota? }
 *
 * Mailboxes are stored against the `Domain` model (a project's domains are
 * `project.customDomain` plus all `WebsiteDomain` rows). When the requested
 * domain doesn't yet exist in the Domain table, we create it on the fly
 * (status='active', emailHosted=true, projectId=project.id) so the mailbox
 * can be linked immediately.
 *
 * The plaintext password is only sent to Mailcow itself; at-rest storage is
 * always AES-256-GCM encrypted via `encrypt()`.
 */

const DEFAULT_QUOTA_BYTES = 1024 * 1024 * 1024 // 1 GB

function maskPassword(_encrypted: string): string {
  // We can't decrypt here just to mask — return a generic mask. The reveal
  // flow (PATCH with a new password) is the only time plaintext is shown.
  return '••••••••'
}

function normaliseDomain(value: string): string {
  return value.toLowerCase().trim().replace(/\.+$/, '')
}

function isValidLocalPart(localPart: string): boolean {
  if (!localPart) return false
  if (localPart.length > 64) return false
  // RFC 5321 "dot-string" — alphanumeric + selected specials, no leading/trailing dot, no double dots.
  return (
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(localPart) &&
    !localPart.startsWith('.') &&
    !localPart.endsWith('.') &&
    !localPart.includes('..')
  )
}

function isValidDomain(domain: string): boolean {
  if (!domain) return false
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain) && domain.length <= 253
}

/**
 * Collect every domain name that belongs to this project: the project's
 * customDomain (legacy primary), its apsamo.app subdomain, and every
 * WebsiteDomain row. We dedupe and lowercase.
 */
async function collectProjectDomainNames(
  projectId: string,
  includeSubdomain = false
): Promise<string[]> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { customDomain: true, subdomain: true },
  })
  if (!project) return []

  const websiteDomains = await db.websiteDomain.findMany({
    where: { projectId },
    select: { domain: true },
  })

  const names = new Set<string>()
  if (project.customDomain) names.add(normaliseDomain(project.customDomain))
  if (includeSubdomain && project.subdomain) names.add(normaliseDomain(project.subdomain))
  for (const r of websiteDomains) {
    if (r.domain) names.add(normaliseDomain(r.domain))
  }
  return Array.from(names)
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response

    // Resolve every domain name that belongs to this project, then find the
    // Domain rows owned by the project's owner that match those names.
    const domainNames = await collectProjectDomainNames(projectId)
    const domainRows = domainNames.length
      ? await db.domain.findMany({
          where: { userId: access.ownerId, name: { in: domainNames } },
          select: { id: true, name: true },
        })
      : []
    const domainIds = domainRows.map((d) => d.id)
    const domainNameById = new Map(domainRows.map((d) => [d.id, d.name]))

    const mailboxes = domainIds.length
      ? await db.emailMailbox.findMany({
          where: { domainId: { in: domainIds } },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        })
      : []

    return NextResponse.json({
      mailboxes: mailboxes.map((m) => ({
        id: m.id,
        address: m.address,
        localPart: m.localPart,
        domainId: m.domainId,
        domainName: domainNameById.get(m.domainId) || null,
        password: maskPassword(m.password),
        quota: m.quota,
        active: m.active,
        isDefault: m.isDefault,
        mailcowId: m.mailcowId || null,
        dkimEnabled: m.dkimEnabled,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })),
      domains: domainNames,
    })
  } catch (error) {
    console.error('List email mailboxes error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response

    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const localPart = String(body.localPart || '').toLowerCase().trim()
    const domainName = normaliseDomain(String(body.domainName || ''))
    const password = String(body.password || '')
    const quotaBytes =
      typeof body.quota === 'number' && body.quota > 0
        ? Math.min(Math.floor(body.quota), 50 * 1024 * 1024 * 1024) // cap 50 GB
        : DEFAULT_QUOTA_BYTES

    if (!isValidLocalPart(localPart)) {
      return NextResponse.json(
        { error: 'Invalid local part — use letters, numbers, dots and standard specials (max 64 chars).' },
        { status: 400 }
      )
    }
    if (!isValidDomain(domainName)) {
      return NextResponse.json(
        { error: 'Invalid domain name.' },
        { status: 400 }
      )
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters long.' },
        { status: 400 }
      )
    }

    // The mailbox address must be unique across the whole table.
    const address = `${localPart}@${domainName}`
    const existing = await db.emailMailbox.findUnique({ where: { address } })
    if (existing) {
      return NextResponse.json(
        { error: `A mailbox for ${address} already exists.` },
        { status: 409 }
      )
    }

    // Find-or-create the Domain row owned by the PROJECT OWNER (a team member
    // adding a mailbox must not end up owning the domain). The domain must be one
    // the user manages — we accept either an existing Domain row, or a name
    // that matches one of the project's domains (customDomain or a
    // WebsiteDomain row), creating a fresh Domain row on the fly when needed.
    const projectDomainNames = await collectProjectDomainNames(projectId)
    const belongsToProject = projectDomainNames.includes(domainName)
    const domainRow = await db.domain.upsert({
      where: { name: domainName },
      update: belongsToProject
        ? { projectId, emailHosted: true, status: 'active' }
        : {},
      create: {
        name: domainName,
        userId: access.ownerId,
        projectId: belongsToProject ? projectId : null,
        status: 'active',
        emailHosted: true,
      },
    })

    // Ownership guard — the Domain row must belong to the project's owner.
    if (domainRow.userId !== access.ownerId) {
      return NextResponse.json(
        { error: 'You do not own this domain.' },
        { status: 403 }
      )
    }

    // Provision the domain in Mailcow (idempotent — re-adding an existing
    // domain is fine in demo mode and the real API returns a warning we
    // ignore). Best-effort: a failure here does NOT block mailbox creation
    // because the DB row is the source of truth.
    try {
      await mailcowAddDomain({
        domain: domainName,
        quota: 10240,
        mailboxes: 50,
        aliases: 100,
      })
    } catch (err) {
      console.warn('[email] mailcow addDomain failed (continuing):', err)
    }

    // Generate DKIM if Mailcow is available (best-effort).
    let dkimEnabled = true
    try {
      const dkim = await mailcowGenerateDkim(domainName, 'mail')
      dkimEnabled = dkim.success
    } catch (err) {
      console.warn('[email] mailcow generateDkim failed (continuing):', err)
    }

    // Encrypt the password for at-rest storage.
    const encryptedPassword = encrypt(password)

    // Call Mailcow to actually create the mailbox (best-effort). On success,
    // capture the returned mailcowId (which is the full address for real
    // Mailcow). On failure, we still create the DB row so the user has a
    // record and can retry the password reset later.
    let mailcowId: string | null = null
    try {
      const result = await mailcowCreateMailbox({
        localPart,
        domain: domainName,
        password,
        name: localPart,
        quota: Math.floor(quotaBytes / (1024 * 1024)) || 1024,
      })
      if (result.success && result.mailboxId) {
        mailcowId = result.mailboxId
      } else if (!result.success) {
        console.warn('[email] mailcow createMailbox reported failure:', result.error)
      }
    } catch (err) {
      console.warn('[email] mailcow createMailbox threw (continuing):', err)
    }

    // If this is the user's first mailbox, mark it as default (admin).
    const existingCount = await db.emailMailbox.count({
      where: { domainId: domainRow.id },
    })
    const isDefault = existingCount === 0

    const mailbox = await db.emailMailbox.create({
      data: {
        domainId: domainRow.id,
        address,
        localPart,
        password: encryptedPassword,
        quota: quotaBytes,
        active: true,
        isDefault,
        mailcowId,
        dkimEnabled,
      },
    })

    await logAudit({
      userId: decoded.userId,
      action: 'project.email.mailbox.create',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { address, domainName, quota: quotaBytes },
    })

    return NextResponse.json(
      {
        mailbox: {
          id: mailbox.id,
          address: mailbox.address,
          localPart: mailbox.localPart,
          domainId: mailbox.domainId,
          domainName,
          password: maskPassword(mailbox.password),
          // Plaintext returned ONCE so the UI can show the "save these
          // credentials" dialog. Never re-exposed after this response.
          plaintextPassword: password,
          quota: mailbox.quota,
          active: mailbox.active,
          isDefault: mailbox.isDefault,
          mailcowId: mailbox.mailcowId || null,
          dkimEnabled: mailbox.dkimEnabled,
          createdAt: mailbox.createdAt.toISOString(),
          updatedAt: mailbox.updatedAt.toISOString(),
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Create email mailbox error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
