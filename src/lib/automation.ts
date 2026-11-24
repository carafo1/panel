import { db } from '@/lib/db'

/**
 * A job failure that retrying cannot fix (unknown job type, a record that no
 * longer exists, a webhook receiver answering 4xx, an unparsable payload).
 * processJob marks the job failed at once instead of spending its retries.
 */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentJobError'
  }
}

/** Legacy simulated actions that may still sit in the queue but must never run. */
export const RETIRED_ACTIONS = [
  'create_user_workspace',
  'enable_ssl',
  'deploy_template',
  'register_domain',
  'setup_dns',
  'link_domain',
  'rollback_deployment',
] as const

function retiredActionMessage(type: string): string {
  return `Retired simulated action "${type}" refused: it produced fabricated results and no longer runs`
}

export type EventType =
  | 'payment_success'
  | 'subscription_cancelled'
  | 'payment_failed'
  | 'hosting_requested'
  | 'domain_requested'
  | 'deployment_triggered'

export type ActionType =
  | 'create_user_workspace'
  | 'assign_server'
  | 'enable_ssl'
  | 'deploy_template'
  | 'register_domain'
  | 'setup_dns'
  | 'link_domain'
  | 'rollback_deployment'
  | 'deployment_status_check'
  // Retry of an outbound webhook delivery that failed (see emitWebhookEvent).
  | 'deliver_webhook'
  // Legacy: no longer produced, but already-queued jobs may still carry it
  // and executeAction still handles it as a no-op.
  | 'create_coolify_project'

export interface AutomationEvent {
  type: EventType
  userId: string
  payload: Record<string, unknown>
}

interface ActionDef {
  type: ActionType
  label: string
}

// Maps event types to the actions they trigger
function getActionsForEvent(event: AutomationEvent): ActionDef[] {
  const { type, payload } = event
  const purchaseType = (payload.purchaseType as string) || 'hosting'

  switch (type) {
    case 'payment_success':
      if (purchaseType === 'hosting') {
        return [
          { type: 'create_user_workspace', label: 'Create User Workspace' },
          { type: 'assign_server', label: 'Assign Server' },
          { type: 'enable_ssl', label: 'Enable SSL' },
          { type: 'deploy_template', label: 'Deploy Template' },
        ]
      } else if (purchaseType === 'domain') {
        return [
          { type: 'register_domain', label: 'Register Domain' },
          { type: 'setup_dns', label: 'Setup DNS Records' },
        ]
      } else {
        // both
        return [
          { type: 'create_user_workspace', label: 'Create User Workspace' },
          { type: 'assign_server', label: 'Assign Server' },
          { type: 'enable_ssl', label: 'Enable SSL' },
          { type: 'deploy_template', label: 'Deploy Template' },
          { type: 'register_domain', label: 'Register Domain' },
          { type: 'setup_dns', label: 'Setup DNS Records' },
          { type: 'link_domain', label: 'Link Domain to Project' },
        ]
      }

    case 'domain_requested':
      return [
        { type: 'register_domain', label: 'Register Domain' },
        { type: 'setup_dns', label: 'Setup DNS Records' },
      ]

    case 'hosting_requested':
      return [
        { type: 'assign_server', label: 'Assign Server' },
        { type: 'enable_ssl', label: 'Enable SSL' },
        { type: 'deploy_template', label: 'Deploy Template' },
      ]

    case 'deployment_triggered':
      return [
        { type: 'deploy_template', label: 'Deploy Template' },
      ]

    case 'subscription_cancelled':
      return []

    case 'payment_failed':
      return []

    default:
      return []
  }
}

// Create a job in the JobQueue
export async function createJob(type: string, payload: Record<string, unknown>) {
  const job = await db.jobQueue.create({
    data: {
      type,
      payload: JSON.stringify(payload),
      status: 'queued',
      attempts: 0,
      maxAttempts: 3,
      runAt: new Date(),
    },
  })
  return job
}

