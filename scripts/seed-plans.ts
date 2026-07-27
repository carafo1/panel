/**
 * Seed the real hosting plans.
 *
 * Run:  bun run scripts/seed-plans.ts          (idempotent — safe to re-run)
 *       bun run scripts/seed-plans.ts --dry    (show what would change)
 *
 * Existing plans are ARCHIVED, never deleted: there is a live subscription on
 * the old Business plan, and deleting its plan row would orphan it. Archived
 * plans disappear from signup while existing subscribers keep running at the
 * price they agreed to, until someone deliberately migrates them.
 *
 * Everything here is editable afterwards in Admin → Plans. This script only
 * establishes the starting point.
 */
import { db } from '../src/lib/db'

const DRY = process.argv.includes('--dry')

/** Slugs this script owns. Anything else that exists gets archived. */
const MANAGED_SLUGS = ['starter', 'professional', 'enterprise']

interface PlanSeed {
  slug: string
  name: string
  description: string
  tagline: string
  idealFor: string
  badge: string | null
  price: number
  annualPrice: number
  priority: number
  popular: boolean

  // Display strings (kept for back-compat with older UI)
  ram: string
  cpu: string
  storage: string
  bandwidth: string
  projects: number

  // Numeric limits — null means unlimited
  ramMB: number
  diskMB: number
  cpuCores: number
  bandwidthMB: number | null
  inodes: number
  maxDatabases: number | null
  maxEmailAccounts: number | null
  maxFtpAccounts: number | null
  maxCronJobs: number | null
  maxDomains: number | null
  maxSubdomains: number | null
  maxDnsZones: number | null
  maxSslCerts: number | null

  // Capabilities
  allowedApps: string[]
  sshAccess: boolean
  stagingEnvironment: boolean
  dockerSupport: 'none' | 'optional' | 'included'
  gitDeployment: boolean
  cdnIntegration: boolean

  // Service tiers
  backupRetentionDays: number
  uptimeSla: string
  supportLevel: string
  malwareScanner: string
  wafLevel: string
  ddosLevel: string
  freeMigrations: number | null

  highlights: string[]
}

const PLANS: PlanSeed[] = [
  {
    slug: 'starter',
    name: 'Starter',
    description:
      'Perfect for personal websites, portfolios, blogs, and small businesses.',
    tagline: 'Great for personal websites',
    idealFor: 'Personal Blogs',
    badge: null,
    price: 4.99,
    annualPrice: 53.88,
    priority: 1,
    popular: false,

    ram: '1 GB',
    cpu: '1 vCPU',
    storage: '20 GB SSD',
    bandwidth: '100 GB',
    projects: 1,

    ramMB: 1024,
    diskMB: 20480,
    cpuCores: 1,
    bandwidthMB: 102400,
    inodes: 100000,
    maxDatabases: 5,
    maxEmailAccounts: 10,
    maxFtpAccounts: 5,
    maxCronJobs: 5,
    maxDomains: 1,
    maxSubdomains: 10,
    maxDnsZones: 1,
    maxSslCerts: null,

    allowedApps: ['wordpress', 'laravel', 'php'],
    sshAccess: false,
    stagingEnvironment: false,
    dockerSupport: 'none',
    gitDeployment: true,
    cdnIntegration: true,

    backupRetentionDays: 7,
    uptimeSla: '99.9%',
    supportLevel: 'Standard',
    malwareScanner: 'Basic',
    wafLevel: 'Standard',
    ddosLevel: 'Standard',
    freeMigrations: 1,

    highlights: [
      '1 Website',
      '20 GB SSD',
      '1 GB RAM',
      '1 vCPU',
      'Free SSL',
      'Daily Backups',
      'WordPress Ready',
      'Email Hosting',
      '24/7 Support',
    ],
  },
  {
    slug: 'professional',
    name: 'Professional',
    description:
      'Perfect for growing businesses, company websites, eCommerce stores, and developers.',
    tagline: 'Best value for growing businesses',
    idealFor: 'Business Websites',
    badge: 'Most Popular',
    price: 8.99,
    annualPrice: 95.88,
    priority: 2,
    popular: true,

    ram: '3 GB',
    cpu: '1 vCPU',
    storage: '80 GB SSD',
    bandwidth: 'Unlimited',
    projects: 10,

    ramMB: 3072,
    diskMB: 81920,
    cpuCores: 1,
    bandwidthMB: null,
    inodes: 300000,
    maxDatabases: null,
    maxEmailAccounts: null,
    maxFtpAccounts: null,
    maxCronJobs: null,
    maxDomains: 10,
    maxSubdomains: null,
    maxDnsZones: 10,
    maxSslCerts: null,

    allowedApps: ['wordpress', 'laravel', 'php', 'nodejs', 'python', 'nextjs'],
    sshAccess: true,
    stagingEnvironment: true,
    dockerSupport: 'optional',
    gitDeployment: true,
    cdnIntegration: true,

    backupRetentionDays: 14,
    uptimeSla: '99.95%',
    supportLevel: 'High',
    malwareScanner: 'Advanced',
    wafLevel: 'Advanced',
    ddosLevel: 'Advanced',
    freeMigrations: 10,

    highlights: [
      'Up to 10 Websites',
      '80 GB SSD',
      '3 GB RAM',
      '1 vCPU',
      'Unlimited Bandwidth',
      'Node.js & Python',
      'SSH Access',
      'Staging Environment',
      'Advanced Security',
      'Priority Support',
    ],
  },
  {
    slug: 'enterprise',
    name: 'Enterprise',
    description:
      'Perfect for agencies, SaaS platforms, high-traffic websites, and enterprise applications.',
    tagline: 'Maximum performance for agencies and large projects',
    idealFor: 'Agencies & High-Traffic Apps',
    badge: null,
    price: 17.99,
    annualPrice: 197.88,
    priority: 3,
    popular: false,

    ram: '6 GB',
    cpu: '2 vCPU',
    storage: '200 GB SSD',
    bandwidth: 'Unlimited',
    projects: 0, // 0 = unlimited

    ramMB: 6144,
    diskMB: 204800,
    cpuCores: 2,
    bandwidthMB: null,
    inodes: 800000,
    maxDatabases: null,
    maxEmailAccounts: null,
    maxFtpAccounts: null,
    maxCronJobs: null,
    maxDomains: null,
    maxSubdomains: null,
    maxDnsZones: null,
    maxSslCerts: null,

    allowedApps: [
      'wordpress',
      'laravel',
      'php',
      'nodejs',
      'python',
      'nextjs',
      'docker',
    ],
    sshAccess: true,
    stagingEnvironment: true,
    dockerSupport: 'included',
    gitDeployment: true,
    cdnIntegration: true,

    backupRetentionDays: 30,
    uptimeSla: '99.99%',
    supportLevel: 'VIP 24/7',
    malwareScanner: 'Premium',
    wafLevel: 'Enterprise',
    ddosLevel: 'Premium',
    freeMigrations: null,

    highlights: [
      'Unlimited Websites',
      '200 GB SSD',
      '6 GB RAM',
      '2 vCPU',
      'Unlimited Databases & Email Accounts',
      'Docker Support',
      'Premium Backups (30 Days)',
      'Premium DDoS & WAF',
      'VIP 24/7 Support',
      '99.99% Uptime SLA',
    ],
  },
]

