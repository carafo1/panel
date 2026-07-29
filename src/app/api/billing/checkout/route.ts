import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'
import { isStripeDemoMode } from '@/lib/stripe'
import { BRAND_DOMAIN, NS1_HOSTNAME, NS2_HOSTNAME } from '@/lib/brand-config'
import { getPriceForDomain } from '@/lib/pricing'
import { assertDomainControl } from '@/lib/domain-verification'
import {
  findPendingEmailOrder,
  duplicateOrderMessage,
} from '@/lib/email-order-guard'
import { provisionForPayment } from '@/lib/provision-on-payment'
import { createNotification } from '@/lib/notifications'
import { createSubscriptionInvoice, cycleDays } from '@/lib/invoices'
import {
  processPayment,
  resolveActiveMethod,
} from '@/lib/payment-methods'

// Helper: generate a slug from a name
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const {
      planId,
      type,
      domainName,
      projectName,
      framework,
      method,
    } = body

    if (!planId || !type) {
      return NextResponse.json(
        { error: 'planId and type (hosting/email/domain/both) are required' },
        { status: 400 }
      )
    }

    if (!['hosting', 'email', 'domain', 'both'].includes(type)) {
      return NextResponse.json(
        { error: 'Type must be hosting, email, domain, or both' },
        { status: 400 }
      )
    }

    // Backward compatibility: if no method specified, default to "stripe".
    const requestedMethod = (method || 'stripe').toLowerCase()

    // Get plan
    const plan = await db.plan.findUnique({ where: { id: planId } })
    if (!plan) {
      return NextResponse.json(
        { error: 'Plan not found' },
        { status: 404 }
      )
    }

    // Standalone email hosting: the customer already owns the domain, so no
    // Project and no Domain registration is created — only the mail service,
    // which provisionForPayment raises once the money is confirmed. The domain
    // is therefore required, and the plan must actually be an email plan (a
    // hosting plan carries no mailbox allowance, so it would provision a
    // service with nothing in it).
    const emailDomain =
      typeof domainName === 'string' ? domainName.toLowerCase().trim() : ''
    if (type === 'email') {
      if (!emailDomain) {
        return NextResponse.json(
          { error: 'Enter the domain you want email on' },
          { status: 400 }
        )
      }
      if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(emailDomain)) {
        return NextResponse.json(
          { error: 'That does not look like a valid domain name' },
          { status: 400 }
        )
      }
      if (plan.planType !== 'email') {
        return NextResponse.json(
          { error: 'That plan is not an email hosting plan' },
          { status: 400 }
        )
      }

      // Refuse at checkout rather than taking the money and failing to
      // provision: the same two rules provisionEmailService enforces.
      const takenByService = await db.emailService.findUnique({
        where: { domain: emailDomain },
        select: { userId: true, status: true },
      })
      if (
        takenByService &&
        takenByService.userId !== decoded.userId &&
        takenByService.status !== 'cancelled'
      ) {
        return NextResponse.json(
          { error: 'Email hosting for this domain already exists' },
          { status: 409 }
        )
      }
      const ownedByAnother = await db.domain.findFirst({
        where: { name: emailDomain, userId: { not: decoded.userId } },
        select: { id: true },
      })
      if (ownedByAnother) {
        return NextResponse.json(
          { error: 'This domain is already registered to another account' },
          { status: 409 }
        )
      }

      // Prove control before taking money. Without this anyone could buy email
      // for a domain they do not own — they could not read its mail without
      // also controlling the MX, but they would take the domain in our system
      // and lock the real owner out, since EmailService.domain is unique.
      const control = await assertDomainControl(decoded.userId, emailDomain)
      if (!control.verified) {
        return NextResponse.json(
          {
            error: control.reason || 'Verify that you control this domain first',
            code: 'DOMAIN_UNVERIFIED',
            verification: control.record,
          },
          { status: 428 }
        )
      }

      // A double-click, a reload, or an impatient second attempt must not
      // become a second billable order. Checked last, so the customer is told
      // about a real duplicate rather than being blocked by one while the
      // order was invalid anyway.
      const duplicate = await findPendingEmailOrder(decoded.userId, emailDomain)
      if (duplicate) {
        return NextResponse.json(
          {
            error: duplicateOrderMessage(`email hosting on ${emailDomain}`, duplicate),
            code: 'DUPLICATE_ORDER',
            existingOrder: duplicate,
          },
          { status: 409 }
        )
      }

      // Buying the SAME plan for a service that already runs it is a no-op the
      // customer would be charged for. A different plan is a legitimate change
      // and must still go through — plan upgrades use this very endpoint, so
      // this deliberately does not refuse "a service already exists".
      const existingService = await db.emailService.findFirst({
        where: {
          domain: emailDomain,
          userId: decoded.userId,
          status: { in: ['active', 'suspended'] },
        },
        select: { planId: true, status: true },
      })
      if (existingService && existingService.planId === plan.id) {
        return NextResponse.json(
          {
            error:
              existingService.status === 'suspended'
                ? `${emailDomain} is already on ${plan.name} but the service is suspended. Settle the outstanding invoice to restore it rather than buying it again.`
                : `${emailDomain} is already on ${plan.name}. Choose a different plan to change it, or buy add-ons for more capacity.`,
            code: 'ALREADY_ON_PLAN',
          },
          { status: 409 }
        )
      }
    }

    // Get the user (for email)
    const user = await db.user.findUnique({ where: { id: decoded.userId } })
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      )
    }

    // Calculate amount. For domain purchases, charge the real per-TLD selling
    // price (wholesale + markup) from the DomainPrice table — a flat $12.99 fee
    // gave away margin on expensive TLDs (.ai ≈ $95, .io ≈ $39) and could
    // overcharge on cheap ones. Falls back to $12.99 only when no priced row
    // is found for the domain's TLD.
    let domainFee = 12.99
    if ((type === 'domain' || type === 'both') && typeof domainName === 'string' && domainName.trim()) {
      const priceRow = await getPriceForDomain(domainName.trim().toLowerCase())
      if (priceRow?.registration && priceRow.registration > 0) {
        domainFee = priceRow.registration
      }
    }
    let amount = plan.price
    if (type === 'domain') {
      amount = domainFee
    } else if (type === 'both') {
      amount = plan.price + domainFee
    }

    // ── Validate requested method is active ───────────────────────
    const activeMethod = await resolveActiveMethod(requestedMethod)
    if (!activeMethod) {
      return NextResponse.json(
        {
          error: `Payment method "${requestedMethod}" is not available. Please choose another method.`,
        },
        { status: 400 }
      )
    }

    // ── Build success & cancel URLs ─────────────────────────────
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    const successUrl = `${appUrl}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl = `${appUrl}/?tab=billing&payment=cancelled`

    // ── Create or get Subscription ────────────────────────────────
    let subscription = await db.subscription.findFirst({
      where: {
        userId: decoded.userId,
        status: { in: ['active', 'pending'] },
      },
    })

    if (!subscription && type !== 'domain') {
      const now = new Date()
      // Respect the plan's billing cycle instead of assuming one month.
      // "lifetime" gets a far-future end date so nothing ever expires it.
      const days = cycleDays((plan as { billingCycle?: string }).billingCycle || 'monthly')
      const periodEnd = days
        ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000)
        : new Date(now.getFullYear() + 100, now.getMonth(), now.getDate())

      subscription = await db.subscription.create({
        data: {
          userId: decoded.userId,
          planId: plan.id,
          status: 'pending',
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
          stripeSubId: `sub_sim_${Date.now()}`,
        },
      })

      // Raise an unpaid invoice for the period so the customer has a real
      // document to pay against (essential for bank transfer) and a record
      // afterwards. Settled automatically when the payment is confirmed.
      await createSubscriptionInvoice({
        userId: decoded.userId,
        subscriptionId: subscription.id,
        planId: plan.id,
        planName: plan.name,
        amount,
        currency: (plan as { currency?: string }).currency || 'USD',
        periodStart: now,
        periodEnd,
      }).catch((err) =>
        console.error('[checkout] invoice creation failed:', err)
      )
    }

    // ═══════════════════════════════════════════════════════════════
    // SPECIAL PATH: Stripe demo mode keeps the original inline-success
    // behaviour so the existing UI flow (immediate project/domain
    // creation) keeps working unchanged.
    // ═══════════════════════════════════════════════════════════════
    if (requestedMethod === 'stripe' && isStripeDemoMode()) {
      // Create Project (hosting or both)
      // Typed explicitly: `let project = null` infers the type `null`, which
      // makes every later `project.id` a `never` and hides real errors.
      let project: Awaited<ReturnType<typeof db.project.create>> | null = null
      if (type === 'hosting' || type === 'both') {
        const name = projectName || `My ${plan.name} Project`
        const slug = slugify(name) + '-' + Date.now().toString(36)
        const subdomain = `${slug}.${BRAND_DOMAIN}`
        const fw = framework || 'nextjs'

        const servers = await db.server.findMany({
          where: { status: 'active' },
          include: { _count: { select: { projects: true } } },
          orderBy: { usedRamGB: 'asc' },
        })
        const bestServer = servers[0] || null

        project = await db.project.create({
          data: {
            userId: decoded.userId,
            name,
            slug,
            framework: fw,
            status: 'creating',
            subdomain,
            serverId: bestServer?.id || null,
            sslEnabled: true,
            autoDeploy: true,
          },
        })
      }

      // Create Domain (domain or both)
      let domain: Awaited<ReturnType<typeof db.domain.create>> | null = null
      if ((type === 'domain' || type === 'both') && domainName) {
        const domainLower = domainName.toLowerCase().trim()

        const existingDomain = await db.domain.findUnique({
          where: { name: domainLower },
        })
        if (existingDomain) {
          if (project) {
            await db.project.delete({ where: { id: project.id } })
          }
          return NextResponse.json(
            { error: 'Domain is already registered' },
            { status: 409 }
          )
        }

        const server = await db.server.findFirst({
          where: { status: 'active' },
          orderBy: { usedRamGB: 'asc' },
        })

        domain = await db.domain.create({
          data: {
            userId: decoded.userId,
            projectId: project?.id || null,
            name: domainLower,
            status: 'pending',
            registrar: 'dynadot',
            registeredAt: new Date(),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            autoRenew: true,
            whoisPrivacy: true,
            nameservers: JSON.stringify([NS1_HOSTNAME, NS2_HOSTNAME]),
          },
        })

        if (server) {
          await db.dnsRecord.create({
            data: {
              domainId: domain.id,
              type: 'A',
              name: '@',
              value: server.ip,
              ttl: 3600,
              proxied: true,
            },
          })
        }

        await db.dnsRecord.create({
          data: {
            domainId: domain.id,
            type: 'CNAME',
            name: 'www',
            value: domainLower,
            ttl: 3600,
            proxied: true,
          },
        })

        if (project) {
          await db.project.update({
            where: { id: project.id },
            data: { customDomain: domainLower },
          })
        }
      }

      // Process the payment through the unified dispatcher. In demo mode
      // Stripe returns a fake session URL; we then mark the payment as
      // completed and drive the automation pipeline immediately.
      const result = await processPayment({
        method: 'stripe',
        planId: plan.id,
        planName: plan.name,
        amount,
        currency: 'usd',
        userId: decoded.userId,
        email: user.email,
        successUrl,
        cancelUrl,
        purchaseType: type,
        domainName: domainName || null,
        projectName: projectName || null,
        framework: framework || null,
        subscriptionId: subscription?.id || null,
      })

      if (!result.success || !result.paymentId) {
        if (project) {
          await db.project.delete({ where: { id: project.id } }).catch(() => {})
        }
        if (domain) {
          await db.domain.delete({ where: { id: domain.id } }).catch(() => {})
        }
        return NextResponse.json(
          { error: result.error || 'Payment initiation failed' },
          { status: 502 }
        )
      }

      // Mark the demo payment as completed.
      //
      // The projectId is written into the metadata so provisionForPayment
      // reuses the Project created above instead of building a second one.
      let demoMeta: Record<string, unknown> = {}
      try {
        const existing = await db.payment.findUnique({
          where: { id: result.paymentId },
          select: { metadata: true },
        })
        demoMeta = existing?.metadata ? JSON.parse(existing.metadata) : {}
      } catch {
        demoMeta = {}
      }

      const payment = await db.payment.update({
        where: { id: result.paymentId },
        data: {
          status: 'completed',
          stripePaymentId: result.transactionId,
          stripeInvoiceId: `in_demo_${Date.now()}`,
          metadata: JSON.stringify({
            ...demoMeta,
            ...(project ? { projectId: project.id } : {}),
          }),
        },
      })

      // Activate the subscription
      if (subscription && subscription.status === 'pending') {
        await db.subscription.update({
          where: { id: subscription.id },
          data: { status: 'active' },
        })
      }

      // REAL provisioning — every other payment path (Stripe webhook, Stripe
      // return, Waafi callback, offline confirmation) calls this. Only the
      // demo path called the simulated processEvent('payment_success'), whose
      // actions just send notifications: a demo purchase reported success and
      // built nothing — no container deployed, and for email no mail domain
      // at all. Idempotent, so it cannot double-provision.
      const provision = await provisionForPayment(payment.id).catch(
        (err: unknown) => {
          console.error('[checkout/demo] provisioning failed:', err)
          return { provisioned: false, detail: 'provisioning error' }
        }
      )
      console.log(
        `[checkout/demo] provisioning for ${payment.id}: ${provision.detail}`
      )
      const automationResult = provision

      await createNotification({
        userId: decoded.userId,
        title: 'Payment Successful',
        message: `Your ${plan.name} plan purchase has been completed (demo mode).`,
        type: 'success',
        link: '/?tab=billing',
      })

      // Build the response — preserve existing shape so the UI keeps working
      const response: Record<string, unknown> = {
        sessionId: result.sessionId,
        url: result.redirectUrl,
        demo: true,
        method: 'stripe',
        payment: {
          id: payment.id,
          amount: payment.amount,
          currency: payment.currency,
          status: 'completed',
          type: payment.type,
        },
        subscription: subscription
          ? {
              id: subscription.id,
              status: 'active',
              planName: plan.name,
              planId: plan.id,
            }
          : null,
        automation: automationResult,
      }

      if (project) {
        const updatedProject = await db.project.findUnique({
          where: { id: project.id },
        })
        response.project = updatedProject
          ? {
              id: updatedProject.id,
              name: updatedProject.name,
              slug: updatedProject.slug,
              subdomain: updatedProject.subdomain,
              status: updatedProject.status,
              framework: updatedProject.framework,
              customDomain: updatedProject.customDomain,
            }
          : null
      }

      if (domain) {
        const updatedDomain = await db.domain.findUnique({
          where: { id: domain.id },
          include: { dnsRecords: true },
        })
        response.domain = updatedDomain
          ? {
              id: updatedDomain.id,
              name: updatedDomain.name,
              status: updatedDomain.status,
              registrar: updatedDomain.registrar,
              registeredAt: updatedDomain.registeredAt,
              expiresAt: updatedDomain.expiresAt,
              dnsRecords: updatedDomain.dnsRecords,
            }
          : null
      }

      if (project) {
        const deployment = await db.deployment.findFirst({
          where: { projectId: project.id },
          orderBy: { createdAt: 'desc' },
        })
        response.deployment = deployment
          ? {
              id: deployment.id,
              status: deployment.status,
              deployUrl: deployment.deployUrl,
              branch: deployment.branch,
            }
          : null
      }

      return NextResponse.json(response, { status: 201 })
    }

    // ═══════════════════════════════════════════════════════════════
    // UNIFIED PATH: any method (real Stripe, Waafi, manual, real-mode
    // Stripe redirect) - dispatch through processPayment and return a
    // generic response the UI can branch on.
    // ═══════════════════════════════════════════════════════════════
    const result = await processPayment({
      method: requestedMethod,
      planId: plan.id,
      planName: plan.name,
      amount,
      currency: 'usd',
      userId: decoded.userId,
      email: user.email,
      successUrl,
      cancelUrl,
      purchaseType: type,
      domainName: domainName || null,
      projectName: projectName || null,
      framework: framework || null,
      subscriptionId: subscription?.id || null,
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Payment initiation failed' },
        { status: 502 }
      )
    }

    // For Stripe demo we already returned above; this branch handles:
    //  - Real Stripe Checkout (status: redirect_required)
    //  - Waafi Pay (status: redirect_required)
    //  - Manual / Bank Transfer (status: pending - admin confirms later)
    return NextResponse.json(
      {
        success: true,
        method: requestedMethod,
        status: result.status,
        // Stripe-style fields, kept for UI backward compatibility:
        sessionId: result.sessionId,
        url: result.redirectUrl,
        // New generic fields:
        redirectUrl: result.redirectUrl,
        transactionId: result.transactionId,
        paymentId: result.paymentId,
        demo: false,
        // Offline / bank-transfer: send the admin-configured details so the
        // customer is actually told where to pay and what reference to quote.
        paymentDetails:
          requestedMethod === 'manual'
            ? (() => {
                const c = (activeMethod.config || {}) as Record<string, unknown>
                const str = (k: string) =>
                  typeof c[k] === 'string' && (c[k] as string).trim()
                    ? (c[k] as string)
                    : null

                // Admin can configure several accounts (banks, mobile money,
                // cash). Fall back to the legacy single-account shape so an
                // un-migrated config still shows something.
                const rawAccounts = Array.isArray(c.accounts) ? c.accounts : []
                let accounts = rawAccounts
                  .filter((a) => a && typeof a === 'object')
                  .map((a) => {
                    const o = a as Record<string, unknown>
                    const f = (k: string) =>
                      typeof o[k] === 'string' && (o[k] as string).trim()
                        ? (o[k] as string)
                        : null
                    return {
                      label: f('label'),
                      type: f('type') || 'bank',
                      accountName: f('accountName'),
                      accountNumber: f('accountNumber'),
                      iban: f('iban'),
                      swift: f('swift'),
                      phone: f('phone'),
                      note: f('note'),
                    }
                  })
                  .filter((a) => a.label)

                if (!accounts.length && (str('bankName') || str('accountNumber'))) {
                  accounts = [
                    {
                      label: str('bankName') || 'Bank transfer',
                      type: 'bank',
                      accountName: str('accountName'),
                      accountNumber: str('accountNumber'),
                      iban: str('iban'),
                      swift: str('swift'),
                      phone: str('mobileMoney'),
                      note: null,
                    },
                  ]
                }

                return {
                  reference: result.transactionId || null,
                  instructions: str('instructions'),
                  accounts,
                }
              })()
            : undefined,
        message:
          result.status === 'redirect_required'
            ? `Redirecting to ${activeMethod.displayName}…`
            : result.status === 'pending'
              ? 'Your payment is pending admin confirmation. You will be notified once approved.'
              : 'Payment initiated.',
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Checkout error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
