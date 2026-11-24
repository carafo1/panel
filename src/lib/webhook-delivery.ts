import crypto from 'crypto'
import { db } from '@/lib/db'
import { assertPublicUrl, fetchPublicTarget, readTextCapped } from '@/lib/ssrf'

const WEBHOOK_TIMEOUT_MS = 5000
const MAX_RESPONSE_LENGTH = 2000

interface DeliverWebhookResult {
  id: string
  webhookId: string
  event: string
  payload: string
  response: string | null
  statusCode: number | null
  success: boolean
  duration: number | null
  createdAt: string
  skipped?: boolean
  skipReason?: string
  /**
   * The failure will not change on retry: the receiver answered 4xx (other
   * than 408/429) or the SSRF guard refused the URL.
   */
  permanent?: boolean
}

/** 4xx means the request itself is refused; 408 and 429 are worth retrying. */
function isPermanentStatus(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429
}

/**
 * Deliver a webhook event to the webhook's URL via HTTP POST.
 *
 * Steps:
 * 1. Fetch the webhook from the database
 * 2. Skip if webhook is not active
 * 3. Skip if webhook's events array doesn't include the triggered event
 * 4. Generate HMAC signature using the webhook's secret and JSON payload
 * 5. Make HTTP POST request with proper headers
 * 6. Record the delivery in the database
 * 7. Handle timeouts and network errors gracefully
 */
export async function deliverWebhook(
  webhookId: string,
  event: string,
  payload: unknown,
  /** A test send (the Test button) ignores the active flag and event filter. */
  opts: { test?: boolean } = {}
): Promise<DeliverWebhookResult> {
  // 1. Fetch the webhook
  const webhook = await db.webhook.findUnique({
    where: { id: webhookId },
  })

  if (!webhook) {
    return {
      id: '',
      webhookId,
      event,
      payload: JSON.stringify(payload),
      response: null,
      statusCode: null,
      success: false,
      duration: null,
      createdAt: new Date().toISOString(),
      skipped: true,
      skipReason: 'Webhook not found',
    }
  }

  // 2. Skip if not active
  if (!webhook.active && !opts.test) {
    return {
      id: '',
      webhookId,
      event,
      payload: JSON.stringify(payload),
      response: null,
      statusCode: null,
      success: false,
      duration: null,
      createdAt: new Date().toISOString(),
      skipped: true,
      skipReason: 'Webhook is inactive',
    }
  }

  // 3. Skip if event not in webhook's events list
  const webhookEvents: string[] = JSON.parse(webhook.events)
  if (!opts.test && !webhookEvents.includes(event) && !webhookEvents.includes('*')) {
    return {
      id: '',
      webhookId,
      event,
      payload: JSON.stringify(payload),
      response: null,
      statusCode: null,
      success: false,
      duration: null,
      createdAt: new Date().toISOString(),
      skipped: true,
      skipReason: `Event "${event}" not in webhook's event list`,
    }
  }

  // 4. Generate HMAC signature
  const payloadStr = JSON.stringify(payload)
  const deliveryId = crypto.randomUUID()
  const signature = crypto
    .createHmac('sha256', webhook.secret)
    .update(payloadStr)
    .digest('hex')

  // 5. Make the HTTP POST request
  const startTime = Date.now()
  let statusCode: number | null = null
  let success = false
  let responseBody: string | null = null
  let blockedUrl = false

  try {
    // SSRF guard: refuse to POST to private/loopback/metadata addresses.
    let target: Awaited<ReturnType<typeof assertPublicUrl>> | void
    try {
      target = await assertPublicUrl(webhook.url)
    } catch (guardErr) {
      // A refused URL stays refused; a DNS lookup failure may be temporary.
      const m = guardErr instanceof Error ? guardErr.message : ''
      blockedUrl = !/^(Cannot resolve host|Host did not resolve)/.test(m)
      throw guardErr
    }
    // Pinned to the address that passed the check, and redirects are not
    // followed: a 3xx is recorded as the receiver's answer. Following it let
    // a public URL bounce the signed POST (and its stored, displayed response)
    // to 127.0.0.1 or the cloud metadata service.
    const response = await fetchPublicTarget(target, webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Legacy DeployHub headers — kept for backward compatibility with
        // existing customer webhook receivers. Do NOT remove: doing so would
        // break signature verification on integrations customers already
        // deployed against the old header names. Both header sets carry the
        // same value, so receivers can migrate at their own pace.
        'X-DeployHub-Event': event,
        'X-DeployHub-Delivery': deliveryId,
        'X-DeployHub-Signature': `sha256=${signature}`,
        // New APSAMO headers — recommended for new integrations.
        'X-APSAMO-Event': event,
        'X-APSAMO-Delivery': deliveryId,
        'X-APSAMO-Signature': `sha256=${signature}`,
      },
      body: payloadStr,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })

    statusCode = response.status
    success = response.status >= 200 && response.status < 300

    try {
      // Read only what is stored; never buffer an unbounded receiver body.
      const { text, truncated } = await readTextCapped(response, MAX_RESPONSE_LENGTH * 4)
      responseBody =
        truncated || text.length > MAX_RESPONSE_LENGTH
          ? text.substring(0, MAX_RESPONSE_LENGTH) + '...[truncated]'
          : text
    } catch {
      responseBody = null
    }
  } catch (err) {
    success = false
    statusCode = null
    responseBody = err instanceof Error ? err.message : 'Connection failed'
  }

  const duration = Date.now() - startTime

  // 6. Record the delivery in the database
  const delivery = await db.webhookDelivery.create({
    data: {
      webhookId: webhook.id,
      event,
      payload: payloadStr,
      response: responseBody,
      statusCode,
      success,
      duration,
    },
  })

  // Update webhook's lastTriggeredAt
  await db.webhook.update({
    where: { id: webhook.id },
    data: { lastTriggeredAt: new Date() },
  })

  return {
    id: delivery.id,
    webhookId: delivery.webhookId,
    event: delivery.event,
    payload: delivery.payload,
    response: delivery.response,
    statusCode: delivery.statusCode,
    success: delivery.success,
    duration: delivery.duration,
    createdAt: delivery.createdAt.toISOString(),
    permanent: !delivery.success && (blockedUrl || isPermanentStatus(delivery.statusCode)),
  }
}

