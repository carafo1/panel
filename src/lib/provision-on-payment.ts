/**
 * Real provisioning on confirmed payment.
 *
 * Dispatches a confirmed payment to the REAL infrastructure:
 *
 *   - domain order   → fulfilDomainOrder (registrar via the DomainOrder, which
 *                      carries the registrant contacts and the paid term)
 *   - hosting        → create a Project + Deployment, run deployProject()
 *                      (real Docker container on a {slug}.BRAND_DOMAIN subdomain)
 *   - email          → Mailcow domain + DKIM
 *   - email-addon    → raise an existing service's allowance
 *
 * IMPORTANT: domain registration spends real registrar balance and is
 * irreversible. This runs only AFTER a payment is confirmed.
 *
 * ── Provisioning state machine (Payment.provisionStatus) ──────────────────
 *
 * Payment confirmation (status = completed) and provisioning are separate. A
 * run CLAIMS the payment with one conditional update that only matches
 *
 *   - 'none' (never attempted, provisionClaimedAt still null), or
 *   - 'retry_pending' (an earlier attempt failed before any side effect), or
 *   - 'claimed' / 'provisioning' whose lease has expired (the process died),
 *
 * and moves it to 'provisioning' with a 30-minute lease and attempts + 1.
 * The run then ends in exactly one of:
 *
 *   - 'provisioned'    success; lease cleared
 *   - 'retry_pending'  failed BEFORE any external side effect; the reconcile
 *                      sweep retries with backoff ('failed' after 3 attempts)
 *   - 'manual_review'  failed AFTER an external call that may have succeeded
 *                      (registrar purchase, container build) — never re-run
 *                      automatically; an admin must reconcile first
 *   - 'failed'         cannot succeed without a human (bad data, no plan, …)
 *
 * The claim used to be a one-way flag: every non-success return kept it, so a
 * paid order that hit a transient error was never provisioned and nothing
 * could retry it.
 */
import { db } from '@/lib/db'
import { deployProject } from '@/lib/vps'
import { fulfilDomainOrder } from '@/lib/domain-checkout'
import { slugify } from '@/lib/utils'
import { BRAND_DOMAIN } from '@/lib/brand-config'
import { provisionEmailService, syncMailcowLimits } from '@/lib/email-hosting'
import { selectHostingServer, NO_SERVER_MESSAGE } from '@/lib/server-selection'

export type ProvisionStatus =
  | 'none'
  | 'claimed'
  | 'provisioning'
  | 'provisioned'
  | 'failed'
  | 'retry_pending'
  | 'manual_review'

export interface ProvisionResult {
  provisioned: boolean
  detail: string
  projectId?: string
  jobId?: string
  /** The provisionStatus this run left on the payment (absent when not claimed). */
  status?: ProvisionStatus
}

/** How long a claim is honoured before another run may take it over. */
export const PROVISION_LEASE_MS = 30 * 60 * 1000
/** Retries before a 'retry_pending' payment becomes 'failed'. */
export const PROVISION_MAX_ATTEMPTS = 3

/** Backoff before the sweep retries: 5 min, 20 min, 80 min … */
export function provisionRetryDelayMs(attempts: number): number {
  return 5 * 60 * 1000 * Math.pow(4, Math.max(0, attempts - 1))
}

type Outcome = 'provisioned' | 'retry' | 'manual_review' | 'failed'

interface RunResult {
  outcome: Outcome
  detail: string
  projectId?: string
  jobId?: string
}

/** Map a checkout "framework" hint onto a provisioning stack. */
function frameworkToStack(framework: unknown): string {
  const f = String(framework || '').toLowerCase()
  if (f.includes('word')) return 'wordpress'
  if (f.includes('php') || f.includes('laravel')) return 'php'
  if (f.includes('python') || f.includes('django') || f.includes('flask'))
    return 'python'
  if (f.includes('docker')) return 'docker'
  return 'nodejs'
}