// Execute an automation action and produce real results
async function executeAction(
  action: ActionDef,
  event: AutomationEvent
): Promise<Record<string, unknown>> {
  const { payload } = event
  const purchaseType = (payload.purchaseType as string) || 'hosting'

  switch (action.type) {
    case 'deliver_webhook': {
      // Throwing hands the job back to the queue, which retries with backoff
      // until maxAttempts; a skipped delivery (webhook deleted, disabled or
      // unsubscribed since) is final and counts as done.
      const { deliverWebhook } = await import('@/lib/webhook-delivery')
      const webhookId = String(payload.webhookId || '')
      const hookEvent = String(payload.event || '')
      const r = await deliverWebhook(webhookId, hookEvent, payload.body)
      if (!r.success && !r.skipped) {
        const reason = `delivery failed: ${r.statusCode ? `HTTP ${r.statusCode}` : 'no response'}`
        // A 4xx (other than 408/429) or a URL the SSRF guard refuses will
        // answer the same way on every retry.
        if (r.permanent) throw new PermanentJobError(`${reason} (not retried)`)
        throw new Error(reason)
      }
      return { delivered: r.success, skipped: r.skipped ?? false, statusCode: r.statusCode }
    }

    // ── Retired simulated actions ────────────────────────────────────────
    // These used to FABRICATE results: workspace/cert/deployment/domain ids
    // made from Date.now(), projects marked running and domains marked active
    // with an invented one-year expiry, DNS rows written only to our database,
    // domains linked to projects without verification, and success
    // notifications for all of it. Real work goes through provision-on-payment,
    // orchestration and domain-checkout. A leftover queued job now fails
    // permanently: no retry, no notification, nothing written.
    case 'create_user_workspace':
    case 'enable_ssl':
    case 'deploy_template':
    case 'setup_dns':
    case 'link_domain':
    case 'rollback_deployment':
      throw new PermanentJobError(retiredActionMessage(action.type))

    case 'register_domain': {
      // A customer-owned ('custom') domain is not registered by us at all; it
      // stays pending until DNS verification, so there is nothing to refuse.
      const domainId = payload.domainId as string | undefined
      const existing = domainId
        ? await db.domain.findUnique({ where: { id: domainId }, select: { provider: true } })
        : null
      if (payload.provider === 'custom' || existing?.provider === 'custom') {
        return { domainId: domainId ?? null, status: 'skipped', reason: 'custom_domain_awaits_verification' }
      }
      throw new PermanentJobError(retiredActionMessage(action.type))
    }

    case 'create_coolify_project': {
      // Legacy action retained for backward compatibility with already-queued
      // jobs. No-op now that the Coolify integration has been removed.
      return { status: 'skipped', reason: 'coolify_integration_removed' }
    }

    case 'assign_server': {
      // Find the server with the fewest projects
      const servers = await db.server.findMany({
        where: { status: 'active' },
        include: { _count: { select: { projects: true } } },
        orderBy: { usedRamGB: 'asc' },
      })
      const server = servers[0]
      if (server) {
        const projectId = payload.projectId as string | undefined
        if (projectId) {
          await db.project.update({
            where: { id: projectId },
            data: { serverId: server.id },
          })
        }
        return { serverId: server.id, serverIp: server.ip, status: 'assigned' }
      }
      // Used to be logged as a completed job, hiding that the customer got
      // no server. An operator has to add capacity, so retrying is pointless.
      throw new PermanentJobError('No active server available to assign')
    }

    case 'deployment_status_check': {
      // Retired. Nothing enqueues this job any more: deployProject() records the
      // real outcome itself and deploy-guard reaps deployments that die mid-run.
      // The old poller could mark a fresh redeploy 'live' from the previous
      // container, or 'failed' on a not_found before the new one existed, so a
      // leftover queued job now completes as a no-op and touches nothing.
      return { status: 'skipped', reason: 'deployment_status_check_retired' }
    }

    default:
      // Was returned as a result and the job marked completed.
      throw new PermanentJobError(`Unknown job type: ${String(action.type)}`)
  }
}

