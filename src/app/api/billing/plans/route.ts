/**
 * GET /api/billing/plans
 *
 * The public plan catalogue: what powers the pricing cards and the comparison
 * table. No auth — this is the shop window.
 *
 * Only sellable plans are returned. The previous version returned every row,
 * which meant archived plans (kept alive purely so existing subscribers aren't
 * orphaned) were advertised to new customers at their old prices.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

/** Null/0 on a limit column means "unlimited" — say so rather than printing 0. */
function limit(value: number | null | undefined): number | null {
  if (value === null || value === undefined || value === 0) return null
  return value
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

/** Product families sold as plans. `hosting` is the web-hosting catalogue. */
const PLAN_TYPES = ['hosting', 'email', 'domain']

export async function GET(request: Request) {
  try {
    // Filter by product type. Email plans live in the same table but describe
    // mailboxes, not websites — served alongside hosting they rendered in the
    // hosting comparison table with every limit blank, which the "null means
    // unlimited" rule then displayed as unlimited RAM and storage.
    const requested = new URL(request.url).searchParams.get('type')
    const planType = requested && PLAN_TYPES.includes(requested) ? requested : 'hosting'

    const where = { active: true, hidden: false, archived: false, planType }

    // An empty result is returned as-is. There is deliberately no seed-on-read
    // fallback: it used to call seedDatabase(), which created Starter $9 /
    // Pro $29 / Business $79 — prices the business does not sell — and this
    // endpoint feeds the public pricing page directly. The catalogue is
    // established by `bun run scripts/seed-plans.ts`, not by someone loading a
    // page.
    const plans = await db.plan.findMany({ where, orderBy: { priority: 'asc' } })

    return NextResponse.json({
      plans: plans.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        planType: p.planType,
        description: p.description,
        tagline: p.tagline,
        idealFor: p.idealFor,
        badge: p.badge,
        popular: p.popular,
        priority: p.priority,

        // Pricing
        price: p.price,
        annualPrice: p.annualPrice,
        billingCycle: p.billingCycle,
        currency: p.currency,
        trialDays: p.trialDays,
        setupFee: p.setupFee,

        // Display strings
        ram: p.ram,
        cpu: p.cpu,
        storage: p.storage,
        bandwidth: p.bandwidth,

        // Numeric limits — null means unlimited
        websites: limit(p.projects),
        diskMB: limit(p.diskMB),
        bandwidthMB: limit(p.bandwidthMB),
        cpuCores: p.cpuCores,
        ramMB: limit(p.ramMB),
        inodes: limit(p.inodes),
        maxDatabases: limit(p.maxDatabases),
        maxEmailAccounts: limit(p.maxEmailAccounts),
        maxFtpAccounts: limit(p.maxFtpAccounts),
        maxCronJobs: limit(p.maxCronJobs),
        maxDomains: limit(p.maxDomains),
        maxSubdomains: limit(p.maxSubdomains),
        maxDnsZones: limit(p.maxDnsZones),
        maxSslCerts: limit(p.maxSslCerts),

        // Capabilities
        allowedApps: parseJsonArray(p.allowedApps),
        sshAccess: p.sshAccess,
        stagingEnvironment: p.stagingEnvironment,
        dockerSupport: p.dockerSupport,
        gitDeployment: p.gitDeployment,
        cdnIntegration: p.cdnIntegration,
        ssl: p.ssl,

        // Service tiers
        backupRetentionDays: p.backupRetentionDays,
        uptimeSla: p.uptimeSla,
        supportLevel: p.supportLevel,
        malwareScanner: p.malwareScanner,
        wafLevel: p.wafLevel,
        ddosLevel: p.ddosLevel,
        freeMigrations: p.freeMigrations,

        highlights: parseJsonArray(p.highlights),

        // Email-product fields — null on hosting plans.
        emailMailboxes: p.emailMailboxes,
        emailStoragePerMailboxGB: p.emailStoragePerMailboxGB,
        emailTotalStorageGB: p.emailTotalStorageGB,
      })),
    })
  } catch (error) {
    console.error('Get plans error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