function parseMeta(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Merge into the payment's metadata, re-reading first so nothing is clobbered. */
async function patchPaymentMeta(
  paymentId: string,
  patch: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const row = await db.payment.findUnique({
    where: { id: paymentId },
    select: { metadata: true },
  })
  const merged = { ...parseMeta(row?.metadata), ...patch }
  await db.payment.update({
    where: { id: paymentId },
    data: { metadata: JSON.stringify(merged) },
  })
  return merged
}

/**
 * Atomically claim a completed payment for a provisioning run. Returns true
 * only for the single caller whose conditional update matched.
 */
export async function claimProvisioning(paymentId: string): Promise<boolean> {
  const now = new Date()
  const res = await db.payment.updateMany({
    where: {
      id: paymentId,
      status: 'completed',
      OR: [
        // Never attempted. A legacy row claimed before provisionStatus
        // existed has provisionClaimedAt set and must NOT be re-run.
        { provisionStatus: 'none', provisionClaimedAt: null },
        { provisionStatus: 'retry_pending' },
        // Abandoned by a crashed run.
        {
          provisionStatus: { in: ['claimed', 'provisioning'] },
          provisionLeaseUntil: { lt: now },
        },
      ],
    },
    data: {
      provisionStatus: 'provisioning',
      provisionLeaseUntil: new Date(now.getTime() + PROVISION_LEASE_MS),
      provisionAttempts: { increment: 1 },
      provisionClaimedAt: now,
    },
  })
  return res.count === 1
}

/** Record how a claimed run ended. */
async function settle(
  paymentId: string,
  run: RunResult
): Promise<ProvisionStatus> {
  const current = await db.payment.findUnique({
    where: { id: paymentId },
    select: { provisionAttempts: true },
  })
  const attempts = current?.provisionAttempts ?? 0
  let status: ProvisionStatus
  switch (run.outcome) {
    case 'provisioned':
      status = 'provisioned'
      break
    case 'retry':
      status = attempts >= PROVISION_MAX_ATTEMPTS ? 'failed' : 'retry_pending'
      break
    case 'manual_review':
      status = 'manual_review'
      break
    default:
      status = 'failed'
  }
  await db.payment.update({
    where: { id: paymentId },
    data: {
      provisionStatus: status,
      provisionLeaseUntil: null,
      provisionError: status === 'provisioned' ? null : run.detail.slice(0, 2000),
    },
  })
  if (status !== 'provisioned') {
    console.error(
      `[provision-on-payment] payment ${paymentId} → ${status} (attempt ${attempts}): ${run.detail}`
    )
  }
  return status
}

export interface ProvisionOptions {
  /**
   * An admin has confirmed the registrar state of this payment's domain order
   * (e.g. verified nothing was registered). Lets a retry proceed past the
   * 'registrar called, outcome unknown' guard. Never set automatically.
   */
  registrarReconciled?: boolean
}

export async function provisionForPayment(
  paymentId: string,
  opts: ProvisionOptions = {}
): Promise<ProvisionResult> {
  const payment = await db.payment.findUnique({ where: { id: paymentId } })
  if (!payment) return { provisioned: false, detail: 'payment not found' }

  // Only money that has actually been confirmed is provisioned.
  if (payment.status !== 'completed') {
    return {
      provisioned: false,
      detail: `payment is ${payment.status}, not completed`,
    }
  }

  const meta0 = parseMeta(payment.metadata)
  // Rows provisioned before provisionStatus existed only carry the metadata
  // flag; they must never be re-run.
  if (payment.provisionStatus === 'none' && meta0.provisionStarted) {
    return { provisioned: false, detail: 'provisioning already started' }
  }

  if (!(await claimProvisioning(payment.id))) {
    const now = await db.payment.findUnique({
      where: { id: payment.id },
      select: { provisionStatus: true },
    })
    return {
      provisioned: false,
      detail:
        now?.provisionStatus === 'provisioned'
          ? 'already provisioned'
          : `provisioning already started (${now?.provisionStatus ?? 'unknown'})`,
    }
  }

  // Keep the legacy metadata flag for the admin views that read it.
  const meta = await patchPaymentMeta(payment.id, {
    provisionStarted: true,
    provisionStartedAt: new Date().toISOString(),
  })

  let run: RunResult
  try {
    run = await runProvisioning(payment, meta, opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // A throw escaping runProvisioning happened before any non-idempotent
    // external call (those are wrapped and classified inside), so a retry is
    // safe.
    run = { outcome: 'retry', detail: msg }
  }

  const status = await settle(payment.id, run)
  return {
    provisioned: run.outcome === 'provisioned',
    detail: run.detail,
    projectId: run.projectId,
    jobId: run.jobId,
    status,
  }
}

type PaymentRow = NonNullable<Awaited<ReturnType<typeof db.payment.findUnique>>>

async function runProvisioning(
  payment: PaymentRow,
  meta: Record<string, unknown>,
  opts: ProvisionOptions
): Promise<RunResult> {
  const purchaseType = String(meta.purchaseType || payment.type || 'hosting')
  const domainName =
    typeof meta.domainName === 'string' && meta.domainName.trim()
      ? meta.domainName.toLowerCase().trim()
      : null

  // ── DOMAIN ORDER → checkout fulfilment ──────────────────────────────
  const domainOrderId =
    typeof meta.domainOrderId === 'string' && meta.domainOrderId
      ? meta.domainOrderId
      : null
  if (domainOrderId) {
    return fulfilDomainForPayment(payment, domainOrderId, opts)
  }

  // ── Legacy DOMAIN / BOTH without a DomainOrder ──────────────────────
  // These used to go to the orchestration pipeline, which registered the name
  // for one year with no registrant contacts and no availability or ownership
  // checks. Checkout now raises a DomainOrder instead; a payment confirmed
  // without one (created before that change) needs a human.
  if (purchaseType === 'domain' || purchaseType === 'both') {
    return {
      outcome: 'manual_review',
      detail: `legacy ${purchaseType} purchase${
        domainName ? ` for ${domainName}` : ''
      } has no DomainOrder (no registrant contacts); raise a domain order for it manually`,
    }
  }

  if (purchaseType === 'hosting') return provisionHostingForPayment(payment, meta)

  // ── EMAIL HOSTING → mail domain on Mailcow, no website ──────────────
  if (purchaseType === 'email') {
    if (!domainName) return { outcome: 'failed', detail: 'email purchase has no domain' }
    const planId = typeof meta.planId === 'string' ? meta.planId : ''
    if (!planId) return { outcome: 'failed', detail: 'email purchase has no plan' }
    const subscriptionId =
      typeof meta.subscriptionId === 'string' ? meta.subscriptionId : null

    // provisionEmailService is idempotent by domain (an existing Mailcow
    // domain is adopted), so a failure is safe to retry.
    const res = await provisionEmailService({
      userId: payment.userId,
      planId,
      domain: domainName,
      subscriptionId,
    })
    if (!res.success) {
      return {
        outcome: 'retry',
        detail: `email provisioning failed: ${res.error || 'unknown error'}`,
      }
    }
    return { outcome: 'provisioned', detail: `email hosting ready for ${domainName}` }
  }

  // ── EMAIL ADD-ONS → raise an existing service's allowance ───────────
  if (purchaseType === 'email-addon') {
    const serviceId = typeof meta.emailServiceId === 'string' ? meta.emailServiceId : ''
    if (!serviceId) return { outcome: 'failed', detail: 'add-on purchase has no service' }
    const addMailboxes = Number(meta.addMailboxes) || 0
    const addStorageGB = Number(meta.addStorageGB) || 0
    if (addMailboxes <= 0 && addStorageGB <= 0) {
      return { outcome: 'failed', detail: 'add-on purchase has no quantity' }
    }

    const service = await db.emailService.findUnique({ where: { id: serviceId } })
    if (!service) return { outcome: 'failed', detail: `email service ${serviceId} not found` }
    if (service.userId !== payment.userId) {
      return { outcome: 'failed', detail: 'add-on does not belong to the payer' }
    }

    // The increment is not idempotent, so it is recorded on the payment in the
    // same transaction: a retry only re-pushes the limits.
    let updated = service
    if (!meta.addonApplied) {
      updated = await db.$transaction(async (tx) => {
        const row = await tx.payment.findUnique({
          where: { id: payment.id },
          select: { metadata: true },
        })
        const m = parseMeta(row?.metadata)
        if (m.addonApplied) {
          return tx.emailService.findUniqueOrThrow({ where: { id: serviceId } })
        }
        const svc = await tx.emailService.update({
          where: { id: serviceId },
          data: {
            extraMailboxes: { increment: addMailboxes },
            extraStorageGB: { increment: addStorageGB },
          },
        })
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            metadata: JSON.stringify({
              ...m,
              addonApplied: true,
              addonAppliedAt: new Date().toISOString(),
            }),
          },
        })
        return svc
      })
    }
    const sync = await syncMailcowLimits(updated)
    if (!sync.success) {
      return {
        outcome: 'retry',
        detail: `add-ons recorded but the mail server rejected the new limits: ${sync.error}`,
      }
    }
    return {
      outcome: 'provisioned',
      detail: `added ${addMailboxes} mailbox(es) and ${addStorageGB} GB to ${service.domain}`,
    }
  }

  return {
    outcome: 'failed',
    detail: `no provisioning defined for purchase type "${purchaseType}"`,
  }
}