// Process a single job from the job queue
export async function processJob(
  jobId: string,
  opts: {
    /**
     * Refuse to claim a job whose attempts are used up. The queue worker sets
     * this so a job that keeps crashing the process cannot run forever. The
     * admin "retry" route leaves it off: it re-runs a failed job on purpose.
     */
    enforceMaxAttempts?: boolean
  } = {}
) {
  // Claim atomically: only a job that is still queued and due can be taken.
  // Reading it and then marking it processing let two overlapping ticks both
  // run the same job (a domain registered twice, a deploy started twice).
  const claimed = await db.jobQueue.updateMany({
    where: {
      id: jobId,
      status: 'queued',
      runAt: { lte: new Date() },
      ...(opts.enforceMaxAttempts ? { attempts: { lt: db.jobQueue.fields.maxAttempts } } : {}),
    },
    data: { status: 'processing', startedAt: new Date(), attempts: { increment: 1 } },
  })
  if (claimed.count === 0) return

  // Re-read AFTER the increment: deciding on retries from the old count let
  // a job stay 'queued' forever once it reached maxAttempts.
  const job = await db.jobQueue.findUnique({ where: { id: jobId } })
  if (!job) return

  // Every write below is fenced on this claim (still 'processing', same
  // attempt number). If stuck-job recovery reset the row and another tick
  // re-claimed it, this run must not overwrite that run's outcome.
  const ourClaim = { id: jobId, status: 'processing', attempts: job.attempts }

  let result: Record<string, unknown>
  try {
    let payload: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(job.payload)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      payload = parsed as Record<string, unknown>
    } catch {
      throw new PermanentJobError('Job payload is not a valid JSON object')
    }

    result = await executeAction(
      { type: job.type as ActionType, label: job.type },
      {
        type: (payload.eventType as EventType) || 'payment_success',
        userId: (payload.userId as string) || '',
        payload,
      }
    )
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const permanent = error instanceof PermanentJobError
    const shouldRetry = !permanent && job.attempts < job.maxAttempts
    // Back off 30s, 60s, 120s… instead of retrying on every 10-second tick.
    const backoffMs = 30_000 * 2 ** Math.max(0, job.attempts - 1)

    // If this write itself fails (database down) it throws to the caller and
    // the row stays 'processing'; stuck-job recovery picks it up later.
    await db.jobQueue.updateMany({
      where: ourClaim,
      data: {
        status: shouldRetry ? 'queued' : 'failed',
        error: errorMessage,
        ...(shouldRetry
          ? { startedAt: null, runAt: new Date(Date.now() + backoffMs) }
          : { completedAt: new Date() }),
      },
    })
    return
  }

  // Outside the handler's try on purpose: a database error while recording
  // success used to be caught as a handler failure, re-queueing (and so
  // re-running) a handler that had already done its work. It now throws to
  // the caller and the row is left for stuck-job recovery.
  //
  // A handler that RETURNS { status: 'failed' } (rather than throwing) is
  // recorded as failed, not completed. Final, like any returned result.
  const returnedFailed = result && typeof result === 'object' && result.status === 'failed'
  await db.jobQueue.updateMany({
    where: ourClaim,
    data: {
      status: returnedFailed ? 'failed' : 'completed',
      completedAt: new Date(),
      result: JSON.stringify(result),
      ...(returnedFailed
        ? { error: String(result.error || result.message || 'Action returned failed status') }
        : {}),
    },
  })
}

// Main entry point - processes an automation event
export async function processEvent(event: AutomationEvent) {
  const actions = getActionsForEvent(event)

  if (actions.length === 0) {
    // Log the event even if no actions are needed
    await db.automationLog.create({
      data: {
        userId: event.userId,
        eventType: event.type,
        action: 'no_action',
        status: 'completed',
        input: JSON.stringify(event.payload),
        output: JSON.stringify({ message: 'No actions required for this event' }),
      },
    })
    return { processed: true, actionsCount: 0, results: [] }
  }

  const results: Array<Record<string, unknown>> = []

  for (const action of actions) {
    // Create AutomationLog entry
    const log = await db.automationLog.create({
      data: {
        userId: event.userId,
        projectId: (event.payload.projectId as string) || null,
        domainId: (event.payload.domainId as string) || null,
        eventType: event.type,
        action: action.type,
        status: 'running',
        input: JSON.stringify(event.payload),
      },
    })

    // Execute the action directly (instant, no queuing)
    try {
      const result = await executeAction(action, event)

      // Update the AutomationLog to completed
      await db.automationLog.update({
        where: { id: log.id },
        data: {
          status: 'completed',
          output: JSON.stringify(result),
        },
      })

      results.push({ action: action.type, label: action.label, status: 'completed', result })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await db.automationLog.update({
        where: { id: log.id },
        data: { status: 'failed', error: errorMessage },
      })
      results.push({ action: action.type, label: action.label, status: 'failed', error: errorMessage })
    }
  }

  return { processed: true, actionsCount: actions.length, results }
}
