/**
 * Email hosting — plans, provisioning and limits
 * ==============================================
 *
 * Standalone email hosting: a customer buys mailboxes on their own domain
 * without buying website hosting. The service is modelled by `EmailService`
 * (deliberately not `Project`, which always implies a website).
 *
 * Mailcow is the mail engine; this module owns the commercial layer on top —
 * what the plan allows, what has been provisioned, and whether the customer is
 * within their limits. Low-level Mailcow calls live in `mailcow.ts`
 * (domain/mailbox lifecycle) and `mailcow-manage.ts` (aliases, spam, logs).
 */
import { db } from '@/lib/db'
import {
  addDomain,
  deleteMailbox,
  editDomain,
  generateDkim,
  removeDomain,
} from '@/lib/mailcow'
import { listMailboxes } from '@/lib/mailcow'

// ─── Plan catalogue ────────────────────────────────────────────────────────

export interface EmailPlanSpec {
  slug: string
  name: string
  description: string
  tagline: string
  price: number
  mailboxes: number
  storagePerMailboxGB: number
  totalStorageGB: number
  popular: boolean
  badge?: string
  priority: number
}

/**
 * The published email-hosting line-up. Kept in code so the plans can be seeded
 * (and re-seeded) deterministically; the DB row remains the source of truth for
 * pricing once created, so an admin price edit is never overwritten.
 */
export const EMAIL_PLANS: EmailPlanSpec[] = [
  {
    slug: 'starter-email',
    name: 'Starter Email',
    description: 'Professional email for personal use, freelancers and small businesses.',
    tagline: 'Your own domain email, without the clutter',
    price: 1.99,
    mailboxes: 3,
    storagePerMailboxGB: 2,
    totalStorageGB: 6,
    popular: false,
    priority: 10,
  },
  {
    slug: 'business-email',
    name: 'Business Email',
    description: 'Email for small companies that need room to grow.',
    tagline: 'Everything a small team needs',
    price: 4.99,
    mailboxes: 10,
    storagePerMailboxGB: 5,
    totalStorageGB: 50,
    popular: true,
    badge: 'Most Popular',
    priority: 20,
  },
  {
    slug: 'professional-email',
    name: 'Professional Email',
    description: 'Email for growing businesses and organisations.',
    tagline: 'Scale without thinking about mailboxes',
    price: 9.99,
    mailboxes: 25,
    storagePerMailboxGB: 10,
    totalStorageGB: 250,
    popular: false,
    priority: 30,
  },
]

/** Paid extras, priced per month unless stated. */
export const EMAIL_ADDONS = {
  extraMailbox: { label: 'Extra mailbox', price: 0.75, unit: 'mailbox' },
  extraStorage10GB: { label: 'Extra 10 GB storage', price: 1.0, unit: '10GB' },
  migration: { label: 'Email migration service', priceFrom: 10, priceTo: 25, oneTime: true },
} as const

/**
 * Create or refresh the email plans. Existing rows keep their price and
 * marketing copy — an admin may have tuned them — while the resource limits
 * are kept in step with the catalogue above.
 */
export async function seedEmailPlans(): Promise<{ created: number; updated: number }> {
  let created = 0
  let updated = 0
  for (const p of EMAIL_PLANS) {
    const existing = await db.plan.findUnique({ where: { slug: p.slug } })
    const limits = {
      planType: 'email',
      emailMailboxes: p.mailboxes,
      emailStoragePerMailboxGB: p.storagePerMailboxGB,
      emailTotalStorageGB: p.totalStorageGB,
      maxEmailAccounts: p.mailboxes,
    }
    if (existing) {
      await db.plan.update({ where: { id: existing.id }, data: limits })
      updated++
    } else {
      await db.plan.create({
        data: {
          slug: p.slug,
          name: p.name,
          description: p.description,
          tagline: p.tagline,
          price: p.price,
          currency: 'USD',
          billingCycle: 'monthly',
          popular: p.popular,
          badge: p.badge ?? null,
          priority: p.priority,
          active: true,
          // An email plan sells no compute; these display strings exist for
          // back-compat with the hosting-shaped Plan model.
          ram: '—',
          cpu: '—',
          storage: `${p.totalStorageGB}GB mail`,
          bandwidth: '—',
          projects: 0,
          ssl: true,
          customDomain: true,
          ...limits,
        },
      })
      created++
    }
  }
  return { created, updated }
}

