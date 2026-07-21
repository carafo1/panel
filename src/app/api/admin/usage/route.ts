import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader, requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import {
  getCurrentUsage,
  getUsageHistory,
  checkPlanLimits,
  resetUsage,
  collectAllUsage,
  recordUsageSnapshot,
} from '@/lib/usage'

/** Admin usage metering: current usage, history, limit checks, reset. */
async function requireAdmin(request: Request): Promise<{
  decoded: { userId: string; email: string; role: string }
} | null> {
  // SECURITY: role comes from the database, not the 7-day token — see
  // verifyTokenFresh. Also rejects suspended/closed accounts.
  const decoded = await requireAdminRole(request)
  return decoded ? { decoded } : null
}

/**
 * GET /api/admin/usage             → every customer, with over-limit flags
 * GET /api/admin/usage?userId=...  → that customer's usage + history + limits
 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')

    if (userId) {
      const [usage, history, limits] = await Promise.all([
        getCurrentUsage(userId),
        getUsageHistory(userId, 100),
        checkPlanLimits(userId),
      ])
      const user = await db.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true },
      })
      return NextResponse.json({ user, usage, history, limits })
    }

    // Overview: one row per customer with an active subscription.
    const subs = await db.subscription.findMany({
      where: { status: { in: ['active', 'trialing', 'past_due'] } },
      include: {
        user: { select: { id: true, name: true, email: true } },
        plan: { select: { name: true } },
      },
      take: 200,
    })

    const rows: Array<Record<string, unknown> & { overCount: number }> = []
    for (const s of subs) {
      const limits = await checkPlanLimits(s.userId).catch(() => null)
      const usage = await db.usageRecord.findFirst({
        where: { userId: s.userId },
        orderBy: { capturedAt: 'desc' },
      })
      rows.push({
        userId: s.userId,
        user: s.user,
        planName: s.plan?.name ?? null,
        subscriptionId: s.id,
        usage,
        overCount: limits?.overCount ?? 0,
        checks: limits?.checks ?? [],
        capturedAt: usage?.capturedAt ?? null,
      })
    }

    return NextResponse.json({
      customers: rows,
      overLimitCount: rows.filter((r) => r.overCount > 0).length,
    })
  } catch (error) {
    console.error('[admin/usage] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/admin/usage
 * Body: { action: "reset" | "collect" | "snapshot", userId?, subscriptionId? }
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
    }
    const body = (await request.json().catch(() => ({}))) as {
      action?: string
      userId?: string
      subscriptionId?: string
    }
    const action = (body.action || '').toLowerCase()

    if (action === 'reset') {
      if (!body.userId) {
        return NextResponse.json({ error: 'userId is required' }, { status: 400 })
      }
      const result = await resetUsage({
        userId: body.userId,
        subscriptionId: body.subscriptionId || null,
      })
      await logAudit({
        userId: auth.decoded.userId,
        action: 'usage.reset',
        resource: 'user',
        resourceId: body.userId,
        req: request,
        metadata: { deletedSnapshots: result.deleted },
      }).catch(() => {})
      return NextResponse.json({
        success: true,
        message: `Usage reset — ${result.deleted} snapshot(s) cleared and a fresh baseline taken.`,
      })
    }

    if (action === 'snapshot') {
      if (!body.userId) {
        return NextResponse.json({ error: 'userId is required' }, { status: 400 })
      }
      const rec = await recordUsageSnapshot(body.userId)
      return NextResponse.json({
        success: true,
        record: rec,
        message: 'Snapshot captured.',
      })
    }

    if (action === 'collect') {
      const result = await collectAllUsage()
      await logAudit({
        userId: auth.decoded.userId,
        action: 'usage.collect',
        resource: 'usage',
        req: request,
        metadata: result,
      }).catch(() => {})
      return NextResponse.json({
        success: true,
        ...result,
        message: `Captured usage for ${result.captured} customer(s).`,
      })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (error) {
    console.error('[admin/usage] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