/** Has the registrar possibly been charged for this order without us knowing the outcome? */
function registrarOutcomeUnknown(order: {
  registrarCalledAt: Date | null
  registrarConfirmedAt: Date | null
}): boolean {
  return !!order.registrarCalledAt && !order.registrarConfirmedAt
}

async function fulfilDomainForPayment(
  payment: PaymentRow,
  domainOrderId: string,
  opts: ProvisionOptions
): Promise<RunResult> {
  const order = await db.domainOrder.findUnique({ where: { id: domainOrderId } })
  if (!order) return { outcome: 'failed', detail: `domain order ${domainOrderId} not found` }
  if (order.userId !== payment.userId) {
    return { outcome: 'failed', detail: `domain order ${domainOrderId} does not belong to the payer` }
  }
  if (order.status === 'completed') {
    return { outcome: 'provisioned', detail: `domain order ${domainOrderId} already fulfilled` }
  }
  // Never trigger a second purchase: a registrar call with no recorded
  // outcome, or an order another run left mid-flight, needs reconciling with
  // the registrar first.
  if (registrarOutcomeUnknown(order) && !opts.registrarReconciled) {
    return {
      outcome: 'manual_review',
      detail: `domain order ${domainOrderId}: registrar was called with no confirmed outcome; reconcile with the registrar before any retry`,
    }
  }
  if (order.status === 'processing' || order.status === 'manual_review') {
    return {
      outcome: 'manual_review',
      detail: `domain order ${domainOrderId} is ${order.status}; reconcile before any retry`,
    }
  }
  if (order.status === 'cancelled' || order.status === 'refunded') {
    return { outcome: 'failed', detail: `domain order ${domainOrderId} is ${order.status}` }
  }
  // fulfilDomainOrder never re-claims 'failed'. A failed order whose
  // registrar call never happened is safe to retry, so it is requeued here
  // (conditionally — the same rule as the reconcile sweep).
  if (order.status === 'failed') {
    await db.domainOrder.updateMany({
      where: { id: domainOrderId, status: 'failed', registrarCalledAt: null },
      data: { status: 'retry_pending' },
    })
  }

  let result: Awaited<ReturnType<typeof fulfilDomainOrder>>
  try {
    result = await fulfilDomainOrder(domainOrderId, {
      paymentId: payment.id,
      gateway: payment.method || 'stripe',
    })
  } catch (err) {
    result = { success: false, error: err instanceof Error ? err.message : String(err) }
  }
  if (result.success) {
    return {
      outcome: 'provisioned',
      detail: result.alreadyFulfilled
        ? `domain order ${domainOrderId} already fulfilled`
        : `domain order ${domainOrderId} fulfilled`,
    }
  }

  // Classify the failure from what the order recorded about the registrar.
  const after = await db.domainOrder.findUnique({
    where: { id: domainOrderId },
    select: { registrarCalledAt: true, registrarConfirmedAt: true, status: true },
  })
  const detail = `domain order ${domainOrderId} failed: ${result.error || 'unknown'}`
  // The fulfilment held the order for manual review (registrar may have
  // bought): never retried automatically.
  if (/held for manual review/i.test(result.error || '')) {
    return { outcome: 'manual_review', detail }
  }
  if (
    !after ||
    after.registrarCalledAt ||
    after.registrarConfirmedAt ||
    after.status === 'processing' ||
    after.status === 'manual_review'
  ) {
    // The registrar was reached (or we cannot tell): a blind retry could buy
    // the name twice.
    return { outcome: 'manual_review', detail }
  }
  return { outcome: 'retry', detail }
}

