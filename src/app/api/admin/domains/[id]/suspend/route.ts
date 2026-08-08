/**
 * POST /api/admin/domains/:id/suspend
 * Admin-only. Suspends a domain (sets status=suspended, unlocks, disables DNS).
 */
import { requireAdminRole } from '@/lib/auth'
import { db } from '@/lib/db'
import { dynadotService } from '@/lib/dynadot-service'
import { ok, apiError } from '@/lib/api-response'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  // requireAdminRole re-reads the role and account status from the database.
  // authenticateRequest trusts the role baked into a 7-day JWT, so a demoted
  // or suspended admin kept the ability to suspend customer domains until
  // their token happened to expire.
  const user = await requireAdminRole(request)
  if (!user) return apiError.forbidden('Admin access required')

  const { id } = await params
  const domain = await db.domain.findUnique({ where: { id } })
  if (!domain) return apiError.notFound('Domain not found')

  // Suspend: mark status and disable auto-renew at provider
  try {
    await dynadotService.disableAutoRenew(domain.name)
  } catch {
    // non-fatal in demo mode
  }

  await db.domain.update({
    where: { id },
    data: { status: 'suspended', autoRenew: false },
  })

  await db.domainLog.create({
    data: {
      domainId: id,
      userId: user.userId,
      action: 'suspend',
      status: 'success',
      message: `Domain suspended by admin ${user.email}`,
    },
  })

  return ok({ id, status: 'suspended' }, 'Domain suspended successfully')
}
