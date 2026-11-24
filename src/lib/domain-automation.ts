/**
 * Domain automation pipeline orchestrator.
 *
 * Executes the full registration pipeline after successful payment:
 *
 *   Search Domain
 *     → Register Domain (Dynadot)
 *       → Configure Nameservers
 *         → Configure DNS (+ Email DNS: SPF/DKIM/DMARC)
 *           → Save to Database (Domain + DnsRecords + Contacts)
 *             → Create Order + Invoice + Transaction
 *               → Generate DomainLog (audit)
 *                 → Send confirmation email
 *                   → Return Success Response
 *
 * Each step is atomic and logged. Failed transactions roll back: if DNS
 * configuration fails after registration, the domain stays registered but
 * the order is marked `failed` and a DomainLog entry records the error so
 * an admin can reconcile manually.
 */
import { db } from './db'
import { dynadotService } from './dynadot-service'
import { isRegistrarUnknownOutcome, parseRegistrarDate } from './dynadot'
import {
  getPriceForDomain,
  applyMarkup,
  tldFromDomain,
} from './pricing'
import { sendEmail } from './email'
import { nextInvoiceNumber } from './invoices'
import { MAIL_SERVER_HOSTNAME, NS1_HOSTNAME, NS2_HOSTNAME } from './brand-config'
import { emitWebhookEvent } from '@/lib/webhook-delivery'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RegisterPipelineInput {
  userId: string
  domain: string
  duration: number // years
  nameservers?: string[]
  dnsRecords?: Array<{
    type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'CAA' | 'NS'
    name: string
    value: string
    ttl?: number
    priority?: number
  }>
  emailDns?: {
    spf?: boolean
    dmarc?: boolean
    dkim?: boolean
    mxTarget?: string // e.g. mail.<brand-domain> (defaults to brand-config MAIL_SERVER_HOSTNAME)
  }
  contacts?: Array<{
    type: 'registrant' | 'admin' | 'tech' | 'billing'
    firstName: string
    lastName: string
    email: string
    phone?: string
    organization?: string
    address1?: string
    city?: string
    state?: string
    postalCode?: string
    country?: string
  }>
  serverIp?: string // IP for default A record
  paymentMethod?: string // "stripe", "waafi", "manual", "balance"
  /**
   * Order/invoice raised by domain-checkout BEFORE payment. When supplied the
   * pipeline updates those rows instead of creating a second set — otherwise a
   * paid order ends up with a duplicate pending invoice attached to it.
   */
  existingOrderId?: string
  existingInvoiceId?: string
}

/** Order/invoice already raised at checkout, for the renew/transfer pipelines. */
export interface ExistingBilling {
  existingOrderId?: string
  existingInvoiceId?: string
}

export interface PipelineStep {
  name: string
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped'
  message?: string
  startedAt?: string
  completedAt?: string
}

export interface PipelineResult {
  success: boolean
  domainId?: string
  orderId?: string
  invoiceNumber?: string
  steps: PipelineStep[]
  error?: string
  /**
   * The registrar may hold (or does hold) the purchase but our records are
   * incomplete or the outcome is unknown. NEVER retry: reconcile by hand.
   */
  manualReview?: boolean
  /** The registrar expiry could not be read back; expiresAt was left null. */
  expiryUnknown?: boolean
}

// ─── Registrar call bookkeeping (exactly-once purchases) ─────────────────────

/** The order already reached the registrar once; calling again could buy twice. */
export class RegistrarReplayRefusedError extends Error {
  readonly code = 'registrar_replay_refused'
  constructor(orderId: string) {
    super(`Order ${orderId} already called the registrar; refusing a second purchase call`)
    this.name = 'RegistrarReplayRefusedError'
  }
}

/**
 * Record — immediately BEFORE the purchase call — that this order is about to
 * reach the registrar. Conditional on registrarCalledAt being unset, so a
 * second attempt for the same order throws instead of buying again. If this
 * write fails the registrar is not called.
 */
export async function markRegistrarCalled(orderId: string | undefined): Promise<void> {
  if (!orderId) return
  const r = await db.domainOrder.updateMany({
    where: { id: orderId, registrarCalledAt: null },
    data: { registrarCalledAt: new Date() },
  })
  if (r.count !== 1) throw new RegistrarReplayRefusedError(orderId)
}

