/**
 * GET /api/domains/:id/auth-code
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
import { encrypt, decrypt } from '@/lib/encryption'
import { isAdmin } from '@/lib/security'
import bcrypt from 'bcryptjs'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
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
      const { searchParams } = new URL(request.url)
      const adminPassword = searchParams.get('admin_password') || request.headers.get('x-admin-password')
      if (!adminPassword) {
        return apiError.forbidden(
          'Admin access to customer EPP codes requires password re-confirmation. ' +
          'Provide ?admin_password= or x-admin-password header.'
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
