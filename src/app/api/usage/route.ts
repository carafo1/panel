import { NextResponse } from 'next/server'
import { authenticateRequestFresh } from '@/lib/auth'
import { db } from '@/lib/db'
import { getCurrentUsage, checkPlanLimits } from '@/lib/usage'
import { getProjectResourceUsage } from '@/lib/vps/resources'

/**
 * The signed-in customer's own resource picture.
 *
 * Deliberately returns THREE distinct things, because the dashboard was
 * previously conflating them — and worse, inventing one of them
 * (`storageUsed = projectCount * 1.8 + 0.5`):
 *
 *   quota     — what the plan entitles them to (a billing number)
 *   consumed  — what they are actually using (measured, from UsageRecord)
 *   hosting   — live container CPU/RAM/disk for their sites (measured now)
 *
 * A customer never sees host-level infrastructure here: the VPS has 8 GB of
 * RAM, but that is not *their* 8 GB, and showing it would imply otherwise.
 */
export async function GET(request: Request) {
  try {
    const auth = await authenticateRequestFresh(request)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
    }

    const [usage, limits, sub] = await Promise.all([
      getCurrentUsage(auth.userId),
      checkPlanLimits(auth.userId),
      db.subscription.findFirst({
        where: {
          userId: auth.userId,
          status: { in: ['active', 'trialing', 'past_due'] },
        },
        orderBy: { createdAt: 'desc' },
        include: { plan: true },
      }),
    ])

    // Live per-site container metrics. Best-effort: a stopped or unreachable
    // container is reported as such rather than as zero usage.
    const projects = await db.project.findMany({
      where: { userId: auth.userId },
      select: { id: true, name: true, slug: true, status: true },
      take: 50,
    })

    const hosting = await Promise.all(
      projects.map(async (p) => {
        const live = await getProjectResourceUsage(p.id).catch(() => null)
        return {
          projectId: p.id,
          name: p.name,
          slug: p.slug,
          status: p.status,
          measured: Boolean(live),
          cpuPercent: live?.cpuPercent ?? null,
          ramUsedMB: live?.ramUsedMB ?? null,
          // `ramMB` on ResourceUsage is the ALLOCATED limit, not usage.
          ramLimitMB: live?.ramMB ?? null,
          storageUsedGB: live?.storageUsedGB ?? null,
          networkRxBytes: live?.networkRxBytes ?? null,
          networkTxBytes: live?.networkTxBytes ?? null,
        }
      })
    )

    return NextResponse.json({
      // ── What they pay for ──────────────────────────────────────────
      subscription: sub
        ? {
            id: sub.id,
            status: sub.status,
            planName: sub.plan?.name ?? null,
            billingCycle: (sub.plan as { billingCycle?: string })?.billingCycle ?? null,
            currentPeriodEnd: sub.currentPeriodEnd,
          }
        : null,
      // ── Quota vs measured consumption, per resource ────────────────
      // `limit: null` means unlimited — the UI must render that as "—",
      // never as a full progress bar.
      quota: {
        planName: limits.planName,
        checks: limits.checks,
        overCount: limits.overCount,
      },
      // ── Raw measured totals ────────────────────────────────────────
      consumed: usage
        ? {
            diskMB: usage.diskMB,
            ramMB: usage.ramMB,
            cpuPercent: usage.cpuPercent,
            bandwidthMB: usage.bandwidthMB,
            websites: usage.websites,
            databases: usage.databases,
            emailAccounts: usage.emailAccounts,
            ftpAccounts: usage.ftpAccounts,
            cronJobs: usage.cronJobs,
            domains: usage.domains,
            subdomains: usage.subdomains,
            backups: usage.backups,
            capturedAt: usage.capturedAt,
          }
        : null,
      // ── Live container metrics for their own sites ─────────────────
      hosting,
      measuredAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[usage] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
