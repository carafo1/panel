/**
 * Email tenant guard
 * ==================
 *
 * Single choke point for the native email management routes. Mailcow's API is
 * server-wide — `get/alias/all`, `get/quarantine/all` and the log endpoints
 * return every tenant's data — so every route must resolve the caller's own
 * domains here and pass them into `mailcow-manage`, which filters against them.
 *
 * Nothing in the email API may call Mailcow without going through this first.
 */
import { db } from '@/lib/db'
import { getProjectAccess, type ProjectPermission } from '@/lib/project-access'
import { authenticateRequest } from '@/lib/auth'
import { isMailcowConfigured } from '@/lib/mailcow-manage'

export class MailAccessError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'MailAccessError'
    this.status = status
  }
}

export interface MailTenant {
  auth: { userId: string; email: string; role: string }
  project: { id: string; name: string; userId: string }
  /** every domain name this project may manage mail for, lowercased */
  domains: string[]
}

const normalise = (d: string) => (d || '').trim().toLowerCase().replace(/\.$/, '')

/**
 * Authenticate, prove the caller owns the project, and resolve the domains it
 * may manage: the project's custom domain plus every VERIFIED WebsiteDomain.
 *
 * The platform subdomain is deliberately excluded — mail is only ever hosted on
 * a real domain the customer controls.
 */
export async function resolveMailTenant(
  request: Request,
  projectId: string,
  /** Team permission needed (lib/project-access). Mail settings are "data". */
  permission: ProjectPermission = 'data'
): Promise<MailTenant> {
  if (!isMailcowConfigured()) {
    throw new MailAccessError('Email hosting is not configured on this server', 503)
  }

  const auth = await authenticateRequest(request)
  if (!auth) throw new MailAccessError('Invalid or expired token', 401)

  // Owner, platform admin, or a team member whose role allows `permission`.
  const access = await getProjectAccess(auth, projectId)
  if (!access) throw new MailAccessError('Project not found', 404)
  if (!access.can(permission)) {
    throw new MailAccessError(
      "Your team role does not allow managing this project's email. Ask a team admin.",
      403
    )
  }
  const project = await db.project.findUnique({
    where: { id: projectId },
    select: { id: true, name: true, userId: true, customDomain: true },
  })
  if (!project) throw new MailAccessError('Project not found', 404)

  // SECURITY: only VERIFIED WebsiteDomains. An attached-but-unverified row is
  // just a claim — counting it let a tenant attach someone else's domain and
  // then set its catch-all, aliases and read its quarantine.
  const websiteDomains = await db.websiteDomain.findMany({
    where: { projectId, verified: true },
    select: { domain: true, verified: true },
  })

  const domains = mailDomainNames({ customDomain: project.customDomain, websiteDomains })

  if (domains.length === 0) {
    throw new MailAccessError(
      'This project has no domain yet — add a domain before managing email',
      409
    )
  }

  return {
    auth,
    project: { id: project.id, name: project.name, userId: project.userId },
    domains,
  }
}

/**
 * The domains a project may manage mail for: its customDomain plus every
 * WebsiteDomain that has been VERIFIED. Unverified rows are ignored even if
 * the caller forgot to filter them in the query. Lowercased, deduplicated.
 */
export function mailDomainNames(input: {
  customDomain?: string | null
  websiteDomains: Array<{ domain: string | null; verified: boolean }>
}): string[] {
  const names = new Set<string>()
  if (input.customDomain) names.add(normalise(input.customDomain))
  for (const r of input.websiteDomains) {
    if (r.verified === true && r.domain) names.add(normalise(r.domain))
  }
  return [...names].filter(Boolean)
}

/** The Domain row (if any) that already holds the requested mailbox domain. */
export interface MailboxDomainRow {
  id: string
  userId: string
  projectId: string | null
  status: string
  /** DomainVerification.verified — null/undefined when there is no verification row. */
  verified?: boolean | null
}

export type MailboxDomainDecision =
  | { ok: true; action: 'create' }
  | { ok: true; action: 'reuse'; domainId: string; linkProject: boolean }
  | { ok: false; status: number; error: string }

/**
 * Decide whether a mailbox may be created on `domainName` for this project,
 * BEFORE anything is written. Pure, so it is unit-tested directly.
 *
 *  - the domain must be one of the project's mail domains (mailDomainNames);
 *  - an existing Domain row must belong to the project owner — it is never
 *    re-assigned (the old upsert moved another user's row onto this project
 *    before the ownership check ran);
 *  - a Domain row still awaiting verification only qualifies when the same
 *    name is a verified WebsiteDomain of this project;
 *  - a new Domain row is only created for a verified WebsiteDomain, never for
 *    an arbitrary name.
 */
export function decideMailboxDomain(input: {
  domainName: string
  /** mailDomainNames() for the project */
  allowedDomains: string[]
  /** names of this project's verified WebsiteDomains */
  verifiedWebsiteDomains: string[]
  existing: MailboxDomainRow | null
  ownerId: string
  projectId: string
}): MailboxDomainDecision {
  const name = normalise(input.domainName)
  const allowed = new Set(input.allowedDomains.map(normalise))
  const verifiedSite = new Set(input.verifiedWebsiteDomains.map(normalise))

  if (!name || !allowed.has(name)) {
    return {
      ok: false,
      status: 403,
      error: "Mailboxes can only be created on this project's own verified domains.",
    }
  }

  const ex = input.existing
  if (ex) {
    if (ex.userId !== input.ownerId) {
      return { ok: false, status: 403, error: 'You do not own this domain.' }
    }
    const awaitingVerification = ex.status === 'pending_verification' || ex.verified === false
    if (awaitingVerification && !verifiedSite.has(name)) {
      return {
        ok: false,
        status: 403,
        error: 'Verify ownership of this domain before creating mailboxes on it.',
      }
    }
    return { ok: true, action: 'reuse', domainId: ex.id, linkProject: ex.projectId === null }
  }

  if (!verifiedSite.has(name)) {
    return {
      ok: false,
      status: 403,
      error: 'Verify ownership of this domain before creating mailboxes on it.',
    }
  }
  return { ok: true, action: 'create' }
}

/** Map a thrown error to a response-shaped result. */
export function mailErrorResponse(err: unknown): { error: string; status: number } {
  if (err instanceof MailAccessError) return { error: err.message, status: err.status }
  return {
    error: err instanceof Error ? err.message : 'Email request failed',
    status: 500,
  }
}
