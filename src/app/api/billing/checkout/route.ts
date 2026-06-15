import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'
import { createCheckoutSession, isStripeDemoMode } from '@/lib/stripe'
import { createNotification } from '@/lib/notifications'

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
    const { planId, type, domainName, projectName, framework } = body

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

    // Calculate amount
    let amount = plan.price
    if (type === 'domain') {
      amount = 12.99 // Domain registration fee
    } else if (type === 'both') {
      amount = plan.price + 12.99
    }

    const demoMode = isStripeDemoMode()

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
          status: demoMode ? 'active' : 'pending',
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

    // ── DEMO MODE: simulate success immediately ─────────────────
    if (demoMode) {
      // Create Project (hosting or both)
      let project = null
      if (type === 'hosting' || type === 'both') {
        const name = projectName || `My ${plan.name} Project`
        const slug = slugify(name) + '-' + Date.now().toString(36)
        const subdomain = `${slug}.deployhub.io`
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
            coolifyId: `coolify-${Date.now()}`,
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
            nameservers: JSON.stringify([
              'ns1.deployhub.io',
              'ns2.deployhub.io',
              'ns3.deployhub.io',
            ]),
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

      // Create the demo Stripe Checkout Session (returns a fake URL)
      const sessionResult = await createCheckoutSession({
        planId: plan.id,
        planName: plan.name,
        amount: Math.round(amount * 100), // convert to cents
        currency: 'usd',
        successUrl,
        cancelUrl,
        userId: decoded.userId,
        email: user.email,
      })

      // Create Payment record marked as completed (demo mode = auto success)
      const payment = await db.payment.create({
        data: {
          userId: decoded.userId,
          subscriptionId: subscription?.id || null,
          amount,
          currency: 'usd',
          status: 'completed',
          type,
          stripePaymentId: `pay_demo_${Date.now()}`,
          stripeInvoiceId: `in_demo_${Date.now()}`,
          metadata: JSON.stringify({
            planId: plan.id,
            planName: plan.name,
            domainName: domainName || null,
            purchaseType: type,
            projectId: project?.id || null,
            domainId: domain?.id || null,
            checkoutSessionId: sessionResult.sessionId,
            demoMode: true,
          }),
        },
      })

      // Activate subscription if it was pending
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

      // Notify user
      await createNotification({
        userId: decoded.userId,
        title: 'Payment Successful',
        message: `Your ${plan.name} plan purchase has been completed (demo mode).`,
        type: 'success',
        link: '/?tab=billing',
      })

      // Build the response — preserve existing shape so the UI keeps working,
      // and add the new Stripe fields so the panel can decide what to do.
      const response: Record<string, unknown> = {
        sessionId: sessionResult.sessionId,
        url: sessionResult.url,
        demo: true,
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

    // ── REAL STRIPE MODE: create a real Checkout Session ────────
    // We do NOT create project/domain records here - that happens after
    // the webhook confirms the payment. We only create a pending Payment
    // record so we can match the webhook to the user.
    const sessionResult = await createCheckoutSession({
      planId: plan.id,
      planName: plan.name,
      amount: Math.round(amount * 100), // cents
      currency: 'usd',
      successUrl,
      cancelUrl,
      userId: decoded.userId,
      email: user.email,
    })

    // Create a pending Payment record keyed to the Stripe session ID
    const payment = await db.payment.create({
      data: {
        userId: decoded.userId,
        subscriptionId: subscription?.id || null,
        amount,
        currency: 'usd',
        status: 'pending',
        type,
        stripePaymentId: sessionResult.sessionId, // store session ID for matching
        metadata: JSON.stringify({
          planId: plan.id,
          planName: plan.name,
          domainName: domainName || null,
          purchaseType: type,
          projectName: projectName || null,
          framework: framework || null,
          checkoutSessionId: sessionResult.sessionId,
          demoMode: false,
        }),
      },
    })

    return NextResponse.json(
      {
        sessionId: sessionResult.sessionId,
        url: sessionResult.url,
        demo: false,
        paymentId: payment.id,
        message: 'Redirecting to Stripe Checkout…',
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
