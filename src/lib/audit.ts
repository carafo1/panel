/**
 * Audit logging service.
 *
 * Used by:
 *  - #6 Audit Logging
 *
 * Records security-relevant user actions (logins, project changes, billing
 * actions, admin operations, etc.) for compliance and incident response.
 *
 * The corresponding `AuditLog` Prisma model is expected to expose these fields:
 *   id, userId?, action, resource, resourceId?, ip?, userAgent?,
 *   metadata?, status, createdAt
 *
 * If the model is not yet present in the Prisma schema (added by a later task),
 * the call silently fails - it MUST NEVER break the main operation.
 */
import { db } from '@/lib/db'

export interface AuditLogOptions {
  userId?: string
  action: string // e.g. "user.login", "project.create", "billing.subscribe"
  resource: string // e.g. "user", "project", "domain", "payment"
  resourceId?: string
  req?: Request
  metadata?: unknown // any JSON-serialisable extra context
  status?: string // success | failure | pending (default: success)
}

/**
 * Extract client IP from a Next.js Request, respecting common proxy headers.
 */
function extractIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0]!.trim()
  }
  return (
    req.headers.get('x-real-ip') ||
    req.headers.get('cf-connecting-ip') ||
    'unknown'
  )
}

/**
 * Extract User-Agent from a Next.js Request.
 */
function extractUserAgent(req: Request): string {
  return req.headers.get('user-agent') || 'unknown'
}

/**
 * Record an audit log entry. Silently fails on error so the main operation
 * is never affected by audit-logging issues.
 */
export async function logAudit(opts: AuditLogOptions): Promise<void> {
  try {
    const ip = opts.req ? extractIp(opts.req) : undefined
    const userAgent = opts.req ? extractUserAgent(opts.req) : undefined

    const data = {
      userId: opts.userId || null,
      action: opts.action,
      resource: opts.resource,
      resourceId: opts.resourceId || null,
      ip: ip || null,
      userAgent: userAgent || null,
      // AuditLog.metadata is a required column. Writing null made Prisma
      // reject the whole row (with a misleading "Unknown argument userId"),
      // so every audit entry logged without metadata was silently lost.
      metadata: JSON.stringify(opts.metadata ?? {}),
      status: opts.status || 'success',
    }

    // Use `any` here so the call doesn't fail TypeScript / lint checks
    // before the AuditLog model is added to the Prisma schema. The try/catch
    // guarantees runtime safety as well.
     
    await (db as any).auditLog.create({ data })
  } catch (error) {
     
    console.error(
      '[audit] Failed to record audit log:',
      opts.action,
      opts.resource,
      error instanceof Error ? error.message : error
    )
  }
}

/**
 * Convenience helpers for common audit events.
 */
export const audit = {
  login: (userId: string, req: Request, success = true) =>
    logAudit({
      userId,
      action: 'user.login',
      resource: 'user',
      resourceId: userId,
      req,
      status: success ? 'success' : 'failure',
    }),

  logout: (userId: string, req: Request) =>
    logAudit({
      userId,
      action: 'user.logout',
      resource: 'user',
      resourceId: userId,
      req,
    }),

  register: (userId: string, req: Request) =>
    logAudit({
      userId,
      action: 'user.register',
      resource: 'user',
      resourceId: userId,
      req,
    }),

  projectCreate: (userId: string, projectId: string, req: Request) =>
    logAudit({
      userId,
      action: 'project.create',
      resource: 'project',
      resourceId: projectId,
      req,
      metadata: { name: 'project' },
    }),

  projectDelete: (userId: string, projectId: string, req: Request) =>
    logAudit({
      userId,
      action: 'project.delete',
      resource: 'project',
      resourceId: projectId,
      req,
    }),

  paymentSuccess: (userId: string, paymentId: string, amount: number, req?: Request) =>
    logAudit({
      userId,
      action: 'payment.success',
      resource: 'payment',
      resourceId: paymentId,
      req,
      metadata: { amount },
    }),

  adminAction: (userId: string, action: string, resource: string, resourceId: string, req: Request, metadata?: unknown) =>
    logAudit({
      userId,
      action: `admin.${action}`,
      resource,
      resourceId,
      req,
      metadata,
    }),
}
