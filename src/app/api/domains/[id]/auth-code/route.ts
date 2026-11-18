/**
 * GET|POST /api/domains/:id/auth-code
 * Retrieves the EPP / auth code for a domain (required for transfers).
 *
 * SECURITY:
 *   - Auth code is stored ENCRYPTED at rest (AES-256-GCM) — H7
 *   - Admins retrieving another user's auth code must re-confirm their password — H8
 *   - All retrievals are audit-logged with high severity
 *   - The auth code is never logged in plaintext server-side
 */
import { authenticateRequest } from '@/lib/auth'
import { db } from '@/lib/db'
import { dynadotService } from '@/lib/dynadot-service'
import { ok, apiError } from '@/lib/api-response'
import { assertRegistrarManaged } from '@/lib/domain-ownership'
import { encrypt, decrypt } from '@/lib/encryption'
import { isAdmin } from '@/lib/security'
import bcrypt from 'bcryptjs'

/**
 * GET  — owner retrieval; an admin may re-confirm with the `x-admin-password`
 *        header.
 * POST — same, with the admin password in the JSON body
 *        ({ "adminPassword": "..." }) or the header.
 *
 * SECURITY: the admin password is never read from the query string — URLs end
 * up in proxy/access logs, browser history and Referer headers.
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  return retrieveAuthCode(request, ctx, request.headers.get('x-admin-password'))
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> }
) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  const fromBody =
    body && typeof body === 'object'
      ? typeof body.adminPassword === 'string'
        ? body.adminPassword
        : typeof body.admin_password === 'string'
        ? body.admin_password
        : null
      : null
  return retrieveAuthCode(request, ctx, fromBody || request.headers.get('x-admin-password'))
}

async function retrieveAuthCode(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  adminPassword: string | null
) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()

  const { id } = await params
  try {
    const domain = await db.domain.findUnique({ where: { id } })
    if (!domain) return apiError.notFound('Domain not found')

    const isOwner = domain.userId === user.userId
    const userIsAdmin = isAdmin(user.role)

    // Owner can always retrieve their own auth code
    // Admin/super_admin must re-confirm their password for another user's domain — H8
    if (!isOwner && userIsAdmin) {
      if (!adminPassword) {
        return apiError.forbidden(
          'Admin access to customer EPP codes requires password re-confirmation. ' +
          'Send it as the x-admin-password header or as adminPassword in a POST JSON body.'
        )
      }
      // Verify admin password
      const adminUser = await db.user.findUnique({ where: { id: user.userId } })
      if (!adminUser || !(await bcrypt.compare(adminPassword, adminUser.password))) {
        return apiError.forbidden('Admin password verification failed')
      }
    } else if (!isOwner) {
      return apiError.forbidden()
    }

    // Registrar-only operation. An EPP code can only come from the registrar
    // holding the domain — for an external domain the customer must get it from
    // their own provider, and asking Dynadot returns a confusing failure.
    const notOurs = assertRegistrarManaged(domain)
    if (notOurs) return notOurs

    const result = await dynadotService.getAuthCode(domain.name)
    if (!result.success || !result.authCode) {
      return apiError.badRequest('Failed to retrieve auth code from the registrar')
    }

    // SECURITY: encrypt the auth code before storing — H7 (was plaintext!)
    const encryptedAuthCode = encrypt(result.authCode)
    await db.domain.update({
      where: { id },
      data: { authCode: encryptedAuthCode },
    })

    // SECURITY: high-severity audit log for EPP code retrieval
    await db.domainLog.create({
      data: {
        domainId: id,
        userId: user.userId,
        action: 'auth_code_retrieved',
        status: 'success',
        message: `EPP auth code retrieved by ${isOwner ? 'owner' : 'admin (' + user.email + ')'}`,
        metadata: JSON.stringify({
          severity: 'high',
          domainName: domain.name,
          requesterEmail: user.email,
          requesterRole: user.role,
          ownerUserId: domain.userId,
          passwordConfirmed: !isOwner,
          timestamp: new Date().toISOString(),
        }),
      },
    })

    return ok(
      { authCode: result.authCode },
      'Auth code retrieved successfully'
    )
  } catch (error) {
    console.error('[domains/auth-code] error:', error)
    return apiError.serverError()
  }
}
