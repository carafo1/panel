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
  flushDovecotAuthCache,
  generateDkim,
  getDomain,
  reloadPostfix,
  removeDomain,
  updateMailbox,
} from '@/lib/mailcow'
import { listMailboxes } from '@/lib/mailcow'
import { sendEmail } from '@/lib/email'
import { createNotification } from '@/lib/notifications'

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

/** Storage add-ons are sold in blocks of this many GB. */
export const STORAGE_BLOCK_GB = 10

/**
 * What a service's purchased add-ons cost per month.
 *
 * Add-ons are recurring, so this has to be reflected in renewal invoices too —
 * billing only `plan.price` on renewal would charge for them once and then
 * give them away for the life of the subscription.
 */
export function addonMonthlyCost(service: {
  extraMailboxes: number
  extraStorageGB: number
}): number {
  const mailboxes = (service.extraMailboxes || 0) * EMAIL_ADDONS.extraMailbox.price
  const blocks = Math.ceil((service.extraStorageGB || 0) / STORAGE_BLOCK_GB)
  const storage = blocks * EMAIL_ADDONS.extraStorage10GB.price
  return Math.round((mailboxes + storage) * 100) / 100
}

/** Add-on cost across every email service paid for by one subscription. */
export async function emailAddonCostForSubscription(
  subscriptionId: string
): Promise<{ total: number; lines: string[] }> {
  const services = await db.emailService.findMany({
    where: { subscriptionId, status: { in: ['active', 'suspended'] } },
    select: {
      domain: true,
      extraMailboxes: true,
      extraStorageGB: true,
    },
  })

  let total = 0
  const lines: string[] = []
  for (const s of services) {
    const cost = addonMonthlyCost(s)
    if (cost <= 0) continue
    total += cost
    const parts: string[] = []
    if (s.extraMailboxes > 0) parts.push(`${s.extraMailboxes} extra mailbox(es)`)
    if (s.extraStorageGB > 0) parts.push(`${s.extraStorageGB} GB extra storage`)
    lines.push(`${s.domain}: ${parts.join(', ')}`)
  }
  return { total: Math.round(total * 100) / 100, lines }
}

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
  /** Extra step the customer must take for this record to do anything. */
  note?: string
}

/**
 * The DNS a customer must publish for mail to work.
 *
 * The MX target comes from MAIL_SERVER_HOSTNAME rather than being hard-coded:
 * it has to match the mail server's TLS certificate, so it is deployment
 * configuration, not a constant.
 */
/**
 * MTA-STS policy id. Senders re-fetch the policy when this changes, so it is
 * derived from the date rather than being random — a stable value per day
 * means republishing the record does not invalidate a working policy.
 */
function mtaStsId(): string {
  const d = new Date()
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(
    d.getUTCDate()
  ).padStart(2, '0')}`
}

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
    // ── Optional hardening ──
    // TLS-RPT is DNS-only and works the moment it is published: reporting
    // senders will email TLS negotiation failures to the address below.
    {
      type: 'TXT',
      host: '_smtp._tls',
      value: `v=TLSRPTv1; rua=mailto:postmaster@${domain}`,
      label: 'TLS-RPT — reports of encryption failures',
      required: false,
    },
    // MTA-STS is deliberately last and flagged: the TXT record alone does
    // nothing. It only takes effect once a policy file is reachable over
    // HTTPS on a subdomain the customer controls, so publishing just this
    // would give a false sense of protection.
    {
      type: 'TXT',
      host: '_mta-sts',
      value: `v=STSv1; id=${mtaStsId()}`,
      label: 'MTA-STS — enforce encrypted delivery',
      required: false,
      note:
        `Needs a policy file served at https://mta-sts.${domain}/.well-known/mta-sts.txt ` +
        `containing: version: STSv1 / mode: enforce / mx: ${host} / max_age: 604800. ` +
        `Without that file this record has no effect.`,
    },
    {
      type: 'TXT',
      host: 'default._bimi',
      value: `v=BIMI1; l=https://${domain}/logo.svg`,
      label: 'BIMI — show your logo in inboxes',
      required: false,
      note:
        'Replace the URL with your own square SVG logo (SVG Tiny PS). Most ' +
        'providers also require a paid Verified Mark Certificate, and DMARC ' +
        'must be at quarantine or reject — which the record above already is.',
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
    }

    // Sync unconditionally, not just on first creation. Buying a bigger plan
    // for a domain that already has service comes back through here with
    // mailcowDomainCreated already true — skipping the sync meant the upgrade
    // landed in our database while Mailcow kept refusing at the old ceiling.
    // (On first creation this also corrects addDomain, which derives the
    // domain total as per-mailbox × mailboxes rather than the plan's total.)
    await syncMailcowLimits(service)

    let dkimOk = service.dkimGenerated
    if (!dkimOk) {
      const dk = await generateDkim(domain)
      dkimOk = dk.success
    }

    // Capture this BEFORE the update below sets it — an upgrade comes back
    // through here and must not send a second welcome email.
    const isFirstProvision = !service.provisionedAt

    await db.emailService.update({
      where: { id: service.id },
      data: {
        mailcowDomainCreated: true,
        dkimGenerated: dkimOk,
        status: 'active',
        provisionedAt: service.provisionedAt ?? new Date(),
        lastError: null,
      },
    })

    if (isFirstProvision) {
      await sendWelcomeEmail(service.id).catch((err) =>
        console.error('[email-hosting] welcome email failed:', err)
      )
    }
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
 * this real: sign-in and sending stop.
 *
 * Incoming mail keeps being accepted — confirmed against the live server that
 * Postfix answers 250 for a deactivated domain, and only `mailbox.active = 0`
 * makes it reject with 550. That is deliberate: bouncing a customer's mail
 * over an unpaid invoice loses it permanently, whereas this way everything is
 * waiting once `resumeEmailService` runs. Nothing is deleted until the
 * retention window expires.
 */
