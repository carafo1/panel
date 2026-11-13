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
 * may manage: the project's custom domain plus every attached WebsiteDomain.
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

  const websiteDomains = await db.websiteDomain.findMany({
    where: { projectId },
    select: { domain: true },
  })

  const names = new Set<string>()
  if (project.customDomain) names.add(normalise(project.customDomain))
  for (const r of websiteDomains) if (r.domain) names.add(normalise(r.domain))
  const domains = [...names].filter(Boolean)

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

/** Map a thrown error to a response-shaped result. */
export function mailErrorResponse(err: unknown): { error: string; status: number } {
  if (err instanceof MailAccessError) return { error: err.message, status: err.status }
  return {
    error: err instanceof Error ? err.message : 'Email request failed',
    status: 500,
  }
}