async function main() {
  console.log(DRY ? '— DRY RUN, nothing will be written —\n' : '')

  // ── Archive anything we are not managing ──────────────────────────
  const existing = await db.plan.findMany({
    select: { id: true, slug: true, name: true, price: true, archived: true },
  })

  for (const plan of existing) {
    if (MANAGED_SLUGS.includes(plan.slug)) continue
    if (plan.archived) continue

    const subs = await db.subscription.count({
      where: { planId: plan.id, status: { in: ['active', 'trialing', 'past_due'] } },
    })
    console.log(
      `archive  ${plan.name} ($${plan.price}) — ${subs} live subscription(s) keep running`
    )
    if (!DRY) {
      await db.plan.update({
        where: { id: plan.id },
        data: { archived: true, hidden: true, active: false },
      })
    }
  }

  // ── Upsert the real plans ─────────────────────────────────────────
  for (const p of PLANS) {
    const data = {
      name: p.name,
      description: p.description,
      tagline: p.tagline,
      idealFor: p.idealFor,
      badge: p.badge,
      price: p.price,
      annualPrice: p.annualPrice,
      billingCycle: 'monthly',
      currency: 'USD',
      priority: p.priority,
      popular: p.popular,

      ram: p.ram,
      cpu: p.cpu,
      storage: p.storage,
      bandwidth: p.bandwidth,
      projects: p.projects,
      ssl: true,
      customDomain: true,

      ramMB: p.ramMB,
      diskMB: p.diskMB,
      cpuCores: p.cpuCores,
      bandwidthMB: p.bandwidthMB,
      inodes: p.inodes,
      maxDatabases: p.maxDatabases,
      maxEmailAccounts: p.maxEmailAccounts,
      maxFtpAccounts: p.maxFtpAccounts,
      maxCronJobs: p.maxCronJobs,
      maxDomains: p.maxDomains,
      maxSubdomains: p.maxSubdomains,
      maxDnsZones: p.maxDnsZones,
      maxSslCerts: p.maxSslCerts,

      allowedApps: JSON.stringify(p.allowedApps),
      sshAccess: p.sshAccess,
      stagingEnvironment: p.stagingEnvironment,
      dockerSupport: p.dockerSupport,
      gitDeployment: p.gitDeployment,
      cdnIntegration: p.cdnIntegration,

      backupRetentionDays: p.backupRetentionDays,
      uptimeSla: p.uptimeSla,
      supportLevel: p.supportLevel,
      malwareScanner: p.malwareScanner,
      wafLevel: p.wafLevel,
      ddosLevel: p.ddosLevel,
      freeMigrations: p.freeMigrations,

      highlights: JSON.stringify(p.highlights),

      active: true,
      hidden: false,
      archived: false,
    }

    const found = await db.plan.findUnique({ where: { slug: p.slug } })
    console.log(
      `${found ? 'update  ' : 'create  '} ${p.name}  $${p.price}/mo  $${p.annualPrice}/yr`
    )
    if (DRY) continue

    await db.plan.upsert({
      where: { slug: p.slug },
      update: data,
      create: { slug: p.slug, ...data },
    })
  }

  console.log('\ndone.')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
