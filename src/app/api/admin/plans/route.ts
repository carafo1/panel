import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader, requireAdminRole } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'

/**
 * Admin plan management.
 *
 * Until now plans could only be created by editing seed.ts — the super admin
 * had no way to define, price, or retire a package. This is the foundation
 * every other billing feature (cycles, trials, limits, upgrades) hangs off.
 */
async function requireAdmin(request: Request): Promise<{
  decoded: { userId: string; email: string; role: string }
} | null> {
  // SECURITY: role comes from the database, not the 7-day token — see
  // verifyTokenFresh. Also rejects suspended/closed accounts.
  const decoded = await requireAdminRole(request)
  return decoded ? { decoded } : null
}

const BILLING_CYCLES = [
  'monthly',
  'quarterly',
  'annual',
  'biennial',
  'lifetime',
] as const

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Coerce a value to a non-negative int, or null for "unlimited". */
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

/** Shape a Plan row for the admin UI (parses allowedApps JSON). */
function shape(p: Record<string, unknown>) {
  let allowedApps: string[] | null = null
  if (typeof p.allowedApps === 'string' && p.allowedApps) {
    try {
      const parsed = JSON.parse(p.allowedApps)
      if (Array.isArray(parsed)) allowedApps = parsed.map(String)
    } catch {
      allowedApps = null
    }
  }
  return { ...p, allowedApps }
}

/** GET /api/admin/plans?includeArchived=1 */
export async function GET(request: Request) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }
    const { searchParams } = new URL(request.url)
    const includeArchived = searchParams.get('includeArchived') === '1'

    const plans = await db.plan.findMany({
      where: includeArchived ? {} : { archived: false },
      orderBy: [{ priority: 'asc' }, { price: 'asc' }],
      include: { _count: { select: { subscriptions: true } } },
    })

    return NextResponse.json({
      plans: plans.map((p) => shape(p as unknown as Record<string, unknown>)),
      billingCycles: BILLING_CYCLES,
    })
  } catch (error) {
    console.error('[admin/plans] GET failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * POST /api/admin/plans
 * Create a plan, or clone one with { cloneFromId }.
 */
export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request)
    if (!auth) {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }
    const body = (await request.json().catch(() => ({}))) as Record<
      string,
      unknown
    >

    // ── Clone ────────────────────────────────────────────────────────
    if (typeof body.cloneFromId === 'string' && body.cloneFromId) {
      const src = await db.plan.findUnique({ where: { id: body.cloneFromId } })
      if (!src) {
        return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
      }
      const baseName = `${src.name} (copy)`
      let name = baseName
      let n = 2
      // name/slug are unique — find a free variant rather than 500ing.
      while (await db.plan.findFirst({ where: { name } })) {
        name = `${src.name} (copy ${n++})`
      }
      const {
        id: _id,
        createdAt: _c,
        updatedAt: _u,
        ...rest
      } = src as unknown as Record<string, unknown>
      const created = await db.plan.create({
        data: {
          ...(rest as object),
          name,
          slug: slugify(name),
          // A clone starts hidden so it can't be sold before it's reviewed.
          hidden: true,
          popular: false,
        } as never,
      })
      await logAudit({
        userId: auth.decoded.userId,
        action: 'plan.clone',
        resource: 'plan',
        resourceId: created.id,
        req: request,
        metadata: { from: src.id, name },
      }).catch(() => {})
      return NextResponse.json({ success: true, plan: shape(created as never) })
    }

    // ── Create ───────────────────────────────────────────────────────
    const name = String(body.name || '').trim()
    if (!name) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }
    const price = Number(body.price)
    if (!Number.isFinite(price) || price < 0) {
      return NextResponse.json(
        { error: 'Price must be a number >= 0' },
        { status: 400 }
      )
    }
    const billingCycle = String(body.billingCycle || 'monthly')
    if (!BILLING_CYCLES.includes(billingCycle as (typeof BILLING_CYCLES)[number])) {
      return NextResponse.json(
        { error: `billingCycle must be one of: ${BILLING_CYCLES.join(', ')}` },
        { status: 400 }
      )
    }
    const slug = slugify(String(body.slug || name))
    if (await db.plan.findFirst({ where: { OR: [{ name }, { slug }] } })) {
      return NextResponse.json(
        { error: 'A plan with that name or slug already exists' },
        { status: 409 }
      )
    }

    const created = await db.plan.create({
      data: {
        name,
        slug,
        description: String(body.description || ''),
        price,
        billingCycle,
        currency: String(body.currency || 'USD').toUpperCase(),
        trialDays: toLimit(body.trialDays) ?? 0,
        setupFee: toFloatLimit(body.setupFee) ?? 0,
        // Display strings (kept for the existing pricing cards)
        ram: String(body.ram || ''),
        cpu: String(body.cpu || ''),
        storage: String(body.storage || ''),
        bandwidth: String(body.bandwidth || ''),
        projects: toLimit(body.projects) ?? 1,
        ssl: body.ssl !== false,
        customDomain: body.customDomain === true,
        priority: toLimit(body.priority) ?? 0,
        popular: body.popular === true,
        active: body.active !== false,
        hidden: body.hidden === true,
        promotional: body.promotional === true,
        // Numeric limits
        diskMB: toLimit(body.diskMB),
        bandwidthMB: toLimit(body.bandwidthMB),
        cpuCores: toFloatLimit(body.cpuCores),
        ramMB: toLimit(body.ramMB),
        ioMBps: toLimit(body.ioMBps),
        processes: toLimit(body.processes),
        inodes: toLimit(body.inodes),
        maxDatabases: toLimit(body.maxDatabases),
        maxEmailAccounts: toLimit(body.maxEmailAccounts),
        maxFtpAccounts: toLimit(body.maxFtpAccounts),
        maxCronJobs: toLimit(body.maxCronJobs),
        maxBackups: toLimit(body.maxBackups),
        maxDnsZones: toLimit(body.maxDnsZones),
        maxDomains: toLimit(body.maxDomains),
        maxSubdomains: toLimit(body.maxSubdomains),
        maxParkedDomains: toLimit(body.maxParkedDomains),
        maxAddonDomains: toLimit(body.maxAddonDomains),
        maxSslCerts: toLimit(body.maxSslCerts),
        allowedApps: Array.isArray(body.allowedApps)
          ? JSON.stringify(body.allowedApps.map(String))
          : null,
      },
    })

    await logAudit({
      userId: auth.decoded.userId,
      action: 'plan.create',
      resource: 'plan',
      resourceId: created.id,
      req: request,
      metadata: { name, price, billingCycle },
    }).catch(() => {})

    return NextResponse.json({ success: true, plan: shape(created as never) })
  } catch (error) {
    console.error('[admin/plans] POST failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
