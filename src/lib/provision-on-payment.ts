/**
 * Real provisioning on confirmed payment.
 *
 * Replaces the old simulated `processEvent('payment_success')` path (which
 * only flipped DB flags and sent "success" notifications without creating
 * anything). This dispatches to the REAL infrastructure:
 *
 *   - hosting        → create a Project + Deployment, run deployProject()
 *                      (real Docker container on a {slug}.BRAND_DOMAIN subdomain)
 *   - domain / both  → startProvisioning() (registers the real domain via
 *                      Dynadot, configures DNS, and — for "both" — hosting+email)
 *
 * IMPORTANT: domain registration spends real registrar balance and is
 * irreversible. This runs only AFTER a payment is confirmed (for offline
 * payments, that means a human already verified the money arrived).
 *
 * Idempotent: a `provisionStarted` flag on the payment metadata guarantees a
 * retried webhook or double-click can't double-provision.
 */
import { db } from '@/lib/db'
import { deployProject } from '@/lib/vps'
import { startProvisioning } from '@/lib/orchestration'
import { fulfilDomainOrder } from '@/lib/domain-checkout'
import { slugify } from '@/lib/utils'
import { BRAND_DOMAIN } from '@/lib/brand-config'
import { provisionEmailService, syncMailcowLimits } from '@/lib/email-hosting'

export interface ProvisionResult {
  provisioned: boolean
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

export async function provisionForPayment(
  paymentId: string
): Promise<ProvisionResult> {
  const payment = await db.payment.findUnique({ where: { id: paymentId } })
  if (!payment) return { provisioned: false, detail: 'payment not found' }

  let meta: Record<string, unknown> = {}
  try {
    meta = payment.metadata ? JSON.parse(payment.metadata) : {}
  } catch {
    meta = {}
  }

  // Idempotency guard — never provision the same payment twice.
  if (meta.provisionStarted) {
    return { provisioned: false, detail: 'provisioning already started' }
  }

  const purchaseType = String(meta.purchaseType || payment.type || 'hosting')
  const domainName =
    typeof meta.domainName === 'string' && meta.domainName.trim()
      ? meta.domainName.toLowerCase().trim()
      : null

  // Mark started up-front so a concurrent call bails at the guard above.
  await db.payment.update({
    where: { id: payment.id },
    data: {
      metadata: JSON.stringify({
        ...meta,
        provisionStarted: true,
        provisionStartedAt: new Date().toISOString(),
      }),
    },
  })

  try {
    // ── DOMAIN ORDER → checkout fulfilment ──────────────────────────
    // A domainOrderId means the purchase came through /api/domains/checkout,
    // which already raised the order and invoice and priced the job. Hand off
    // to the fulfilment path so register/renew/transfer all settle the same
    // way, whichever gateway confirmed the money.
    const domainOrderId =
      typeof meta.domainOrderId === 'string' && meta.domainOrderId
        ? meta.domainOrderId
        : null

    if (domainOrderId) {
      const result = await fulfilDomainOrder(domainOrderId, {
        paymentId: payment.id,
        gateway: payment.method || 'stripe',
      })
      return {
        provisioned: result.success,
        detail: result.success
          ? result.alreadyFulfilled
            ? `domain order ${domainOrderId} already fulfilled`
            : `domain order ${domainOrderId} fulfilled`
          : `domain order ${domainOrderId} failed: ${result.error || 'unknown'}`,
      }
    }

    // ── DOMAIN or BOTH → real domain registration pipeline ──────────
    if ((purchaseType === 'domain' || purchaseType === 'both') && domainName) {
      const result = await startProvisioning({
        userId: payment.userId,
        domainName,
        stack: frameworkToStack(meta.framework),
        includeHosting: purchaseType === 'both',
        includeEmail: purchaseType === 'both',
        planId: typeof meta.planId === 'string' ? meta.planId : undefined,
      })
      return {
        provisioned: result.status === 'started',
        detail:
          result.status === 'started'
            ? `provisioning job ${result.jobId}`
            : `provisioning failed: ${result.error || 'unknown'}`,
        jobId: result.jobId || undefined,
      }
    }

    // ── HOSTING → real container on a subdomain ─────────────────────
    if (purchaseType === 'hosting') {
      // Reuse a Project created at checkout if present, else create one
      // (mirrors the minimal shape the checkout flow uses).
      let projectId =
        typeof meta.projectId === 'string' && meta.projectId ? meta.projectId : null

      // Honour the customer's choice from checkout. Defaults to auto: someone
      // who has just paid expects their site to come up without a second step.
      const autoDeploy = meta.deployMode !== 'manual'

      if (!projectId) {
        const baseName =
          (typeof meta.projectName === 'string' && meta.projectName.trim()) ||
          (typeof meta.planName === 'string' && `${meta.planName} Project`) ||
          'My Project'
        const slug = slugify(baseName) + '-' + Date.now().toString(36)
        const server = await db.server.findFirst({
          where: { status: 'active' },
          orderBy: { usedRamGB: 'asc' },
        })
        const project = await db.project.create({
          data: {
            userId: payment.userId,
            name: baseName,
            slug,
            framework:
              typeof meta.framework === 'string' ? meta.framework : 'nextjs',
            stack: frameworkToStack(meta.framework),
            status: autoDeploy ? 'creating' : 'stopped',
            subdomain: `${slug}.${BRAND_DOMAIN}`,
            serverId: server?.id || null,
            sslEnabled: true,
            autoDeploy,
          },
        })
        projectId = project.id
      }

      // Manual: the purchase is fulfilled — the project and its subdomain
      // exist — but nothing is built until the owner presses Deploy. No
      // Deployment row, so the UI does not show a build that will never run.
      if (!autoDeploy) {
        return {
          provisioned: true,
          detail: `project ${projectId} created; awaiting a manual deploy`,
          projectId,
        }
      }

      const deployment = await db.deployment.create({
        data: {
          projectId,
          userId: payment.userId,
          commit: `paid-${Date.now()}`,
          branch: 'main',
          status: 'queued',
          triggeredBy: 'payment',
          buildLog: '🚀 Provisioning your paid hosting order…',
        },
      })

      // Fire-and-forget: the deploy takes minutes; the caller shouldn't wait.
      void deployProject({
        projectId,
        deploymentId: deployment.id,
        onLog: (m) =>
          console.log(
            `[provision-on-payment ${deployment.id.slice(0, 8)}] ${m}`
          ),
      }).catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(
          `[provision-on-payment] deploy failed for ${deployment.id}:`,
          msg
        )
        await db.deployment
          .update({
            where: { id: deployment.id },
            data: { status: 'failed', buildLog: `❌ Deploy threw: ${msg}` },
          })
          .catch(() => {})
        await db.project
          .update({ where: { id: projectId! }, data: { status: 'error' } })
          .catch(() => {})
      })

      return {
        provisioned: true,
        detail: `deploying project ${projectId}`,
        projectId,
      }
    }