// ─── Limits ────────────────────────────────────────────────────────────────

export interface EmailServiceLimits {
  mailboxLimit: number
  storagePerMailboxGB: number
  totalStorageGB: number
}

/** Plan allowance plus any purchased add-ons. */
export function effectiveLimits(service: {
  mailboxLimit: number
  storagePerMailboxGB: number
  totalStorageGB: number
  extraMailboxes: number
  extraStorageGB: number
}): EmailServiceLimits {
  return {
    mailboxLimit: service.mailboxLimit + (service.extraMailboxes || 0),
    storagePerMailboxGB: service.storagePerMailboxGB,
    totalStorageGB: service.totalStorageGB + (service.extraStorageGB || 0),
  }
}

export interface EmailUsage {
  mailboxes: number
  mailboxLimit: number
  usedBytes: number
  totalStorageBytes: number
  storagePerMailboxGB: number
  /** true when another mailbox would exceed the plan */
  atMailboxLimit: boolean
  percentStorage: number
}

/** Live usage for a service, read from Mailcow. */
export async function getEmailUsage(service: {
  domain: string
  mailboxLimit: number
  storagePerMailboxGB: number
  totalStorageGB: number
  extraMailboxes: number
  extraStorageGB: number
}): Promise<EmailUsage> {
  const limits = effectiveLimits(service)
  // listMailboxes returns { success, mailboxes }, not a bare array.
  const res = await listMailboxes(service.domain).catch(() => ({
    success: false as const,
    mailboxes: [] as Array<{ usedQuota?: number }>,
  }))
  const list = res.success && Array.isArray(res.mailboxes) ? res.mailboxes : []
  const usedBytes = list.reduce((sum, b) => sum + (Number(b.usedQuota) || 0), 0)
  const totalStorageBytes = limits.totalStorageGB * 1024 ** 3
  return {
    mailboxes: list.length,
    mailboxLimit: limits.mailboxLimit,
    usedBytes,
    totalStorageBytes,
    storagePerMailboxGB: limits.storagePerMailboxGB,
    atMailboxLimit: list.length >= limits.mailboxLimit,
    percentStorage: totalStorageBytes
      ? Math.min(100, Math.round((usedBytes / totalStorageBytes) * 100))
      : 0,
  }
}

// ─── DNS ───────────────────────────────────────────────────────────────────

export interface EmailDnsRecord {
  type: 'MX' | 'TXT' | 'CNAME'
  host: string
  value: string
  priority?: number
  label: string
  required: boolean
}

/**
 * The DNS a customer must publish for mail to work.
 *
 * The MX target comes from MAIL_SERVER_HOSTNAME rather than being hard-coded:
 * it has to match the mail server's TLS certificate, so it is deployment
 * configuration, not a constant.
 */