/** Record a confirmed purchase. First write after the registrar said yes. */
export async function markRegistrarConfirmed(
  orderId: string | undefined,
  providerOrderId: string | undefined
): Promise<void> {
  if (!orderId) return
  await db.domainOrder.update({
    where: { id: orderId },
    data: {
      registrarConfirmedAt: new Date(),
      ...(providerOrderId ? { providerOrderId } : {}),
    },
  })
}

/**
 * The registrar DEFINITELY refused (or was never reached): nothing was bought,
 * so the order may be attempted again later.
 */
export async function releaseRegistrarCall(orderId: string | undefined): Promise<void> {
  if (!orderId) return
  await db.domainOrder
    .updateMany({
      where: { id: orderId, registrarConfirmedAt: null },
      data: { registrarCalledAt: null },
    })
    .catch((err) => console.error('[domain-automation] could not release registrar call:', err))
}

/**
 * The registrar's own expiry for a domain, or null when it cannot be read.
 * Never computed locally: "now + N years" is wrong for renewals (they extend
 * the current expiry), for transfers, and whenever the registrar rounds.
 */
export async function fetchRegistrarExpiry(domain: string): Promise<Date | null> {
  try {
    const info = await dynadotService.getDomainInfo(domain)
    return parseRegistrarDate(info.expiry)
  } catch (err) {
    console.error(`[domain-automation] expiry lookup failed for ${domain}:`, err)
    return null
  }
}

/** Selling price for an order: the one quoted at checkout, else the catalogue. */
async function orderPricing(
  existingOrderId: string | undefined,
  domain: string,
  kind: 'registration' | 'renewal' | 'transfer',
  years: number
): Promise<{ unitPrice: number; totalAmount: number } | null> {
  if (existingOrderId) {
    const o = await db.domainOrder.findUnique({
      where: { id: existingOrderId },
      select: { unitPrice: true, totalAmount: true },
    })
    return o ? { unitPrice: o.unitPrice, totalAmount: o.totalAmount } : null
  }
  const price = await getPriceForDomain(domain)
  const unit = price?.[kind]
  if (!unit || unit <= 0) return null
  return { unitPrice: unit, totalAmount: Math.round(unit * years * 100) / 100 }
}

/**
 * Hand a previously DELETED Domain row to its new buyer: new owner, no
 * project, and none of the old owner's DNS, contacts, verification or
 * nameserver rows. Projects of other users still pointing at the name are
 * unlinked so the old owner's site cannot serve the new owner's domain.
 */