    // ── EMAIL HOSTING → mail domain on Mailcow, no website ──────────
    // A standalone email purchase: the customer bought mailboxes on a domain
    // they already control, so there is no container and no project to build.
    if (purchaseType === 'email') {
      if (!domainName) {
        return { provisioned: false, detail: 'email purchase has no domain' }
      }
      const planId = typeof meta.planId === 'string' ? meta.planId : ''
      if (!planId) {
        return { provisioned: false, detail: 'email purchase has no plan' }
      }
      const subscriptionId =
        typeof meta.subscriptionId === 'string' ? meta.subscriptionId : null

      const res = await provisionEmailService({
        userId: payment.userId,
        planId,
        domain: domainName,
        subscriptionId,
      })
      if (!res.success) {
        return {
          provisioned: false,
          detail: `email provisioning failed: ${res.error || 'unknown error'}`,
        }
      }
      return {
        provisioned: true,
        detail: `email hosting ready for ${domainName}`,
      }
    }

    // ── EMAIL ADD-ONS → raise an existing service's allowance ───────
    // Ordering add-ons does not grant them; they are applied here, after the
    // money is confirmed, and pushed to Mailcow so the ceiling is real.
    if (purchaseType === 'email-addon') {
      const serviceId =
        typeof meta.emailServiceId === 'string' ? meta.emailServiceId : ''
      if (!serviceId) {
        return { provisioned: false, detail: 'add-on purchase has no service' }
      }
      const addMailboxes = Number(meta.addMailboxes) || 0
      const addStorageGB = Number(meta.addStorageGB) || 0
      if (addMailboxes <= 0 && addStorageGB <= 0) {
        return { provisioned: false, detail: 'add-on purchase has no quantity' }
      }

      const service = await db.emailService.findUnique({ where: { id: serviceId } })
      if (!service) {
        return { provisioned: false, detail: `email service ${serviceId} not found` }
      }
      if (service.userId !== payment.userId) {
        return { provisioned: false, detail: 'add-on does not belong to the payer' }
      }

      const updated = await db.emailService.update({
        where: { id: serviceId },
        data: {
          extraMailboxes: { increment: addMailboxes },
          extraStorageGB: { increment: addStorageGB },
        },
      })
      const sync = await syncMailcowLimits(updated)
      if (!sync.success) {
        return {
          provisioned: false,
          detail: `add-ons recorded but the mail server rejected the new limits: ${sync.error}`,
        }
      }
      return {
        provisioned: true,
        detail: `added ${addMailboxes} mailbox(es) and ${addStorageGB} GB to ${service.domain}`,
      }
    }

    return {
      provisioned: false,
      detail: `no provisioning defined for purchase type "${purchaseType}"`,
    }
  } catch (err) {
    // Roll back the started flag so this can be retried (e.g. from the admin
    // payments view) rather than being stuck forever.
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[provision-on-payment] failed:', msg)
    try {
      await db.payment.update({
        where: { id: payment.id },
        data: {
          metadata: JSON.stringify({
            ...meta,
            provisionStarted: false,
            provisionError: msg,
            provisionErrorAt: new Date().toISOString(),
          }),
        },
      })
    } catch {
      /* ignore */
    }
    return { provisioned: false, detail: msg }
  }
}
