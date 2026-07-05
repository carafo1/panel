import crypto from 'crypto'
import { db } from '@/lib/db'
import { assertPublicUrl } from '@/lib/ssrf'

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
  payload: unknown
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
  if (!webhook.active) {
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
  if (!webhookEvents.includes(event) && !webhookEvents.includes('*')) {
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

  try {
    // SSRF guard: refuse to POST to private/loopback/metadata addresses.
    await assertPublicUrl(webhook.url)
    const response = await fetch(webhook.url, {
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
      const text = await response.text()
      responseBody =
        text.length > MAX_RESPONSE_LENGTH
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
  // Find all active webhooks for this user
  const webhooks = await db.webhook.findMany({
    where: {
      userId,
      active: true,
      ...(projectId ? { projectId } : {}),
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
