import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader, requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'

/**
 * Update / archive / delete a single plan.
 *
 * Deleting a plan that has subscribers would orphan live services, so a plan
 * in use is ARCHIVED instead (existing subscriptions keep running, but it
 * can no longer be bought).
 */
async function requireAdmin(request: Request): Promise<{
  decoded: { userId: string; email: string; role: string }
} | null> {
  // SECURITY: role comes from the database, not the 7-day token — see
  // verifyTokenFresh. Also rejects suspended/closed accounts.
  const decoded = await requireAdminRole(request)
  return decoded ? { decoded } : null
}

const BILLING_CYCLES = ['monthly', 'quarterly', 'annual', 'biennial', 'lifetime']

function toLimit(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.floor(n)
}
function toFloatLimit(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

/** PATCH /api/admin/plans/:id — partial update. */
export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }
    const { id } = await context.params
    const existing = await db.plan.findUnique({ where: { id } })
    if (!existing) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
    }

    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >
    const data: Record<string, unknown> = {}

    if (typeof body.name === 'string' && body.name.trim()) {
      const name = body.name.trim()
      const clash = await db.plan.findFirst({
        where: { name, NOT: { id } },
      })
      if (clash) {
        return NextResponse.json(
          { error: 'Another plan already uses that name' },
          { status: 409 }
        )
      }
      data.name = name
    }
    if (typeof body.description === 'string') data.description = body.description
    if (body.price !== undefined) {
      const price = Number(body.price)
      if (!Number.isFinite(price) || price < 0) {
        return NextResponse.json(
          { error: 'Price must be a number >= 0' },
          { status: 400 }
        )
      }
      data.price = price
    }
    if (body.billingCycle !== undefined) {
      const bc = String(body.billingCycle)
      if (!BILLING_CYCLES.includes(bc)) {
        return NextResponse.json(
          { error: `billingCycle must be one of: ${BILLING_CYCLES.join(', ')}` },
          { status: 400 }
        )
      }
      data.billingCycle = bc
    }
    if (body.currency !== undefined)
      data.currency = String(body.currency).toUpperCase()
    if (body.trialDays !== undefined) data.trialDays = toLimit(body.trialDays) ?? 0
    if (body.setupFee !== undefined)
      data.setupFee = toFloatLimit(body.setupFee) ?? 0

    // Display strings
    for (const k of ['ram', 'cpu', 'storage', 'bandwidth'] as const) {
      if (body[k] !== undefined) data[k] = String(body[k])
    }
    if (body.projects !== undefined) data.projects = toLimit(body.projects) ?? 1
    if (body.priority !== undefined) data.priority = toLimit(body.priority) ?? 0

    // Booleans
    for (const k of [
      'ssl',
      'customDomain',
      'popular',
      'active',
      'hidden',
      'archived',
      'promotional',
    ] as const) {
      if (body[k] !== undefined) data[k] = body[k] === true
    }

    // Numeric limits (null = unlimited)
    for (const k of [
      'diskMB',
      'bandwidthMB',
      'ramMB',
      'ioMBps',
      'processes',
      'inodes',
      'maxDatabases',
      'maxEmailAccounts',
      'maxFtpAccounts',
      'maxCronJobs',
      'maxBackups',
      'maxDnsZones',
      'maxDomains',
      'maxSubdomains',
      'maxParkedDomains',
      'maxAddonDomains',
      'maxSslCerts',
    ] as const) {
      if (body[k] !== undefined) data[k] = toLimit(body[k])
    }
    if (body.cpuCores !== undefined) data.cpuCores = toFloatLimit(body.cpuCores)

    if (body.allowedApps !== undefined) {
      data.allowedApps = Array.isArray(body.allowedApps)
        ? JSON.stringify(body.allowedApps.map(String))
        : null
    }

    const updated = await db.plan.update({ where: { id }, data: data as never })

    await logAudit({
      userId: auth.decoded.userId,
      action: 'plan.update',
      resource: 'plan',
      resourceId: id,
      req: request,
      metadata: { fields: Object.keys(data) },
    }).catch(() => {})

    return NextResponse.json({ success: true, plan: updated })
  } catch (error) {
    console.error('[admin/plans/:id] PATCH failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/admin/plans/:id
 * Hard-deletes only when no subscription has ever used the plan; otherwise
 * archives it so live services aren't orphaned.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }
    const { id } = await context.params
    const existing = await db.plan.findUnique({
      where: { id },
      include: { _count: { select: { subscriptions: true } } },
    })
    if (!existing) {
      return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
    }

    const inUse = existing._count.subscriptions > 0
    if (inUse) {
      await db.plan.update({
        where: { id },
        data: { archived: true, active: false, hidden: true } as never,
      })
      await logAudit({
        userId: auth.decoded.userId,
        action: 'plan.archive',
        resource: 'plan',
        resourceId: id,
        req: request,
        metadata: { reason: 'in use', subscriptions: existing._count.subscriptions },
      }).catch(() => {})
      return NextResponse.json({
        success: true,
        archived: true,
        message: `Plan archived — ${existing._count.subscriptions} subscription(s) still use it, so it can't be deleted. It's now hidden and unsellable.`,
      })
    }

    await db.plan.delete({ where: { id } })
    await logAudit({
      userId: auth.decoded.userId,
      action: 'plan.delete',
      resource: 'plan',
      resourceId: id,
      req: request,
      metadata: { name: existing.name },
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      archived: false,
      message: 'Plan deleted.',
    })
  } catch (error) {
    console.error('[admin/plans/:id] DELETE failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
