/**
 * /api/email-hosting/[serviceId]/addons
 *   GET  — what add-ons cost and what this service already has
 *   POST — order more { extraMailboxes?, extraStorageBlocks?, method }
 *
 * Add-ons are applied by `provisionForPayment` once the money is confirmed,
 * never here — ordering must not hand out allowance for free. They are
 * recurring, so `emailAddonCostForSubscription` adds them to renewal invoices.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { db } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import {
  EMAIL_ADDONS,
  STORAGE_BLOCK_GB,
  addonMonthlyCost,
  effectiveLimits,
} from '@/lib/email-hosting'
import { processPayment, resolveActiveMethod } from '@/lib/payment-methods'
import {
  findPendingAddonOrder,
  duplicateOrderMessage,
} from '@/lib/email-order-guard'

const orderSchema = z
  .object({
    extraMailboxes: z.number().int().min(0).max(200).optional(),
    /** Blocks of STORAGE_BLOCK_GB. */
    extraStorageBlocks: z.number().int().min(0).max(200).optional(),
    method: z.string().min(1).max(40).optional(),
  })
  .refine(
    (v) => (v.extraMailboxes || 0) > 0 || (v.extraStorageBlocks || 0) > 0,
    'Choose at least one add-on'
  )

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service } = await resolveEmailService(request, serviceId)
    return NextResponse.json({
      pricing: {
        extraMailbox: EMAIL_ADDONS.extraMailbox,
        extraStorage: { ...EMAIL_ADDONS.extraStorage10GB, blockGB: STORAGE_BLOCK_GB },
      },
      current: {
        extraMailboxes: service.extraMailboxes,
        extraStorageGB: service.extraStorageGB,
        monthlyCost: addonMonthlyCost(service),
      },
      limits: effectiveLimits(service),
    })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service, auth } = await resolveEmailService(request, serviceId)

    if (service.status !== 'active') {
      return NextResponse.json(
        { error: 'This email service is not active.' },
        { status: 409 }
      )
    }

    const body = orderSchema.parse(await request.json())
    const addMailboxes = body.extraMailboxes || 0
    const addStorageGB = (body.extraStorageBlocks || 0) * STORAGE_BLOCK_GB

    // A duplicate add-on order is worse than a double charge: every
    // confirmation increments the allowance, so ordering twice by accident
    // silently doubles what was bought. Refuse while one is still unpaid.
    const duplicate = await findPendingAddonOrder(auth.userId, service.id)
    if (duplicate) {
      return NextResponse.json(
        {
          error: duplicateOrderMessage(`add-ons on ${service.domain}`, duplicate),
          code: 'DUPLICATE_ORDER',
          existingOrder: duplicate,
        },
        { status: 409 }
      )
    }

    // Price the DELTA being bought, not the resulting total.
    const amount =
      Math.round(
        (addMailboxes * EMAIL_ADDONS.extraMailbox.price +
          (body.extraStorageBlocks || 0) * EMAIL_ADDONS.extraStorage10GB.price) *
          100
      ) / 100

    const method = (body.method || 'manual').toLowerCase()
    const activeMethod = await resolveActiveMethod(method)
    if (!activeMethod) {
      return NextResponse.json(
        { error: `Payment method "${method}" is not available.` },
        { status: 400 }
      )
    }

    const user = await db.user.findUnique({ where: { id: auth.userId } })
    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || ''
    const result = await processPayment({
      method,
      planId: service.planId,
      planName: `Email add-ons for ${service.domain}`,
      amount,
      currency: 'usd',
      userId: auth.userId,
      email: user.email,
      successUrl: `${appUrl}/api/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${appUrl}/?tab=email&payment=cancelled`,
      purchaseType: 'email-addon',
      domainName: service.domain,
      subscriptionId: service.subscriptionId,
      extraMetadata: {
        emailServiceId: service.id,
        addMailboxes,
        addStorageGB,
      },
    })

    await logAudit({
      userId: auth.userId,
      action: 'email.addons.order',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: result.success ? 'success' : 'failure',
      metadata: { addMailboxes, addStorageGB, amount, method, error: result.error },
    })

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || 'Could not start the add-on order' },
        { status: 502 }
      )
    }

    return NextResponse.json(
      {
        success: true,
        status: result.status,
        amount,
        addMailboxes,
        addStorageGB,
        redirectUrl: result.redirectUrl,
        paymentId: result.paymentId,
        transactionId: result.transactionId,
        message:
          result.status === 'redirect_required'
            ? `Redirecting to ${activeMethod.displayName}…`
            : 'Your add-on order is awaiting payment confirmation. The extra allowance is applied as soon as it clears.',
      },
      { status: 201 }
    )
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { error: err.issues[0]?.message || 'Invalid request' },
        { status: 400 }
      )
    }
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
