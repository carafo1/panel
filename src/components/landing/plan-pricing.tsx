'use client'

/**
 * Public hosting pricing, rendered from the billing catalogue.
 *
 * The landing pages used to render hosting plans from CMS `ServicePlan` rows
 * while checkout charged from the `Plan` table. They had drifted completely
 * apart — the site advertised Hobby $9 / Pro $29 / Business $99 while checkout
 * billed Starter $4.99 / Professional $8.99 / Enterprise $17.99. Anything a
 * customer reads here must be the thing they are actually charged, so these
 * components read /api/billing/plans and nothing else.
 *
 * Everything shown is editable in Admin → Plans.
 */
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Check, Minus, Loader2 } from 'lucide-react'
import { ScrollReveal, StaggerCard } from './ui-helpers'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PublicPlan {
  id: string
  slug: string
  name: string
  description: string
  tagline: string | null
  idealFor: string | null
  badge: string | null
  popular: boolean

  price: number
  annualPrice: number | null
  currency: string

  ram: string
  cpu: string
  storage: string
  bandwidth: string

  websites: number | null
  diskMB: number | null
  bandwidthMB: number | null
  cpuCores: number | null
  ramMB: number | null
  inodes: number | null
  maxDatabases: number | null
  maxEmailAccounts: number | null
  maxFtpAccounts: number | null
  maxCronJobs: number | null
  maxDomains: number | null
  maxSubdomains: number | null
  maxDnsZones: number | null
  maxSslCerts: number | null

  allowedApps: string[]
  sshAccess: boolean
  stagingEnvironment: boolean
  dockerSupport: string | null
  gitDeployment: boolean
  cdnIntegration: boolean
  ssl: boolean

  backupRetentionDays: number | null
  uptimeSla: string | null
  supportLevel: string | null
  malwareScanner: string | null
  wafLevel: string | null
  ddosLevel: string | null
  freeMigrations: number | null

  highlights: string[]
}

export type BillingPeriod = 'monthly' | 'yearly'

// ─── Data ─────────────────────────────────────────────────────────────────────