/**
 * Trigger a webhook event for all matching webhooks belonging to a user.
 * Finds all active webhooks for the user that listen for the given event
 * and delivers to each one.
 */
export async function triggerWebhookEvent(
  userId: string,
  event: string,
  payload: unknown,
  projectId?: string
): Promise<DeliverWebhookResult[]> {
  // Find all active webhooks for this user. A project event goes to that
  // project's webhooks AND to account-wide ones (projectId null) — filtering
  // on projectId alone silently skipped every account-wide webhook.
  const webhooks = await db.webhook.findMany({
    where: {
      userId,
      active: true,
      ...(projectId ? { OR: [{ projectId }, { projectId: null }] } : {}),
    },
  })

  // Filter to webhooks that listen for this event
  const matchingWebhooks = webhooks.filter((webhook) => {
    const events: string[] = JSON.parse(webhook.events)
    return events.includes(event) || events.includes('*')
  })

  // Deliver to each matching webhook sequentially
  const results: DeliverWebhookResult[] = []
  for (const webhook of matchingWebhooks) {
    const result = await deliverWebhook(webhook.id, event, payload)
    results.push(result)
  }

  return results
}

// ── Event emission with retries ──────────────────────────────────────────

/** Events the platform emits. Customers subscribe to these in Webhooks. */
export type PlatformEvent =
  | 'deployment.started'
  | 'deployment.success'
  | 'deployment.failed'
  | 'project.created'
  | 'project.deleted'
  | 'domain.registered'
  | 'domain.expiring'
  | 'ssl.renewed'
  | 'payment.success'
  | 'payment.failed'
  | 'monitor.down'
  | 'monitor.up'

/** Total delivery attempts: one immediate, then retries from the job queue. */
export const WEBHOOK_RETRY_ATTEMPTS = 5

/**
 * Tell a customer's integrations that something happened.
 *
 * Before this, nothing in the platform emitted any event: the only caller of
 * the delivery code was the manual "trigger" endpoint, so a webhook
 * subscribed to deployment.failed never fired. Now real code paths call this.
 *
 * Each matching webhook gets one immediate attempt. A failed delivery is
 * queued as a `deliver_webhook` job and retried with backoff (30s, 1m, 2m,
 * 4m, 8m) by the worker, so a receiver that is briefly down still gets it —
 * even across a panel restart.
 *
 * Never throws and never blocks on a slow receiver for long (5s timeout per
 * attempt): callers are deploys and payments, which must not fail because a
 * customer's endpoint did.
 */
export async function emitWebhookEvent(
  userId: string,
  event: PlatformEvent,
  data: Record<string, unknown>,
  opts: { projectId?: string | null } = {}
): Promise<void> {
  try {
    const webhooks = await db.webhook.findMany({
      where: {
        userId,
        active: true,
        ...(opts.projectId
          ? { OR: [{ projectId: opts.projectId }, { projectId: null }] }
          : {}),
      },
      select: { id: true, events: true },
    })
    const matching = webhooks.filter((w) => {
      try {
        const events = JSON.parse(w.events) as string[]
        return events.includes(event) || events.includes('*')
      } catch {
        return false
      }
    })
    if (matching.length === 0) return

    const body = {
      id: crypto.randomUUID(),
      event,
      createdAt: new Date().toISOString(),
      data,
    }

    await Promise.all(
      matching.map(async (w) => {
        const result = await deliverWebhook(w.id, event, body).catch(() => null)
        // A 4xx or a refused URL would fail the same way on every retry.
        if (result && (result.success || result.skipped || result.permanent)) return
        await db.jobQueue
          .create({
            data: {
              type: 'deliver_webhook',
              payload: JSON.stringify({ webhookId: w.id, event, body, userId }),
              status: 'queued',
              attempts: 0,
              maxAttempts: WEBHOOK_RETRY_ATTEMPTS,
              runAt: new Date(Date.now() + 30_000),
            },
          })
          .catch((err) => console.error('[webhooks] could not queue retry:', err))
      })
    )
  } catch (err) {
    console.error(`[webhooks] emitting ${event} failed:`, err)
  }
}
