import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'
import { isStripeDemoMode } from '@/lib/stripe'
import { BRAND_DOMAIN, NS1_HOSTNAME, NS2_HOSTNAME } from '@/lib/brand-config'
import { getPriceForDomain } from '@/lib/pricing'
import { createNotification } from '@/lib/notifications'
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

    const decoded = verifyToken(token)
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
        { error: 'planId and type (hosting/domain/both) are required' },
        { status: 400 }
      )
    }

    if (!['hosting', 'domain', 'both'].includes(type)) {
      return NextResponse.json(
        { error: 'Type must be hosting, domain, or both' },
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
      subscription = await db.subscription.create({
        data: {
          userId: decoded.userId,
          planId: plan.id,
          status: 'pending',
          currentPeriodStart: now,
          currentPeriodEnd: new Date(
            now.getFullYear(),
            now.getMonth() + 1,
            now.getDate()
          ),
          stripeSubId: `sub_sim_${Date.now()}`,
        },
      })
    }

    // ═══════════════════════════════════════════════════════════════
    // SPECIAL PATH: Stripe demo mode keeps the original inline-success
    // behaviour so the existing UI flow (immediate project/domain
    // creation) keeps working unchanged.
    // ═══════════════════════════════════════════════════════════════
    if (requestedMethod === 'stripe' && isStripeDemoMode()) {
      // Create Project (hosting or both)
      let project = null
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
      let domain = null
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
            registrar: 'openprovider',
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

      // Mark the demo payment as completed
      const payment = await db.payment.update({
        where: { id: result.paymentId },
        data: {
          status: 'completed',
          stripePaymentId: result.transactionId,
          stripeInvoiceId: `in_demo_${Date.now()}`,
        },
      })

      // Activate the subscription
      if (subscription && subscription.status === 'pending') {
        await db.subscription.update({
          where: { id: subscription.id },
          data: { status: 'active' },
        })
      }

      // Process automation event
      const automationResult = await processEvent({
        type: 'payment_success',
        userId: decoded.userId,
        payload: {
          paymentId: payment.id,
          planId: plan.id,
          purchaseType: type,
          domainName: domainName || null,
          subscriptionId: subscription?.id || null,
          projectId: project?.id || null,
          domainId: domain?.id || null,
          projectName: project?.name || null,
        },
      })

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