export function usePublicPlans() {
  const [plans, setPlans] = useState<PublicPlan[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch('/api/billing/plans')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setPlans(data.plans || [])
      })
      .catch(() => {
        if (!cancelled) setPlans([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { plans, loading }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** Null means unlimited throughout the plan catalogue. */
function limitText(value: number | null | undefined): string {
  return value === null || value === undefined ? 'Unlimited' : value.toLocaleString()
}

function storageText(mb: number | null): string {
  if (mb === null) return 'Unlimited'
  return mb >= 1024 ? `${Math.round(mb / 1024)} GB` : `${mb} MB`
}

function ramText(mb: number | null): string {
  if (mb === null) return 'Unlimited'
  return mb >= 1024 ? `${(mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1)} GB` : `${mb} MB`
}

function dockerText(level: string | null): string {
  if (level === 'included') return 'Included'
  if (level === 'optional') return 'Optional'
  return '—'
}

/**
 * What the customer pays per month on the yearly plan, so the toggle can show a
 * comparable number rather than a 12x figure next to a monthly one.
 */
export function monthlyEquivalent(plan: PublicPlan): number | null {
  if (!plan.annualPrice) return null
  return plan.annualPrice / 12
}

/** Percentage saved by paying yearly, rounded — omitted when there's no saving. */
export function yearlySavingPercent(plan: PublicPlan): number | null {
  if (!plan.annualPrice) return null
  const fullYear = plan.price * 12
  if (fullYear <= plan.annualPrice) return null
  return Math.round(((fullYear - plan.annualPrice) / fullYear) * 100)
}

// ─── Billing toggle ───────────────────────────────────────────────────────────

export function BillingToggle({
  value,
  onChange,
  savingPercent,
}: {
  value: BillingPeriod
  onChange: (v: BillingPeriod) => void
  savingPercent?: number | null
}) {
  return (
    <div className="flex items-center justify-center gap-3 flex-wrap">
      <div className="inline-flex rounded-full border bg-card p-1">
        {(['monthly', 'yearly'] as BillingPeriod[]).map((period) => (
          <button
            key={period}
            type="button"
            onClick={() => onChange(period)}
            className={`px-5 py-1.5 text-sm rounded-full transition-all ${
              value === period
                ? 'bg-indigo-500 text-white shadow-glow-indigo'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {period === 'monthly' ? 'Monthly' : 'Yearly'}
          </button>
        ))}
      </div>
      {savingPercent ? (
        <Badge
          variant="outline"
          className="bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30"
        >
          Save up to {savingPercent}%
        </Badge>
      ) : null}
    </div>
  )
}

// ─── Pricing cards ────────────────────────────────────────────────────────────

export function PlanPricingCards({
  plans,
  period,
  onGetStarted,
}: {
  plans: PublicPlan[]
  period: BillingPeriod
  onGetStarted: (plan: PublicPlan) => void
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
      {plans.map((plan, i) => {
        const yearly = period === 'yearly' && plan.annualPrice
        const shown = yearly ? monthlyEquivalent(plan)! : plan.price
        const saving = yearlySavingPercent(plan)
        const featured = plan.popular || Boolean(plan.badge)

        return (
          <StaggerCard key={plan.id} index={i}>
            <Card
              className={`relative flex flex-col h-full transition-all duration-500 bg-card/80 backdrop-blur-sm ${
                featured
                  ? 'border-indigo-500 shadow-glow-indigo scale-[1.02] shimmer-border'
                  : 'hover:border-indigo-500/30 hover:shadow-modern-lg'
              }`}
            >
              {featured && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap">
                  <Badge className="bg-gradient-to-r from-indigo-400 to-indigo-600 text-white border-0 px-4 py-0.5 shadow-glow-indigo">
                    {plan.badge || 'POPULAR'}
                  </Badge>
                </div>
              )}
              <CardContent className="p-6 flex flex-col flex-1">
                <h3 className="text-lg font-bold mb-0.5">{plan.name}</h3>
                {plan.tagline && (
                  <p className="text-xs text-indigo-600 dark:text-indigo-400 mb-2">
                    {plan.tagline}
                  </p>
                )}
                <p className="text-xs text-muted-foreground mb-4">{plan.description}</p>

                <div className="mb-1 flex items-baseline gap-1">
                  <span className="text-4xl font-extrabold">
                    ${shown.toFixed(2)}
                  </span>
                  <span className="text-sm text-muted-foreground">/mo</span>
                </div>
                <p className="text-xs text-muted-foreground mb-6 min-h-[1rem]">
                  {yearly
                    ? `$${plan.annualPrice!.toFixed(2)} billed yearly${
                        saving ? ` · save ${saving}%` : ''
                      }`
                    : 'billed monthly'}
                </p>

                <ul className="space-y-2.5 mb-6 flex-1">
                  {plan.highlights.map((feat) => (
                    <li key={feat} className="flex items-start gap-2 text-sm">
                      <Check className="size-4 text-indigo-500 shrink-0 mt-0.5" />
                      <span className="text-muted-foreground">{feat}</span>
                    </li>
                  ))}
                </ul>

                <Button
                  onClick={() => onGetStarted(plan)}
                  className={
                    featured
                      ? 'btn-shimmer w-full bg-indigo-500 hover:bg-indigo-600 text-white border-0 shadow-glow-indigo'
                      : 'w-full'
                  }
                  variant={featured ? 'default' : 'outline'}
                >
                  Get Started
                </Button>
              </CardContent>
            </Card>
          </StaggerCard>
        )
      })}
    </div>
  )
}

// ─── Comparison table ─────────────────────────────────────────────────────────

type CellValue = string | boolean

interface ComparisonRow {
  group: string
  label: string
  value: (p: PublicPlan) => CellValue
}

/**
 * The comparison matrix. Every row reads from the plan record, so adding a plan
 * or editing a limit in Admin → Plans changes this table with no code edit.
 */
const COMPARISON_ROWS: ComparisonRow[] = [
  { group: 'Overview', label: 'Ideal For', value: (p) => p.idealFor || '—' },
  { group: 'Overview', label: 'Websites', value: (p) => limitText(p.websites) },

  { group: 'Resources', label: 'SSD Storage', value: (p) => storageText(p.diskMB) },
  { group: 'Resources', label: 'Monthly Bandwidth', value: (p) => (p.bandwidthMB === null ? 'Unlimited' : storageText(p.bandwidthMB)) },
  { group: 'Resources', label: 'CPU', value: (p) => (p.cpuCores ? `${p.cpuCores} vCPU` : '—') },
  { group: 'Resources', label: 'RAM', value: (p) => ramText(p.ramMB) },
  { group: 'Resources', label: 'Inodes', value: (p) => limitText(p.inodes) },

  { group: 'Accounts', label: 'Databases', value: (p) => limitText(p.maxDatabases) },
  { group: 'Accounts', label: 'Email Accounts', value: (p) => limitText(p.maxEmailAccounts) },
  { group: 'Accounts', label: 'FTP Accounts', value: (p) => limitText(p.maxFtpAccounts) },
  { group: 'Accounts', label: 'Cron Jobs', value: (p) => limitText(p.maxCronJobs) },

  { group: 'Domains', label: 'Domains', value: (p) => limitText(p.maxDomains) },
  { group: 'Domains', label: 'Subdomains', value: (p) => limitText(p.maxSubdomains) },
  { group: 'Domains', label: 'DNS Zones', value: (p) => limitText(p.maxDnsZones) },
  { group: 'Domains', label: 'SSL Certificates', value: (p) => (p.ssl ? 'Free Unlimited' : '—') },

  { group: 'Backups', label: 'Daily Backups', value: () => true },
  { group: 'Backups', label: 'Backup Retention', value: (p) => (p.backupRetentionDays ? `${p.backupRetentionDays} Days` : '—') },

  { group: 'Development', label: 'WordPress Optimized', value: (p) => p.allowedApps.includes('wordpress') },
  { group: 'Development', label: 'Laravel', value: (p) => p.allowedApps.includes('laravel') },
  { group: 'Development', label: 'Node.js', value: (p) => p.allowedApps.includes('nodejs') },
  { group: 'Development', label: 'Python', value: (p) => p.allowedApps.includes('python') },
  { group: 'Development', label: 'Docker', value: (p) => dockerText(p.dockerSupport) },
  { group: 'Development', label: 'Git Deployment', value: (p) => p.gitDeployment },
  { group: 'Development', label: 'SSH Access', value: (p) => p.sshAccess },
  { group: 'Development', label: 'Staging Environment', value: (p) => p.stagingEnvironment },

  { group: 'Security', label: 'Malware Scanner', value: (p) => p.malwareScanner || '—' },
  { group: 'Security', label: 'WAF Protection', value: (p) => p.wafLevel || '—' },
  { group: 'Security', label: 'DDoS Protection', value: (p) => p.ddosLevel || '—' },
  { group: 'Security', label: 'CDN Integration', value: (p) => p.cdnIntegration },

  { group: 'Support', label: 'Uptime SLA', value: (p) => p.uptimeSla || '—' },
  { group: 'Support', label: 'Priority Support', value: (p) => p.supportLevel || '—' },
  { group: 'Support', label: 'Free Migration', value: (p) => (p.freeMigrations === null ? 'Unlimited' : `${p.freeMigrations} Website${p.freeMigrations === 1 ? '' : 's'}`) },
]

function Cell({ value }: { value: CellValue }) {
  if (value === true) return <Check className="size-4 text-indigo-500 mx-auto" />
  if (value === false) return <Minus className="size-4 text-muted-foreground/50 mx-auto" />
  return <span>{value}</span>
}

export function PlanComparisonTable({
  plans,
  period,
}: {
  plans: PublicPlan[]
  period: BillingPeriod
}) {
  if (plans.length === 0) return null

  const groups = Array.from(new Set(COMPARISON_ROWS.map((r) => r.group)))

  return (
    // The table is wider than a phone. Scroll it inside its own container so
    // the page body never scrolls sideways.
    <div className="overflow-x-auto rounded-xl border bg-card/60 backdrop-blur-sm">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="sticky top-0 bg-card/95 backdrop-blur-sm">
          <tr className="border-b">
            <th className="text-start font-semibold p-4 w-[30%]">Feature</th>
            {plans.map((p) => (
              <th key={p.id} className="p-4 text-center">
                <div className="font-bold">{p.name}</div>
                <div className="text-xs font-normal text-muted-foreground mt-0.5">
                  {period === 'yearly' && p.annualPrice
                    ? `$${(p.annualPrice / 12).toFixed(2)}/mo`
                    : `$${p.price.toFixed(2)}/mo`}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <>
              <tr key={group} className="bg-muted/40">
                <td
                  colSpan={plans.length + 1}
                  className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  {group}
                </td>
              </tr>
              {COMPARISON_ROWS.filter((r) => r.group === group).map((row) => (
                <tr key={`${group}-${row.label}`} className="border-b last:border-0">
                  <td className="p-3 px-4 text-muted-foreground">{row.label}</td>
                  {plans.map((p) => (
                    <td key={p.id} className="p-3 px-4 text-center">
                      <Cell value={row.value(p)} />
                    </td>
                  ))}
                </tr>
              ))}
            </>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Full section (cards + toggle + comparison) ───────────────────────────────

export function HostingPlansSection({
  onGetStarted,
  showComparison = true,
  title,
  subtitle,
}: {
  onGetStarted: (plan?: PublicPlan) => void
  showComparison?: boolean
  title?: string
  subtitle?: string
}) {
  const { plans, loading } = usePublicPlans()
  const [period, setPeriod] = useState<BillingPeriod>('monthly')

  const bestSaving = plans.reduce<number | null>((best, p) => {
    const s = yearlySavingPercent(p)
    return s !== null && (best === null || s > best) ? s : best
  }, null)

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="size-6 animate-spin text-indigo-500" />
      </div>
    )
  }

  if (plans.length === 0) return null

  return (
    <div className="space-y-10">
      {(title || subtitle) && (
        <ScrollReveal>
          <div className="text-center">
            {title && (
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
                <span className="text-gradient-brand">{title}</span>
              </h2>
            )}
            {subtitle && (
              <p className="mt-3 text-muted-foreground max-w-2xl mx-auto">{subtitle}</p>
            )}
          </div>
        </ScrollReveal>
      )}

      <ScrollReveal>
        <BillingToggle value={period} onChange={setPeriod} savingPercent={bestSaving} />
      </ScrollReveal>

      <PlanPricingCards plans={plans} period={period} onGetStarted={onGetStarted} />

      {showComparison && (
        <ScrollReveal>
          <div className="pt-6">
            <h3 className="text-xl font-bold text-center mb-6">Compare plans</h3>
            <PlanComparisonTable plans={plans} period={period} />
          </div>
        </ScrollReveal>
      )}
    </div>
  )
}