export function emailDnsRecords(
  domain: string,
  opts: { dkimSelector?: string; dkimValue?: string; serverIp?: string } = {}
): EmailDnsRecord[] {
  const host = process.env.MAIL_SERVER_HOSTNAME || 'mail.apsamo.com'
  const ip = opts.serverIp || process.env.MAIL_SERVER_IP || ''
  // Fallback matches the selector addDomain registers with Mailcow ('mail'),
  // so the record is right even if the selector lookup came back empty.
  const selector = opts.dkimSelector || 'mail'
  const records: EmailDnsRecord[] = [
    {
      type: 'MX',
      host: '@',
      value: host,
      priority: 10,
      label: 'Mail delivery',
      required: true,
    },
    {
      type: 'TXT',
      host: '@',
      value: ip ? `v=spf1 mx a ip4:${ip} ~all` : 'v=spf1 mx a ~all',
      label: 'SPF — who may send as your domain',
      required: true,
    },
    {
      type: 'TXT',
      host: '_dmarc',
      value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`,
      label: 'DMARC — what to do with failures',
      required: true,
    },
    {
      type: 'CNAME',
      host: 'autodiscover',
      value: host,
      label: 'Autodiscover — Outlook setup',
      required: false,
    },
    {
      type: 'CNAME',
      host: 'autoconfig',
      value: host,
      label: 'Autoconfig — Thunderbird setup',
      required: false,
    },
  ]
  if (opts.dkimValue) {
    records.splice(2, 0, {
      type: 'TXT',
      host: `${selector}._domainkey`,
      value: opts.dkimValue,
      label: 'DKIM — signs your outgoing mail',
      required: true,
    })
  }
  return records
}

// ─── Provisioning ──────────────────────────────────────────────────────────

export interface ProvisionEmailResult {
  success: boolean
  serviceId?: string
  error?: string
}

const normaliseDomain = (d: string) =>
  (d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '')

/**
 * Stand up a paid email service: record it, create the domain in Mailcow with
 * the plan's quota, and generate DKIM.
 *
 * Idempotent by domain — a repeated call (payment webhook retry, manual
 * re-run) updates the existing service rather than creating a second one or
 * failing outright.
 */
export async function provisionEmailService(opts: {
  userId: string
  planId: string
  domain: string
  subscriptionId?: string | null
}): Promise<ProvisionEmailResult> {
  const domain = normaliseDomain(opts.domain)
  if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain)) {
    return { success: false, error: 'That does not look like a valid domain name' }
  }

  const plan = await db.plan.findUnique({ where: { id: opts.planId } })
  if (!plan) return { success: false, error: 'Plan not found' }

  const mailboxes = plan.emailMailboxes ?? plan.maxEmailAccounts ?? 1
  const perBox = plan.emailStoragePerMailboxGB ?? 1
  const total = plan.emailTotalStorageGB ?? mailboxes * perBox

  // A domain may only be hosted by one customer.
  const clash = await db.emailService.findUnique({ where: { domain } })
  if (clash && clash.userId !== opts.userId) {
    return { success: false, error: 'Email hosting for this domain already exists' }
  }

  // If the domain is already known to the panel under a different account, it
  // is not the buyer's to take — checked before touching Mailcow, so it holds
  // whether the mail domain is being created fresh or adopted.
  const ownedByAnother = await db.domain.findFirst({
    where: { name: domain, userId: { not: opts.userId } },
    select: { id: true },
  })
  if (ownedByAnother) {
    return {
      success: false,
      error: 'This domain is already registered to another account',
    }
  }

  /**
   * `domain` is globally unique, so a row left behind by a FAILED attempt would
   * block the rightful owner from ever buying email for that domain. Anything
   * this call created must therefore be removed if provisioning does not
   * complete. A pre-existing row (`clash`) is kept — it is a real service.
   */
  const discardOnFailure = async () => {
    if (!clash) {
      await db.emailService.deleteMany({ where: { domain, userId: opts.userId } })
    }
  }

  const service = clash
    ? await db.emailService.update({
        where: { id: clash.id },
        data: {
          planId: plan.id,
          subscriptionId: opts.subscriptionId ?? clash.subscriptionId,
          mailboxLimit: mailboxes,
          storagePerMailboxGB: perBox,
          totalStorageGB: total,
          status: clash.status === 'cancelled' ? 'pending' : clash.status,
          lastError: null,
        },
      })
    : await db.emailService.create({
        data: {
          userId: opts.userId,
          planId: plan.id,
          subscriptionId: opts.subscriptionId ?? null,
          domain,
          status: 'pending',
          mailboxLimit: mailboxes,
          storagePerMailboxGB: perBox,
          totalStorageGB: total,
        },
      })

  // ── Mailcow: domain + DKIM ──
  try {
    if (!service.mailcowDomainCreated) {
      const res = await addDomain({
        domain,
        description: `Apsamo email hosting — ${plan.name}`,
        mailboxes,
        aliases: Math.max(mailboxes * 4, 20),
        // addDomain's `quota` is the PER-MAILBOX ceiling in MB; it derives the
        // domain total itself. Passing the plan total here would hand every
        // mailbox the whole allowance.
        quota: perBox * 1024,
      })
      if (!res.success) {
        // "domain_exists" is normal, not an error: the domain may be left over
        // from a cancelled service, or already carried by this customer's web
        // hosting. Ownership was proven above, so adopt it.
        if (!/domain_exists/i.test(res.error || '')) {
          const message = res.error || 'Could not create the mail domain'
          await db.emailService.update({
            where: { id: service.id },
            data: { lastError: message },
          })
          await discardOnFailure()
          return { success: false, error: message }
        }
      }
      // addDomain multiplies per-mailbox × mailboxes for the domain total,
      // which only matches when the plan's total is exactly that product.
      // Set the exact figures so plans like 10 × 5GB capped at 50GB hold.
      await syncMailcowLimits(service)
    }

    let dkimOk = service.dkimGenerated
    if (!dkimOk) {
      const dk = await generateDkim(domain)
      dkimOk = dk.success
    }

    await db.emailService.update({
      where: { id: service.id },
      data: {
        mailcowDomainCreated: true,
        dkimGenerated: dkimOk,
        status: 'active',
        provisionedAt: new Date(),
        lastError: null,
      },
    })
    return { success: true, serviceId: service.id }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Provisioning failed'
    await db.emailService
      .update({ where: { id: service.id }, data: { lastError: message } })
      .catch(() => {})
    await discardOnFailure()
    return { success: false, error: message }
  }
}

/**
 * Push a service's *effective* allowance (plan + purchased add-ons) onto the
 * Mailcow domain.
 *
 * Both ceilings have to agree. Ours decides what the panel offers; Mailcow's
 * decides what actually gets created — so a customer who buys an extra mailbox
 * would otherwise pass our check and then be refused by Mailcow with
 * "max_mailbox_exceeded". Call this after anything that changes an allowance.
 */
export async function syncMailcowLimits(service: {
  id: string
  domain: string
  mailboxLimit: number
  storagePerMailboxGB: number
  totalStorageGB: number
  extraMailboxes: number
  extraStorageGB: number
}): Promise<{ success: boolean; error?: string }> {
  const limits = effectiveLimits(service)
  const res = await editDomain({
    domain: service.domain,
    mailboxes: limits.mailboxLimit,
    maxQuotaMB: limits.storagePerMailboxGB * 1024,
    totalQuotaMB: limits.totalStorageGB * 1024,
  })
  // Record the failure rather than swallowing it: a silent mismatch here shows
  // up much later as an unexplained refusal to create a mailbox.
  await db.emailService
    .update({
      where: { id: service.id },
      data: { lastError: res.success ? null : `limit sync: ${res.error}` },
    })
    .catch(() => {})
  return res
}

/**
 * Suspend for non-payment. Deactivating the domain in Mailcow is what makes
 * this real — incoming mail is refused and logins stop. Nothing is deleted, so
 * `resumeEmailService` restores the account intact once the invoice is paid.
 */
export async function suspendEmailService(
  serviceId: string
): Promise<{ success: boolean; error?: string }> {
  const service = await db.emailService.findUnique({ where: { id: serviceId } })
  if (!service) return { success: false, error: 'Service not found' }
  const res = await editDomain({ domain: service.domain, active: false })
  await db.emailService.update({
    where: { id: serviceId },
    data: {
      status: 'suspended',
      suspendedAt: new Date(),
      lastError: res.success ? null : `suspend: ${res.error}`,
    },
  })
  return res
}

export async function resumeEmailService(
  serviceId: string
): Promise<{ success: boolean; error?: string }> {
  const service = await db.emailService.findUnique({ where: { id: serviceId } })
  if (!service) return { success: false, error: 'Service not found' }
  const res = await editDomain({ domain: service.domain, active: true })
  await db.emailService.update({
    where: { id: serviceId },
    data: {
      status: 'active',
      suspendedAt: null,
      lastError: res.success ? null : `resume: ${res.error}`,
    },
  })
  return res
}

/**
 * Terminate a service and remove the domain from Mailcow. Destructive: every
 * mailbox and all stored mail for the domain goes with it, so callers must
 * only reach this after a grace period has elapsed.
 */
export async function terminateEmailService(
  serviceId: string
): Promise<{ success: boolean; error?: string }> {
  const service = await db.emailService.findUnique({ where: { id: serviceId } })
  if (!service) return { success: false, error: 'Service not found' }

  // Mailcow refuses to drop a domain that still holds mailboxes
  // ("domain_not_empty"), so empty it first — otherwise termination reports
  // success in our DB while the domain quietly keeps receiving mail.
  const existing = await listMailboxes(service.domain).catch(() => null)
  for (const box of existing?.mailboxes || []) {
    if (box.address) await deleteMailbox(box.address).catch(() => undefined)
  }

  const res = await removeDomain(service.domain)
  await db.emailService.update({
    where: { id: serviceId },
    data: {
      status: 'cancelled',
      mailcowDomainCreated: !res.success,
      lastError: res.success ? null : res.error || null,
    },
  })
  return res.success ? { success: true } : { success: false, error: res.error }
}

/** Apply a new plan's allowances to an existing service (upgrade/downgrade). */
export async function applyPlanToService(
  serviceId: string,
  planId: string
): Promise<{ success: boolean; error?: string }> {
  const [service, plan] = await Promise.all([
    db.emailService.findUnique({ where: { id: serviceId } }),
    db.plan.findUnique({ where: { id: planId } }),
  ])
  if (!service || !plan) return { success: false, error: 'Service or plan not found' }
  const mailboxes = plan.emailMailboxes ?? plan.maxEmailAccounts ?? service.mailboxLimit
  const perBox = plan.emailStoragePerMailboxGB ?? service.storagePerMailboxGB
  const total = plan.emailTotalStorageGB ?? service.totalStorageGB

  // A downgrade that would strand existing mailboxes is refused up front —
  // better a clear error at the point of change than mailboxes silently over
  // an allowance Mailcow will not honour.
  const usage = await getEmailUsage(service).catch(() => null)
  const newLimit = mailboxes + (service.extraMailboxes || 0)
  if (usage && usage.mailboxes > newLimit) {
    return {
      success: false,
      error: `This plan allows ${newLimit} mailboxes but ${usage.mailboxes} exist. Delete ${usage.mailboxes - newLimit} mailbox(es) first.`,
    }
  }

  const updated = await db.emailService.update({
    where: { id: serviceId },
    data: {
      planId: plan.id,
      mailboxLimit: mailboxes,
      storagePerMailboxGB: perBox,
      totalStorageGB: total,
    },
  })
  // Make the new allowance real in the mail engine too.
  return syncMailcowLimits(updated)
}

/** Webmail entry point shown to customers. */
export function webmailUrl(): string {
  const configured = process.env.WEBMAIL_URL
  if (configured) return configured.replace(/\/+$/, '')
  const host = process.env.MAIL_SERVER_HOSTNAME || 'mail.apsamo.com'
  return `https://${host}/SOGo/`
}
