/**
 * Plan upgrade / downgrade.
 *
 *   GET  /api/billing/plan-change?planId=…  — price it and check it fits
 *   POST /api/billing/plan-change           — apply it
 *
 * There was no way to change a plan at all: `planId` was written once at
 * checkout and never again, so a customer who outgrew Starter could only buy a
 * second subscription, and one who wanted to spend less had no route.
 *
 * GET is the important half. It reports what the change costs AND whether the
 * customer's current usage fits the target plan, so a downgrade that would
 * strand 8 websites on a 1-website plan is refused with the specifics rather
 * than applied and left to fail on every subsequent limit check.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { authenticateRequest } from '@/lib/auth'
import { withRateLimit } from '@/lib/rate-limit'
import { logAudit } from '@/lib/audit'
import { previewPlanChange, changePlan } from '@/lib/plan-change'
import { requireVerifiedEmail } from '@/lib/require-verified'

const bodySchema = z.object({
  planId: z.string().min(1, 'planId is required'),
})

async function getHandler(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const planId = new URL(request.url).searchParams.get('planId') || ''
  if (!planId) {
    return NextResponse.json({ error: 'planId is required' }, { status: 400 })
  }

  const preview = await previewPlanChange(user.userId, planId)
  // A preview that reports "does not fit" is a successful preview, not a failed
  // request — the caller needs the blockers to show them.
  return NextResponse.json(preview)
}

async function postHandler(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  // Changing plan bills the customer, so it sits behind the same
  // confirmed-email gate as checkout.
  const gate = await requireVerifiedEmail(user.userId, user.role)
  if (!gate.ok) return gate.response!

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || 'Invalid request' },
      { status: 400 }
    )
  }

  const result = await changePlan(user.userId, parsed.data.planId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409 })
  }

  await logAudit({
    userId: user.userId,
    action: 'subscription.plan_changed',
    resource: 'subscription',
    resourceId: result.subscriptionId,
    req: request,
    metadata: {
      planId: parsed.data.planId,
      amountDue: result.amountDue,
      creditIssued: result.creditIssued,
      invoiceNumber: result.invoiceNumber,
    },
  }).catch(() => {})

  return NextResponse.json({
    ...result,
    // New CPU/RAM caps are written to every project, but a running container
    // keeps its current cgroup limits until it is recreated. Say so rather
    // than implying the change is already live in the container.
    message:
      result.amountDue && result.amountDue > 0
        ? `Plan changed. Invoice ${result.invoiceNumber} raised for the remainder of this period. Redeploy your sites to apply the new resource limits.`
        : result.creditIssued
        ? `Plan changed. ${result.creditIssued.toFixed(2)} credit added to your account. Redeploy your sites to apply the new resource limits.`
        : 'Plan changed. Redeploy your sites to apply the new resource limits.',
  })
}

// Plan changes move money and rewrite every project's allowance.
export const GET = withRateLimit(getHandler, { limit: 30, windowMs: 60_000 })
export const POST = withRateLimit(postHandler, { limit: 10, windowMs: 60_000 })
