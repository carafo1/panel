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
import { seedDatabase } from '@/lib/seed'

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

export async function GET() {
  try {
    const where = { active: true, hidden: false, archived: false }

    let plans = await db.plan.findMany({ where, orderBy: { priority: 'asc' } })

    // First boot only: seed when the catalogue is genuinely empty. Guard on the
    // total count, not the filtered one — otherwise an operator who archives
    // every plan deliberately gets the demo catalogue silently reinstated.
    if (plans.length === 0 && (await db.plan.count()) === 0) {
      await seedDatabase()
      plans = await db.plan.findMany({ where, orderBy: { priority: 'asc' } })
    }

    return NextResponse.json({
      plans: plans.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
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
      })),
    })
  } catch (error) {
    console.error('Get plans error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
