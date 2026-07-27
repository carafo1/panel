/**
 * Email-service tenant guard
 * ==========================
 *
 * Standalone email hosting is owned by a User, not a Project, so it needs its
 * own guard: the project-based one (`mailcow-tenant.ts`) cannot resolve it.
 *
 * Everything the customer can reach for an email service goes through here, so
 * ownership of the service — and therefore of the domain whose mail is being
 * managed — is proven exactly once, in one place.
 */
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'

export class EmailServiceError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'EmailServiceError'
    this.status = status
  }
}

export interface ResolvedEmailService {
  auth: { userId: string; email: string; role: string }
  service: {
    id: string
    userId: string
    planId: string
    /** The subscription paying for this service; null for admin-granted. */
    subscriptionId: string | null
    domain: string
    status: string
    mailboxLimit: number
    storagePerMailboxGB: number
    totalStorageGB: number
    extraMailboxes: number
    extraStorageGB: number
    mailcowDomainCreated: boolean
    dkimGenerated: boolean
    createdAt: Date
  }
  /** Always exactly this service's domain — used to scope Mailcow reads. */
  domains: string[]
}

/**
 * Authenticate and resolve one email service the caller owns.
 *
 * A suspended service still resolves (so the customer can see why and pay),
 * but callers that mutate mail must check `status` themselves.
 */
export async function resolveEmailService(
  request: Request,
  serviceId: string
): Promise<ResolvedEmailService> {
  const auth = await authenticateRequest(request)
  if (!auth) throw new EmailServiceError('Invalid or expired token', 401)

  const service = await db.emailService.findFirst({
    where: isAdmin(auth.role)
      ? { id: serviceId }
      : { id: serviceId, userId: auth.userId },
  })
  if (!service) throw new EmailServiceError('Email service not found', 404)

  return {
    auth,
    service,
    domains: [service.domain],
  }
}

/** Every email service the caller owns (admins see their own here too). */
export async function listOwnEmailServices(request: Request) {
  const auth = await authenticateRequest(request)
  if (!auth) throw new EmailServiceError('Invalid or expired token', 401)
  const services = await db.emailService.findMany({
    where: { userId: auth.userId },
    include: { plan: { select: { name: true, slug: true, price: true, currency: true } } },
    orderBy: { createdAt: 'desc' },
  })
  return { auth, services }
}

export function emailServiceErrorResponse(err: unknown): {
  error: string
  status: number
} {
  if (err instanceof EmailServiceError) return { error: err.message, status: err.status }
  return {
    error: err instanceof Error ? err.message : 'Request failed',
    status: 500,
  }
}
