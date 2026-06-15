import { db } from '@/lib/db'

export type EventType =
  | 'payment_success'
  | 'subscription_cancelled'
  | 'payment_failed'
  | 'hosting_requested'
  | 'domain_requested'
  | 'deployment_triggered'

export type ActionType =
  | 'create_user_workspace'
  | 'create_coolify_project'
  | 'assign_server'
  | 'enable_ssl'
  | 'deploy_template'
  | 'register_domain'
  | 'setup_dns'
  | 'link_domain'
  | 'rollback_deployment'

export interface AutomationEvent {
  type: EventType
  userId: string
  payload: Record<string, unknown>
}

interface ActionDef {
  type: ActionType
  label: string
  simulateDelay?: number
}

// Maps event types to the actions they trigger
function getActionsForEvent(event: AutomationEvent): ActionDef[] {
  const { type, payload } = event
  const purchaseType = (payload.purchaseType as string) || 'hosting' // hosting, domain, both

  switch (type) {
    case 'payment_success':
      if (purchaseType === 'hosting') {
        return [
          { type: 'create_user_workspace', label: 'Create User Workspace' },
          { type: 'create_coolify_project', label: 'Create Coolify Project' },
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
          { type: 'create_coolify_project', label: 'Create Coolify Project' },
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
        { type: 'create_coolify_project', label: 'Create Coolify Project' },
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

// Process a single job
export async function processJob(jobId: string) {
  const job = await db.jobQueue.findUnique({ where: { id: jobId } })
  if (!job) return

  // Mark as processing
  await db.jobQueue.update({
    where: { id: jobId },
    data: { status: 'processing', startedAt: new Date(), attempts: { increment: 1 } },
  })

  try {
    const payload = JSON.parse(job.payload) as Record<string, unknown>

    // Simulate the actual work based on job type
    const result = await simulateJobAction(job.type, payload)

    await db.jobQueue.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        completedAt: new Date(),
        result: JSON.stringify(result),
      },
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    const shouldRetry = job.attempts < job.maxAttempts

    await db.jobQueue.update({
      where: { id: jobId },
      data: {
        status: shouldRetry ? 'queued' : 'failed',
        error: errorMessage,
        ...(shouldRetry ? { startedAt: null } : { completedAt: new Date() }),
      },
    })
  }
}

// Simulate job actions
async function simulateJobAction(
  type: string,
  _payload: Record<string, unknown>
): Promise<Record<string, unknown>> {
  switch (type) {
    case 'create_user_workspace':
      return { workspaceId: `ws-${Date.now()}`, status: 'created' }

    case 'create_coolify_project':
      return { coolifyProjectId: `cp-${Date.now()}`, status: 'created' }

    case 'assign_server': {
      // Find the least loaded server
      const server = await db.server.findFirst({
        where: { status: 'active' },
        orderBy: { usedRamGB: 'asc' },
      })
      if (server) {
        return { serverId: server.id, serverIp: server.ip, status: 'assigned' }
      }
      return { serverId: null, status: 'no_server_available' }
    }

    case 'enable_ssl':
      return { sslEnabled: true, certificateArn: `cert-${Date.now()}`, status: 'enabled' }

    case 'deploy_template':
      return { deploymentId: `dep-${Date.now()}`, status: 'deployed', url: `https://app-${Date.now()}.deployhub.io` }

    case 'register_domain':
      return { domainId: `dom-${Date.now()}`, status: 'registered', registrar: 'openprovider' }

    case 'setup_dns':
      return { dnsConfigured: true, recordsCreated: 2, status: 'configured' }

    case 'link_domain':
      return { domainLinked: true, status: 'linked' }

    case 'rollback_deployment':
      return { rolledBack: true, previousVersion: `v-${Date.now() - 1000}`, status: 'rolled_back' }

    default:
      return { status: 'unknown_action' }
  }
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
    return { processed: true, actionsCount: 0 }
  }

  const results = []

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

    // Create JobQueue entry
    const job = await createJob(action.type, {
      ...event.payload,
      automationLogId: log.id,
    })

    // Process the job
    try {
      await processJob(job.id)

      // Update the AutomationLog to completed
      const completedJob = await db.jobQueue.findUnique({ where: { id: job.id } })
      await db.automationLog.update({
        where: { id: log.id },
        data: {
          status: completedJob?.status === 'completed' ? 'completed' : 'failed',
          output: completedJob?.result || null,
          error: completedJob?.error || null,
        },
      })

      results.push({ action: action.type, status: 'completed', jobId: job.id })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      await db.automationLog.update({
        where: { id: log.id },
        data: { status: 'failed', error: errorMessage },
      })
      results.push({ action: action.type, status: 'failed', error: errorMessage, jobId: job.id })
    }
  }

  return { processed: true, actionsCount: actions.length, results }
}
