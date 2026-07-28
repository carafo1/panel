/**
 * GET /api/admin/email
 *
 * Operator view of every email-hosting service: who owns it, what they pay,
 * what they are allowed, and what they are actually using. Live usage is read
 * from Mailcow per service, so this is deliberately capped and paginated
 * rather than fetching everything on every load.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAdminRole } from '@/lib/auth'
import { effectiveLimits, getEmailUsage } from '@/lib/email-hosting'

const MAX_PAGE = 50

export async function GET(request: Request) {
  // Role is re-read from the database rather than trusted from the token, and
  // suspended/closed accounts are rejected.
  const decoded = await requireAdminRole(request)
  if (!decoded) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  const q = (url.searchParams.get('q') || '').trim().toLowerCase()
  const take = Math.min(Number(url.searchParams.get('take')) || 25, MAX_PAGE)
  const skip = Math.max(Number(url.searchParams.get('skip')) || 0, 0)
  // Usage means one Mailcow round-trip per service; let the caller opt out.
  const withUsage = url.searchParams.get('usage') !== '0'

  const where = {
    ...(status && status !== 'all' ? { status } : {}),
    ...(q
      ? {
          OR: [
            { domain: { contains: q } },
            { user: { email: { contains: q } } },
            { user: { name: { contains: q } } },
          ],
        }
      : {}),
  }

  const [total, services, counts] = await Promise.all([
    db.emailService.count({ where }),
    db.emailService.findMany({
      where,
      include: {
        user: { select: { id: true, email: true, name: true } },
        plan: { select: { id: true, name: true, slug: true, price: true } },
      },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    }),
    db.emailService.groupBy({ by: ['status'], _count: { status: true } }),
  ])

  const rows = await Promise.all(
    services.map(async (s) => {
      const usage = withUsage ? await getEmailUsage(s).catch(() => null) : null
      return {
        id: s.id,
        domain: s.domain,
        status: s.status,
        user: s.user,
        plan: s.plan,
        limits: effectiveLimits(s),
        extraMailboxes: s.extraMailboxes,
        extraStorageGB: s.extraStorageGB,
        usage,
        provisioned: s.mailcowDomainCreated,
        dkimGenerated: s.dkimGenerated,
        lastError: s.lastError,
        suspendedAt: s.suspendedAt,
        createdAt: s.createdAt,
      }
    })
  )

  return NextResponse.json({
    services: rows,
    total,
    take,
    skip,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count.status])),
  })
}