async function reassignDeletedDomain(domainId: string, name: string, buyerId: string): Promise<void> {
  await db.$transaction([
    db.dnsRecord.deleteMany({ where: { domainId } }),
    db.domainContact.deleteMany({ where: { domainId } }),
    db.nameserverEntry.deleteMany({ where: { domainId } }),
    db.domainVerification.deleteMany({ where: { domainId } }),
    db.project.updateMany({
      where: { customDomain: name, userId: { not: buyerId } },
      data: { customDomain: null },
    }),
    db.domain.update({
      where: { id: domainId },
      data: {
        userId: buyerId,
        projectId: null,
        authCode: null,
        transferStatus: null,
        nameservers: null,
        emailHosted: false,
        mailcowDomainId: null,
        externalId: null,
        premium: false,
      },
    }),
  ])
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Invoice numbers come from nextInvoiceNumber() in ./invoices — the old local
// generator picked a random 5-digit suffix, which collides with ~50% odds after
// only ~350 invoices and would then blow up on the unique constraint.

async function logDomainEvent(
  domainId: string | null,
  userId: string,
  action: string,
  status: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await db.domainLog.create({
      data: {
        domainId,
        userId,
        action,
        status,
        message,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    })
  } catch (err) {
    console.error('[domain-automation] failed to write DomainLog:', err)
  }
}

/**
 * Build the default email DNS records (SPF / DMARC / DKIM / MX) for a domain.
 */
export function buildEmailDnsRecords(
  domain: string,
  opts: { mxTarget?: string; dkimSelector?: string; enabled?: boolean }
): Array<{ type: 'TXT' | 'MX'; name: string; value: string; priority?: number }> {
  const mxTarget = opts.mxTarget || MAIL_SERVER_HOSTNAME
  const selector = opts.dkimSelector || 'mail'
  const records: Array<{ type: 'TXT' | 'MX'; name: string; value: string; priority?: number }> = []

  // MX record pointing to the mail server
  records.push({ type: 'MX', name: '@', value: mxTarget, priority: 10 })

  // SPF — allows the mail server to send on behalf of the domain
  records.push({
    type: 'TXT',
    name: '@',
    value: `v=spf1 mx a:${mxTarget} ~all`,
  })

  // DMARC — policy for failing emails
  records.push({
    type: 'TXT',
    name: '_dmarc',
    value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}; ruf=mailto:postmaster@${domain}; fo=1`,
  })

  // DKIM — placeholder CNAME/TXT. Real DKIM key comes from the mail server.
  records.push({
    type: 'TXT',
    name: `${selector}._domainkey`,
    value: `v=DKIM1; k=rsa; p=PLACEHOLDER_REPLACE_WITH_MAILCOW_DKIM_KEY`,
  })

  return records
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Run the full registration pipeline.
 */
export async function runRegistrationPipeline(
  input: RegisterPipelineInput
): Promise<PipelineResult> {
  const steps: PipelineStep[] = []
  const domainLower = input.domain.toLowerCase().trim()
  const markStep = (
    name: string,
    status: PipelineStep['status'],
    message?: string
  ) => {
    const existing = steps.find((s) => s.name === name)
    if (existing) {
      existing.status = status
      existing.message = message
      if (status === 'running') existing.startedAt = new Date().toISOString()
      if (status === 'success' || status === 'failed' || status === 'skipped') {
        existing.completedAt = new Date().toISOString()
      }
    } else {
      steps.push({
        name,
        status,
        message,
        startedAt: status === 'running' ? new Date().toISOString() : undefined,
        completedAt:
          status === 'success' || status === 'failed' || status === 'skipped'
            ? new Date().toISOString()
            : undefined,
      })
    }
  }

  const begin = (name: string) => markStep(name, 'running')
  const ok = (name: string, msg?: string) => markStep(name, 'success', msg)
  const skip = (name: string, msg?: string) => markStep(name, 'skipped', msg)
  const fail = (name: string, msg: string) => markStep(name, 'failed', msg)

  // Once the registrar has confirmed, any later failure leaves a domain we
  // paid for: it must go to manual review, never back into a retry.
  let registrarConfirmed = false

  try {
    // ── Step 0: Ownership + price, before anything is spent ────────────────
    const existing = await db.domain.findUnique({ where: { name: domainLower } })
    if (existing && existing.status !== 'deleted' && existing.userId !== input.userId) {
      await logDomainEvent(null, input.userId, 'register', 'failed', 'Domain already belongs to another account', {
        domain: domainLower,
      })
      return { success: false, steps, error: 'Domain already belongs to another account' }
    }
    const pricing = await orderPricing(input.existingOrderId, domainLower, 'registration', input.duration)
    if (!pricing) {
      return { success: false, steps, error: 'This extension is not sold here (no active price)' }
    }
    const { unitPrice, totalAmount } = pricing

    // ── Step 1: Search (verify availability) ───────────────────────────────
    begin('search')
    const searchResult = await dynadotService.search(domainLower)
    if (searchResult.status !== 'available') {
      const why =
        searchResult.status === 'premium'
          ? 'Premium domains cannot be registered here'
          : searchResult.status === 'unknown'
          ? 'Could not confirm availability with the registrar'
          : 'Domain not available'
      fail('search', `${domainLower}: ${why}`)
      await logDomainEvent(null, input.userId, 'register', 'failed', why, {
        domain: domainLower,
      })
      return { success: false, steps, error: why }
    }
    ok('search', `Domain ${domainLower} is available`)

    // ── Step 2: Register ───────────────────────────────────────────────────
    begin('register')
    // Recorded BEFORE the call; refuses (throws) if this order already called.
    await markRegistrarCalled(input.existingOrderId)
    let registerResult: Awaited<ReturnType<typeof dynadotService.register>>
    try {
      registerResult = await dynadotService.register(
        domainLower,
        input.duration,
        input.contacts
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isRegistrarUnknownOutcome(err)) {
        fail('register', 'Registrar outcome unknown — held for manual review')
        await logDomainEvent(null, input.userId, 'register', 'manual_review', message, {
          domain: domainLower,
          orderId: input.existingOrderId,
        })
        return { success: false, steps, error: message, manualReview: true }
      }
      // Thrown before the purchase was sent (contacts, configuration): nothing bought.
      await releaseRegistrarCall(input.existingOrderId)
      fail('register', message)
      await logDomainEvent(null, input.userId, 'register', 'failed', message, { domain: domainLower })
      return { success: false, steps, error: message }
    }
    if (!registerResult.success) {
      await releaseRegistrarCall(input.existingOrderId)
      fail('register', 'Registrar refused the registration')
      await logDomainEvent(null, input.userId, 'register', 'failed', 'Registration failed', {
        domain: domainLower,
        registrarError: registerResult.error,
      })
      return { success: false, steps, error: 'Registration failed' }
    }
    registrarConfirmed = true
    await markRegistrarConfirmed(input.existingOrderId, registerResult.orderId)
    ok('register', `Registered via Dynadot (order: ${registerResult.orderId || 'n/a'})`)

    // ── Step 3: Save to database ───────────────────────────────────────────
    begin('save_database')
    // The registrar's expiry, read back — never computed here.
    const expiry = await fetchRegistrarExpiry(domainLower)
    if (!expiry) {
      await logDomainEvent(null, input.userId, 'reconcile_expiry', 'pending',
        'Registrar expiry could not be read after registration; expiresAt left empty', {
          domain: domainLower,
          orderId: input.existingOrderId,
        })
    }

    let domainId: string
    if (existing) {
      domainId = existing.id
      // A deleted row may have belonged to someone else: hand it to the buyer
      // with none of the previous owner's project, DNS or contacts.
      if (existing.status === 'deleted' || existing.userId !== input.userId) {
        await reassignDeletedDomain(existing.id, domainLower, input.userId)
      }
      await db.domain.update({
        where: { id: existing.id },
        data: {
          userId: input.userId,
          status: 'active',
          registrar: 'dynadot',
          registeredAt: new Date(),
          expiresAt: expiry,
          autoRenew: true,
          whoisPrivacy: true,
          locked: true,
          provider: 'dynadot',
          externalId: registerResult.orderId,
          premium: false,
          nameservers: input.nameservers ? JSON.stringify(input.nameservers) : undefined,
        },
      })
    } else {
      const created = await db.domain.create({
        data: {
          userId: input.userId,
          name: domainLower,
          status: 'active',
          registrar: 'dynadot',
          registeredAt: new Date(),
          expiresAt: expiry,
          autoRenew: true,
          whoisPrivacy: true,
          locked: true,
          provider: 'dynadot',
          externalId: registerResult.orderId,
          premium: false,
          nameservers: input.nameservers ? JSON.stringify(input.nameservers) : null,
        },
      })
      domainId = created.id
    }
    ok('save_database', `Domain record created (id: ${domainId})`)
    void emitWebhookEvent(input.userId, 'domain.registered', {
      domain: domainLower,
      expiresAt: expiry ? expiry.toISOString() : null,
      years: input.duration,
    })

    // ── Step 4: Configure Nameservers ──────────────────────────────────────
    begin('configure_nameservers')
    const nameservers = input.nameservers && input.nameservers.length > 0
      ? input.nameservers
      : [NS1_HOSTNAME, NS2_HOSTNAME]
    try {
      await dynadotService.setNameservers(domainLower, nameservers)
      // Persist nameserver entries
      await db.nameserverEntry.deleteMany({ where: { domainId } }).catch(() => {})
      for (let i = 0; i < nameservers.length; i++) {
        await db.nameserverEntry.create({
          data: { domainId, hostname: nameservers[i], sortOrder: i },
        })
      }
      await db.domain.update({
        where: { id: domainId },
        data: { nameservers: JSON.stringify(nameservers) },
      })
      ok('configure_nameservers', `${nameservers.length} nameservers configured`)
    } catch (err) {
      fail('configure_nameservers', (err as Error).message)
      // non-fatal — continue
    }

    // ── Step 5: Configure DNS ──────────────────────────────────────────────
    begin('configure_dns')
    const dnsRecords = [...(input.dnsRecords || [])]

    // Default A record if server IP provided
    if (input.serverIp && !dnsRecords.some((r) => r.type === 'A' && r.name === '@')) {
      dnsRecords.push({ type: 'A', name: '@', value: input.serverIp, ttl: 3600 })
    }
    // Default www CNAME
    if (!dnsRecords.some((r) => r.type === 'CNAME' && r.name === 'www')) {
      dnsRecords.push({ type: 'CNAME', name: 'www', value: domainLower, ttl: 3600 })
    }
    // Email DNS records
    if (input.emailDns) {
      const emailRecords = buildEmailDnsRecords(domainLower, {
        mxTarget: input.emailDns.mxTarget,
      })
      dnsRecords.push(
        ...emailRecords.map((r) => ({
          type: r.type as 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'SRV' | 'CAA' | 'NS',
          name: r.name,
          value: r.value,
          priority: r.priority,
          ttl: 3600,
        }))
      )
    }

    try {
      // Appends to the live zone (never replaces it). Records are persisted —
      // and the step reported as configured — only when the registrar
      // confirmed the write; otherwise the panel would show records that are
      // not actually published.
      const dnsResult = await dynadotService.setDnsRecords(domainLower, dnsRecords)
      if (!dnsResult.success) {
        fail('configure_dns', 'The registrar did not confirm the DNS update')
      } else {
        // Persist DNS records to DB (replace existing)
        await db.$transaction([
          db.dnsRecord.deleteMany({ where: { domainId } }),
          ...dnsRecords.map((r) =>
            db.dnsRecord.create({
              data: {
                domainId,
                type: r.type,
                name: r.name,
                value: r.value,
                ttl: r.ttl || 3600,
                priority: r.priority ?? null,
                proxied: false,
              },
            })
          ),
        ])
        ok('configure_dns', `${dnsRecords.length} DNS records configured`)
      }
    } catch (err) {
      fail('configure_dns', (err as Error).message)
      // non-fatal
    }

    // ── Step 6: Save Contacts ──────────────────────────────────────────────
    if (input.contacts && input.contacts.length > 0) {
      begin('save_contacts')
      try {
        await db.domainContact.deleteMany({ where: { domainId } }).catch(() => {})
        for (const c of input.contacts) {
          await db.domainContact.create({
            data: { domainId, ...c },
          })
        }
        ok('save_contacts', `${input.contacts.length} contacts saved`)
      } catch (err) {
        fail('save_contacts', (err as Error).message)
      }
    } else {
      skip('save_contacts', 'No contacts provided')
    }

    // ── Step 7: Order ──────────────────────────────────────────────────────
    // The order normally already exists: domain-checkout raised it before
    // taking payment, and this pipeline only runs once the money is confirmed.
    begin('create_order')
    let order: { id: string }
    if (input.existingOrderId) {
      order = await db.domainOrder.update({
        where: { id: input.existingOrderId },
        data: { domainId },
      })
      ok('create_order', `Order ${order.id} fulfilled ($${totalAmount})`)
    } else {
      order = await db.domainOrder.create({
        data: {
          userId: input.userId,
          domainId,
          domainName: domainLower,
          type: 'register',
          duration: input.duration,
          status: 'completed',
          unitPrice,
          totalAmount,
          currency: 'USD',
          provider: 'dynadot',
          providerOrderId: registerResult.orderId,
          registrarCalledAt: new Date(),
          registrarConfirmedAt: new Date(),
        },
      })
      ok('create_order', `Order ${order.id} created ($${totalAmount})`)
    }

    // ── Step 8: Invoice ────────────────────────────────────────────────────
    // Settlement is the caller's job — fulfilDomainOrder marks the invoice
    // paid once delivery succeeds — so don't raise a second document here.
    begin('create_invoice')
    let invoiceNumber: string
    if (input.existingInvoiceId) {
      const linked = await db.invoice.update({
        where: { id: input.existingInvoiceId },
        data: { domainId },
      })
      invoiceNumber = linked.number
      ok('create_invoice', `Invoice ${invoiceNumber} linked to domain`)
    } else {
      // Legacy/admin path: no checkout ran, so raise an unpaid invoice for
      // someone to settle. Never mark it paid here, and never write a
      // completed Transaction for money nobody received — that combination
      // was what made domains look bought when they had not been paid for.
      invoiceNumber = await nextInvoiceNumber()
      await db.invoice.create({
        data: {
          number: invoiceNumber,
          userId: input.userId,
          orderId: order.id,
          domainId,
          items: JSON.stringify([
            {
              description: `Domain registration: ${domainLower} (${input.duration} year${input.duration > 1 ? 's' : ''})`,
              quantity: input.duration,
              unitPrice,
              total: totalAmount,
            },
          ]),
          subtotal: totalAmount,
          tax: 0,
          total: totalAmount,
          currency: 'USD',
          status: 'pending',
          paidAt: null,
        },
      })
      ok('create_invoice', `Invoice ${invoiceNumber} raised (awaiting payment)`)
    }

    // ── Step 9: Generate Log ───────────────────────────────────────────────
    begin('generate_log')
    await logDomainEvent(domainId, input.userId, 'register', 'success', 'Domain registered', {
      domain: domainLower,
      orderId: order.id,
      invoiceNumber,
      duration: input.duration,
      totalAmount,
    })
    ok('generate_log', 'Audit log recorded')

    // ── Step 10: Send Email ────────────────────────────────────────────────
    begin('send_email')
    try {
      const user = await db.user.findUnique({ where: { id: input.userId } })
      if (user) {
        await sendEmail({
          to: user.email,
          subject: `Domain Registered: ${domainLower}`,
          html: `
            <h2>Domain Registration Successful</h2>
            <p>Hi ${user.name},</p>
            <p>Your domain <strong>${domainLower}</strong> has been successfully registered for ${input.duration} year${input.duration > 1 ? 's' : ''}.</p>
            <h3>Details</h3>
            <ul>
              <li>Domain: ${domainLower}</li>
              <li>Duration: ${input.duration} year(s)</li>
              <li>Amount: $${totalAmount} USD</li>
              <li>Invoice: ${invoiceNumber}</li>
              <li>Expires: ${expiry ? expiry.toDateString() : 'being confirmed with the registry'}</li>
            </ul>
            <p>You can manage your domain from the Apsamo Panel dashboard.</p>
          `,
        })
        ok('send_email', `Confirmation sent to ${user.email}`)
      } else {
        skip('send_email', 'User not found')
      }
    } catch (err) {
      fail('send_email', (err as Error).message)
      // non-fatal
    }

    return {
      success: true,
      domainId,
      orderId: order.id,
      invoiceNumber,
      steps,
      expiryUnknown: !expiry,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Registrar already charged (or this order already called it once):
    // a retry could buy again, so this needs a human, not the sweeper.
    if (registrarConfirmed || err instanceof RegistrarReplayRefusedError) {
      await logDomainEvent(null, input.userId, 'register', 'manual_review', message, {
        domain: domainLower,
        orderId: input.existingOrderId,
        registrarConfirmed,
      })
      return { success: false, steps, error: message, manualReview: true }
    }
    return { success: false, steps, error: message }
  }
}

/**
 * Renew a domain through the pipeline.
 */
export async function runRenewalPipeline(
  userId: string,
  domainId: string,
  duration: number,
  billing: ExistingBilling = {}
): Promise<{
  success: boolean
  invoiceNumber?: string
  error?: string
  manualReview?: boolean
  expiryUnknown?: boolean
}> {
  const domain = await db.domain.findUnique({ where: { id: domainId } })
  if (!domain) return { success: false, error: 'Domain not found' }
  if (domain.userId !== userId) return { success: false, error: 'Not authorized' }

  let registrarConfirmed = false
  try {
    const pricing = await orderPricing(billing.existingOrderId, domain.name, 'renewal', duration)
    if (!pricing) return { success: false, error: 'This extension is not sold here (no active price)' }
    const pricePerYear = pricing.unitPrice
    const total = pricing.totalAmount

    // 1. Renew via Dynadot — recorded before the call, never repeated.
    await markRegistrarCalled(billing.existingOrderId)
    let result: Awaited<ReturnType<typeof dynadotService.renew>>
    try {
      result = await dynadotService.renew(domain.name, duration)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isRegistrarUnknownOutcome(err)) {
        await logDomainEvent(domainId, userId, 'renew', 'manual_review', message, {
          orderId: billing.existingOrderId,
        })
        return { success: false, error: message, manualReview: true }
      }
      await releaseRegistrarCall(billing.existingOrderId)
      throw err
    }
    if (!result.success) {
      await releaseRegistrarCall(billing.existingOrderId)
      return { success: false, error: 'Renewal failed at provider' }
    }
    registrarConfirmed = true
    await markRegistrarConfirmed(billing.existingOrderId, result.orderId)

    // 2. Update domain expiry from the REGISTRAR (domain_info), falling back
    //    to a parsable expiry in the renew answer. Never computed locally; if
    //    neither is available it is left empty and flagged for reconciliation.
    const newExpiry =
      (await fetchRegistrarExpiry(domain.name)) ?? parseRegistrarDate(result.newExpiry)
    if (!newExpiry) {
      await logDomainEvent(domainId, userId, 'reconcile_expiry', 'pending',
        'Registrar expiry could not be read after renewal; expiresAt left empty', {
          orderId: billing.existingOrderId,
        })
    }
    await db.domain.update({
      where: { id: domainId },
      data: { expiresAt: newExpiry, status: 'active' },
    })

    // 3. Create renewal record
    const renewal = await db.renewal.create({
      data: {
        domainId,
        userId,
        years: duration,
        pricePerYear,
        totalAmount: total,
        status: 'completed',
        providerRenewId: result.orderId,
      },
    })

    // 4. Order + Invoice — reuse the ones raised at checkout when present.
    let order: { id: string }
    if (billing.existingOrderId) {
      order = await db.domainOrder.update({
        where: { id: billing.existingOrderId },
        data: { domainId },
      })
    } else {
      order = await db.domainOrder.create({
        data: {
          userId,
          domainId,
          domainName: domain.name,
          type: 'renew',
          duration,
          status: 'completed',
          unitPrice: pricePerYear,
          totalAmount: total,
          providerOrderId: result.orderId,
          registrarCalledAt: new Date(),
          registrarConfirmedAt: new Date(),
        },
      })
    }

    let invoiceNumber: string
    if (billing.existingInvoiceId) {
      const linked = await db.invoice.update({
        where: { id: billing.existingInvoiceId },
        data: { domainId },
      })
      invoiceNumber = linked.number
    } else {
      invoiceNumber = await nextInvoiceNumber()
      await db.invoice.create({
        data: {
          number: invoiceNumber,
          userId,
          orderId: order.id,
          domainId,
          items: JSON.stringify([
            {
              description: `Domain renewal: ${domain.name} (${duration} year${duration > 1 ? 's' : ''})`,
              quantity: duration,
              unitPrice: pricePerYear,
              total,
            },
          ]),
          subtotal: total,
          tax: 0,
          total,
          // Unpaid until a gateway or an admin confirms the money.
          status: 'pending',
          paidAt: null,
        },
      })
    }

    await logDomainEvent(domainId, userId, 'renew', 'success', 'Domain renewed', {
      duration,
      renewalId: renewal.id,
      total,
    })

    return { success: true, invoiceNumber, expiryUnknown: !newExpiry }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const manualReview = registrarConfirmed || err instanceof RegistrarReplayRefusedError
    await logDomainEvent(domainId, userId, 'renew', manualReview ? 'manual_review' : 'failed', message)
    return { success: false, error: message, ...(manualReview ? { manualReview: true } : {}) }
  }
}

/**
 * Transfer a domain through the pipeline.
 */
export async function runTransferPipeline(
  userId: string,
  domain: string,
  authCode: string,
  billing: ExistingBilling & { contacts?: RegisterPipelineInput['contacts'] } = {}
): Promise<{
  success: boolean
  domainId?: string
  invoiceNumber?: string
  error?: string
  manualReview?: boolean
  /** Accepted by the registrar; completes later (reconciliation polls it). */
  transferPending?: boolean
}> {
  const domainLower = domain.toLowerCase().trim()

  let registrarConfirmed = false
  try {
    // 0. Ownership + price, before anything is spent. A domain already in
    //    ANOTHER customer's account here cannot be transferred into this one.
    const existing = await db.domain.findUnique({ where: { name: domainLower } })
    if (existing && existing.status !== 'deleted' && existing.userId !== userId) {
      await logDomainEvent(null, userId, 'transfer', 'failed', 'Domain belongs to another account', {
        domain: domainLower,
      })
      return { success: false, error: 'Domain belongs to another account' }
    }
    const pricing = await orderPricing(billing.existingOrderId, domainLower, 'transfer', 1)
    if (!pricing) return { success: false, error: 'This extension is not sold here (no active price)' }
    const total = pricing.totalAmount

    // 1. Transfer via Dynadot — recorded before the call, never repeated.
    await markRegistrarCalled(billing.existingOrderId)
    let result: Awaited<ReturnType<typeof dynadotService.transfer>>
    try {
      result = await dynadotService.transfer(domainLower, authCode)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (isRegistrarUnknownOutcome(err)) {
        await logDomainEvent(null, userId, 'transfer', 'manual_review', message, {
          domain: domainLower,
          orderId: billing.existingOrderId,
        })
        return { success: false, error: message, manualReview: true }
      }
      await releaseRegistrarCall(billing.existingOrderId)
      throw err
    }
    if (!result.success) {
      await releaseRegistrarCall(billing.existingOrderId)
      return { success: false, error: result.message || 'Transfer failed' }
    }
    registrarConfirmed = true
    await markRegistrarConfirmed(billing.existingOrderId, result.orderId)

    // 2. Create / update domain record. The transfer is only REQUESTED: no
    //    expiry is known until it completes, so none is invented.
    let domainId: string
    if (existing) {
      if (existing.status === 'deleted' || existing.userId !== userId) {
        await reassignDeletedDomain(existing.id, domainLower, userId)
      }
      await db.domain.update({
        where: { id: existing.id },
        data: {
          userId,
          status: 'transferring',
          transferStatus: 'pending',
          registrar: 'dynadot',
          provider: 'dynadot',
        },
      })
      domainId = existing.id
    } else {
      const created = await db.domain.create({
        data: {
          userId,
          name: domainLower,
          status: 'transferring',
          transferStatus: 'pending',
          registrar: 'dynadot',
          provider: 'dynadot',
          expiresAt: null,
        },
      })
      domainId = created.id
    }

    // 3. Persist the registrant contacts supplied at checkout, so the
    //    transferred domain carries the customer's details rather than
    //    whatever the losing registrar had on file.
    if (billing.contacts && billing.contacts.length > 0) {
      await db.domainContact.deleteMany({ where: { domainId } }).catch(() => {})
      for (const c of billing.contacts) {
        await db.domainContact.create({ data: { domainId, ...c } }).catch(() => {})
      }
    }

    // 4. Order + Invoice — reuse the ones raised at checkout when present.
    let order: { id: string }
    if (billing.existingOrderId) {
      order = await db.domainOrder.update({
        where: { id: billing.existingOrderId },
        data: { domainId },
      })
    } else {
      order = await db.domainOrder.create({
        data: {
          userId,
          domainId,
          domainName: domainLower,
          type: 'transfer',
          duration: 1,
          // Accepted, not finished: reconciliation completes it.
          status: 'transfer_pending',
          unitPrice: total,
          totalAmount: total,
          providerOrderId: result.orderId,
          registrarCalledAt: new Date(),
          registrarConfirmedAt: new Date(),
        },
      })
    }

    let invoiceNumber: string
    if (billing.existingInvoiceId) {
      const linked = await db.invoice.update({
        where: { id: billing.existingInvoiceId },
        data: { domainId },
      })
      invoiceNumber = linked.number
    } else {
      invoiceNumber = await nextInvoiceNumber()
      await db.invoice.create({
        data: {
          number: invoiceNumber,
          userId,
          orderId: order.id,
          domainId,
          items: JSON.stringify([
            {
              description: `Domain transfer: ${domainLower}`,
              quantity: 1,
              unitPrice: total,
              total,
            },
          ]),
          subtotal: total,
          tax: 0,
          total,
          // Unpaid until a gateway or an admin confirms the money.
          status: 'pending',
          paidAt: null,
        },
      })
    }

    await logDomainEvent(domainId, userId, 'transfer', 'success', 'Transfer initiated', {
      domain: domainLower,
      orderId: result.orderId,
    })

    return { success: true, domainId, invoiceNumber, transferPending: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const manualReview = registrarConfirmed || err instanceof RegistrarReplayRefusedError
    await logDomainEvent(null, userId, 'transfer', manualReview ? 'manual_review' : 'failed', message, {
      domain: domainLower,
    })
    return { success: false, error: message, ...(manualReview ? { manualReview: true } : {}) }
  }
}

export { tldFromDomain, applyMarkup }