async function provisionHostingForPayment(
  payment: PaymentRow,
  meta: Record<string, unknown>
): Promise<RunResult> {
  // Honour the customer's choice from checkout. Defaults to auto: someone
  // who has just paid expects their site to come up without a second step.
  const autoDeploy = meta.deployMode !== 'manual'

  let projectId =
    typeof meta.projectId === 'string' && meta.projectId ? meta.projectId : null

  if (projectId) {
    // A projectId in the metadata (from checkout, or written by an earlier
    // attempt) is only honoured when it is the payer's own project; otherwise
    // a crafted id would deploy into someone else's site.
    const existing = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, userId: true, serverId: true },
    })
    if (!existing) {
      return { outcome: 'failed', detail: `project ${projectId} from the payment no longer exists` }
    }
    if (existing.userId !== payment.userId) {
      return {
        outcome: 'failed',
        detail: `project ${projectId} does not belong to the payer; refused`,
      }
    }
    if (autoDeploy && !existing.serverId) {
      const server = await selectHostingServer()
      if (!server) return { outcome: 'retry', detail: NO_SERVER_MESSAGE }
      await db.project.update({ where: { id: projectId }, data: { serverId: server.id } })
    }
  } else {
    const server = await selectHostingServer()
    if (autoDeploy && !server) {
      // Nothing created yet, so this is safely retryable once a server is up.
      return { outcome: 'retry', detail: NO_SERVER_MESSAGE }
    }
    const baseName =
      (typeof meta.projectName === 'string' && meta.projectName.trim()) ||
      (typeof meta.planName === 'string' && `${meta.planName} Project`) ||
      'My Project'
    const slug = slugify(baseName) + '-' + Date.now().toString(36)
    const project = await db.project.create({
      data: {
        userId: payment.userId,
        name: baseName,
        slug,
        framework: typeof meta.framework === 'string' ? meta.framework : 'nextjs',
        stack: frameworkToStack(meta.framework),
        status: autoDeploy ? 'creating' : 'stopped',
        subdomain: `${slug}.${BRAND_DOMAIN}`,
        serverId: server?.id || null,
        sslEnabled: true,
        autoDeploy,
      },
    })
    projectId = project.id
    // Recorded at once so a retry reuses this project instead of building a
    // second one for the same payment.
    await patchPaymentMeta(payment.id, { projectId })
  }

  // Manual: the purchase is fulfilled — the project and its subdomain exist —
  // but nothing is built until the owner presses Deploy.
  if (!autoDeploy) {
    return {
      outcome: 'provisioned',
      detail: `project ${projectId} created; awaiting a manual deploy`,
      projectId,
    }
  }

  // One deployment per payment. A retry after a crash finds the one already
  // queued rather than starting a second build.
  const commit = `paid-${payment.id}`
  const prior = await db.deployment.findFirst({
    where: { projectId, commit },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true },
  })
  if (prior) {
    if (prior.status === 'failed' || prior.status === 'cancelled') {
      // The container build was attempted; what it left on the server is
      // unknown, so a human decides whether to redeploy.
      return {
        outcome: 'manual_review',
        detail: `deployment ${prior.id} for project ${projectId} ${prior.status}; redeploy after checking the server`,
        projectId,
      }
    }
    return {
      outcome: 'provisioned',
      detail: `deployment ${prior.id} for project ${projectId} already ${prior.status}`,
      projectId,
    }
  }

  const deployment = await db.deployment.create({
    data: {
      projectId,
      userId: payment.userId,
      commit,
      branch: 'main',
      status: 'queued',
      triggeredBy: 'payment',
      buildLog: '🚀 Provisioning your paid hosting order…',
    },
  })

  // Fire-and-forget: the deploy takes minutes; the caller shouldn't wait. A
  // failure lands on the project/deployment and is surfaced by reconcile.
  const pid = projectId
  void deployProject({
    projectId: pid,
    deploymentId: deployment.id,
    onLog: (m) => console.log(`[provision-on-payment ${deployment.id.slice(0, 8)}] ${m}`),
  }).catch(async (err) => {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[provision-on-payment] deploy failed for ${deployment.id}:`, msg)
    await db.deployment
      .update({
        where: { id: deployment.id },
        data: { status: 'failed', buildLog: `❌ Deploy threw: ${msg}` },
      })
      .catch(() => {})
    await db.project.update({ where: { id: pid }, data: { status: 'error' } }).catch(() => {})
  })

  return { outcome: 'provisioned', detail: `deploying project ${projectId}`, projectId }
}
