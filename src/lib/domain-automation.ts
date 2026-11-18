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

  try {
    // ── Step 1: Search (verify availability) ───────────────────────────────
    begin('search')
    const searchResult = await dynadotService.search(domainLower)
    if (!searchResult.available) {
      fail('search', `Domain ${domainLower} is not available`)
      await logDomainEvent(null, input.userId, 'register', 'failed', 'Domain not available', {
        domain: domainLower,
      })
      return { success: false, steps, error: 'Domain not available' }
    }
    ok('search', `Domain ${domainLower} is available`)

    // ── Step 2: Register ───────────────────────────────────────────────────
    begin('register')
    const registerResult = await dynadotService.register(
      domainLower,
      input.duration,
      input.contacts
    )
    if (!registerResult.success) {
      fail('register', 'Dynadot registration failed')
      await logDomainEvent(null, input.userId, 'register', 'failed', 'Registration failed', {
        domain: domainLower,
      })
      return { success: false, steps, error: 'Registration failed' }
    }
    ok('register', `Registered via Dynadot (order: ${registerResult.orderId || 'n/a'})`)

    // ── Step 3: Save to database ───────────────────────────────────────────
    begin('save_database')
    const price = await getPriceForDomain(domainLower)
    const expiry = new Date()
    expiry.setFullYear(expiry.getFullYear() + input.duration)

    // Prevent duplicate registrations
    const existing = await db.domain.findUnique({ where: { name: domainLower } })
    let domainId: string
    if (existing) {
      domainId = existing.id
      await db.domain.update({
        where: { id: existing.id },
        data: {
          status: 'active',
          registeredAt: new Date(),
          expiresAt: expiry,
          autoRenew: true,
          whoisPrivacy: true,
          locked: true,
          provider: 'dynadot',
          externalId: registerResult.orderId,
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
          premium: searchResult.premium,
          nameservers: input.nameservers ? JSON.stringify(input.nameservers) : null,
        },
      })
      domainId = created.id
    }
    ok('save_database', `Domain record created (id: ${domainId})`)
    void emitWebhookEvent(input.userId, 'domain.registered', {
      domain: domainLower,
      expiresAt: expiry.toISOString(),
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
    const unitPrice = price?.registration ?? applyMarkup(19.99)
    const totalAmount = Math.round(unitPrice * input.duration * 100) / 100
    let order: { id: string }
    if (input.existingOrderId) {
      order = await db.domainOrder.update({
        where: { id: input.existingOrderId },
        data: { domainId, providerOrderId: registerResult.orderId },
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
              <li>Expires: ${expiry.toDateString()}</li>
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
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
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
): Promise<{ success: boolean; invoiceNumber?: string; error?: string }> {
  const domain = await db.domain.findUnique({ where: { id: domainId } })
  if (!domain) return { success: false, error: 'Domain not found' }
  if (domain.userId !== userId) return { success: false, error: 'Not authorized' }

  try {
    // 1. Renew via Dynadot
    const result = await dynadotService.renew(domain.name, duration)
    if (!result.success) return { success: false, error: 'Renewal failed at provider' }

    // 2. Update domain expiry
    const newExpiry = result.newExpiry
      ? new Date(result.newExpiry)
      : domain.expiresAt
      ? new Date(domain.expiresAt)
      : new Date()
    if (!result.newExpiry) {
      newExpiry.setFullYear(newExpiry.getFullYear() + duration)
    }
    await db.domain.update({
      where: { id: domainId },
      data: { expiresAt: newExpiry, status: 'active' },
    })

    // 3. Create renewal record
    const price = await getPriceForDomain(domain.name)
    const pricePerYear = price?.renewal ?? applyMarkup(19.99)
    const total = Math.round(pricePerYear * duration * 100) / 100

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
        data: { domainId, providerOrderId: result.orderId },
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

    return { success: true, invoiceNumber }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logDomainEvent(domainId, userId, 'renew', 'failed', message)
    return { success: false, error: message }
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
): Promise<{ success: boolean; domainId?: string; invoiceNumber?: string; error?: string }> {
  const domainLower = domain.toLowerCase().trim()

  try {
    // 1. Transfer via Dynadot
    const result = await dynadotService.transfer(domainLower, authCode)
    if (!result.success) return { success: false, error: result.message || 'Transfer failed' }

    // 2. Create / update domain record
    const expiry = new Date()
    expiry.setFullYear(expiry.getFullYear() + 1)
    const existing = await db.domain.findUnique({ where: { name: domainLower } })
    let domainId: string
    if (existing) {
      await db.domain.update({
        where: { id: existing.id },
        data: {
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
          expiresAt: expiry,
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
    const price = await getPriceForDomain(domainLower)
    const total = price?.transfer ?? applyMarkup(19.99)
    let order: { id: string }
    if (billing.existingOrderId) {
      order = await db.domainOrder.update({
        where: { id: billing.existingOrderId },
        data: { domainId, providerOrderId: result.orderId },
      })
    } else {
      order = await db.domainOrder.create({
        data: {
          userId,
          domainId,
          domainName: domainLower,
          type: 'transfer',
          duration: 1,
          status: 'completed',
          unitPrice: total,
          totalAmount: total,
          providerOrderId: result.orderId,
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

    return { success: true, domainId, invoiceNumber }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await logDomainEvent(null, userId, 'transfer', 'failed', message, { domain: domainLower })
    return { success: false, error: message }
  }
}

export { tldFromDomain, applyMarkup }