export async function suspendEmailService(
  serviceId: string
): Promise<{ success: boolean; error?: string }> {
  const service = await db.emailService.findUnique({ where: { id: serviceId } })
  if (!service) return { success: false, error: 'Service not found' }
  const res = await editDomain({ domain: service.domain, active: false })

  // Deactivating the DOMAIN stops logins but not delivery: verified against
  // the live server, Postfix still answered 250 for a suspended domain and
  // only rejected (550 5.1.1) once the MAILBOX itself was inactive. So each
  // mailbox is disabled too — and remembered, so resume restores exactly
  // these and not one the customer had switched off themselves.
  //
  // Dovecot also caches credentials for 5 minutes, so without flushing, a
  // suspended customer keeps signing in until the entry expires (confirmed by
  // IMAP: cached login succeeded, then failed immediately once flushed).
  const disabled: string[] = []
  if (res.success) {
    const boxes = await listMailboxes(service.domain).catch(() => null)
    for (const b of boxes?.mailboxes || []) {
      if (!b.address) continue
      if (b.active) {
        const off = await updateMailbox({ address: b.address, active: false }).catch(
          () => ({ success: false })
        )
        if (off.success) disabled.push(b.address)
      }
      await flushDovecotAuthCache(b.address).catch(() => undefined)
    }
    // Postfix caches the domain lookup; without this it keeps accepting mail
    // for a suspended domain until the cache turns over.
    await reloadPostfix().catch(() => undefined)
  }

  await db.emailService.update({
    where: { id: serviceId },
    data: {
      status: 'suspended',
      suspendedAt: new Date(),
      suspendedMailboxes: disabled.length ? JSON.stringify(disabled) : null,
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

  // Re-enable the mailboxes this suspension turned off.
  //
  // Mailcow is changed before our record is written, so a crash in between
  // leaves mailboxes disabled with no list to restore from. When the list is
  // missing or unreadable, fall back to re-enabling every mailbox on the
  // domain: re-enabling one the customer had deliberately switched off is a
  // far smaller harm than leaving a paying customer's mail dead with no way
  // back. This also self-heals services stranded by an earlier failure.
  if (res.success) {
    let addresses: string[] | null = null
    if (service.suspendedMailboxes) {
      try {
        const parsed = JSON.parse(service.suspendedMailboxes)
        if (Array.isArray(parsed)) {
          addresses = parsed.filter((a): a is string => typeof a === 'string')
        }
      } catch {
        addresses = null
      }
    }

    if (!addresses) {
      const boxes = await listMailboxes(service.domain).catch(() => null)
      addresses = (boxes?.mailboxes || [])
        .filter((b) => b.address && !b.active)
        .map((b) => b.address)
    }

    for (const address of addresses) {
      await updateMailbox({ address, active: true }).catch(() => undefined)
      await flushDovecotAuthCache(address).catch(() => undefined)
    }
    // Otherwise a paying customer's mail keeps bouncing (454) until Postfix's
    // cached lookup expires.
    await reloadPostfix().catch(() => undefined)
  }

  await db.emailService.update({
    where: { id: serviceId },
    data: {
      status: 'active',
      suspendedAt: null,
      suspendedMailboxes: null,
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

/**
 * Tell the customer their email hosting is live, and — the part that actually
 * matters — give them the DNS records to publish. Until the MX record points
 * here nothing is delivered, so a "your service is ready" message without
 * these is the most common reason a new mail account looks broken.
 */
export async function sendWelcomeEmail(
  serviceId: string
): Promise<{ success: boolean; error?: string }> {
  const service = await db.emailService.findUnique({
    where: { id: serviceId },
    include: {
      user: { select: { email: true, name: true } },
      plan: { select: { name: true } },
    },
  })
  if (!service) return { success: false, error: 'Service not found' }
  if (!service.user?.email) return { success: false, error: 'No recipient' }

  // Read DKIM live so the record shown is the real one.
  let dkimValue: string | undefined
  let dkimSelector: string | undefined
  try {
    const d = await getDomain(service.domain)
    if (d.success && d.domain?.dkim?.public) {
      dkimValue = d.domain.dkim.public
      dkimSelector = d.domain.dkim.selector
    }
  } catch {
    /* the rest of the email is still worth sending */
  }

  const records = emailDnsRecords(service.domain, { dkimValue, dkimSelector })
  const limits = effectiveLimits(service)
  const settings = mailClientSettings()
  const imap = settings.servers.find((s) => s.protocol === 'IMAP' && s.recommended)
  const smtp = settings.servers.find((s) => s.protocol === 'SMTP' && s.recommended)
  const rows = records
    .map(
      (r) => `<tr>
<td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace">${r.type}</td>
<td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace">${r.host}</td>
<td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;word-break:break-all">${
        r.priority !== undefined ? `${r.priority} ` : ''
      }${r.value}</td>
</tr>`
    )
    .join('')

  await sendEmail({
    to: service.user.email,
    subject: `Email hosting for ${service.domain} is ready`,
    html: `<p>Hi ${service.user.name || 'there'},</p>
<p>Your <strong>${service.plan?.name || 'email hosting'}</strong> service for
<strong>${service.domain}</strong> is active — ${limits.mailboxLimit} mailboxes,
${limits.storagePerMailboxGB} GB each.</p>

<p><strong>One step left:</strong> add these records at whoever manages DNS for
${service.domain}. Mail cannot be delivered until the MX record is in place, and
the SPF, DKIM and DMARC records are what keep your messages out of spam folders.</p>

<table style="border-collapse:collapse;font-size:13px">
<tr>
<th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Type</th>
<th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Host</th>
<th style="padding:6px 10px;border:1px solid #ddd;text-align:left">Value</th>
</tr>
${rows}
</table>

<p>Create your mailboxes in the panel under <strong>Email Hosting</strong>, then
sign in to webmail at <a href="${webmailUrl()}">${webmailUrl()}</a> using the full
mailbox address and its own password.</p>

<p><strong>Mail settings for Outlook, Apple Mail or your phone</strong><br>
Server (incoming &amp; outgoing): <strong>${settings.host}</strong> — not your own domain.<br>
IMAP: port <strong>${imap?.port}</strong> (${imap?.security}) ·
SMTP: port <strong>${smtp?.port}</strong> (${smtp?.security})<br>
Username is your full email address.</p>

<p>— Apsamo Technology</p>`,
  })

  await createNotification({
    userId: service.userId,
    title: 'Email hosting is ready',
    message: `${service.domain} is active. Publish the DNS records shown in Email Hosting to start receiving mail.`,
    type: 'success',
    link: '/?tab=email',
  }).catch(() => {})

  return { success: true }
}

/** Webmail entry point shown to customers. */
/**
 * Where to send a customer for webmail.
 *
 * This is the mail host's FRONT PAGE, not `/SOGo/`. Mailcow deliberately
 * writes a random, unusable password hash into SOGo's authentication view
 * ("generate random password for sogo to deny direct login" — its own source),
 * so the SOGo login form rejects every real password. A SOGo session is only
 * issued after signing in at the mail host, which then performs the SSO.
 * Pointing customers at /SOGo/ sent them to a page that could never work.
 */
export function webmailUrl(): string {
  const configured = process.env.WEBMAIL_URL
  if (configured) return configured.replace(/\/+$/, '')
  return `https://${mailServerHost()}/`
}

/** Hostname of the mail server itself — where clients connect. */
export function mailServerHost(): string {
  return process.env.MAIL_SERVER_HOSTNAME || 'mail.apsamo.com'
}

export interface MailClientServer {
  protocol: 'IMAP' | 'POP3' | 'SMTP'
  host: string
  port: number
  security: 'SSL/TLS' | 'STARTTLS'
  /** True for the setting we advise customers to use. */
  recommended: boolean
}

export interface MailClientSettings {
  host: string
  /** Always the full email address, per Mailcow. */
  usernameHint: string
  servers: MailClientServer[]
  /** Why the host is the mail server, not the customer's own domain. */
  note: string
}

/**
 * The settings a customer types into Outlook, Apple Mail or their phone.
 *
 * The host is the mail SERVER (mail.apsamo.com), never the customer's own
 * domain: the TLS certificate on the mail server covers only that name
 * (verified — the cert's SAN is a single DNS entry), so a client told to use
 * `mail.theirdomain.com` would hit a certificate-mismatch error. All six
 * ports were confirmed open on the live server before these were published.
 */
export function mailClientSettings(mailbox?: string): MailClientSettings {
  const host = mailServerHost()
  return {
    host,
    usernameHint: mailbox || 'your full email address',
    note:
      `Use ${host} as the server name for both incoming and outgoing mail — ` +
      `not your own domain. Sign in with your full email address as the username.`,
    servers: [
      { protocol: 'IMAP', host, port: 993, security: 'SSL/TLS', recommended: true },
      { protocol: 'IMAP', host, port: 143, security: 'STARTTLS', recommended: false },
      { protocol: 'POP3', host, port: 995, security: 'SSL/TLS', recommended: false },
      { protocol: 'POP3', host, port: 110, security: 'STARTTLS', recommended: false },
      { protocol: 'SMTP', host, port: 465, security: 'SSL/TLS', recommended: true },
      { protocol: 'SMTP', host, port: 587, security: 'STARTTLS', recommended: false },
    ],
  }
}
