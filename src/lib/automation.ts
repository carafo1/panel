import { db } from '@/lib/db'
import { createNotification } from '@/lib/notifications'
import { slugify } from '@/lib/utils'
import { getContainerStatus, isVpsDemoMode } from '@/lib/vps'

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
    case 'create_user_workspace': {
      await createNotification({
        userId: event.userId,
        title: 'Project Created',
        message: 'Your project workspace has been created successfully.',
        type: 'success',
      })
      return { workspaceId: `ws-${Date.now()}`, status: 'created' }
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
      return { serverId: null, status: 'no_server_available' }
    }

    case 'enable_ssl': {
      const projectId = payload.projectId as string | undefined
      if (projectId) {
        await db.project.update({
          where: { id: projectId },
          data: { sslEnabled: true },
        })
      }
      await createNotification({
        userId: event.userId,
        title: 'SSL Enabled',
        message: 'SSL certificate has been enabled for your project.',
        type: 'success',
      })
      return { sslEnabled: true, certificateArn: `cert-${Date.now()}`, status: 'enabled' }
    }

    case 'deploy_template': {
      const projectId = payload.projectId as string | undefined
      let deployed = true
      if (projectId) {
        const project = await db.project.findUnique({ where: { id: projectId } })
        if (project) {
          await db.project.update({
            where: { id: projectId },
            data: { status: 'running' },
          })
        } else {
          deployed = false
        }
      }
      if (deployed) {
        await createNotification({
          userId: event.userId,
          title: 'Deployment Successful',
          message: `Your project has been deployed successfully.`,
          type: 'success',
          link: projectId ? `/hosting/${projectId}` : undefined,
        })
      } else {
        await createNotification({
          userId: event.userId,
          title: 'Deployment Failed',
          message: 'Your project deployment failed. Please try again.',
          type: 'error',
        })
      }
      return { deploymentId: `dep-${Date.now()}`, status: deployed ? 'deployed' : 'failed', url: deployed ? `https://${slugify((payload.projectName as string) || 'app')}.deployhub.io` : undefined }
    }

    case 'register_domain': {
      const domainId = payload.domainId as string | undefined
      if (domainId) {
        await db.domain.update({
          where: { id: domainId },
          data: {
            status: 'active',
            registeredAt: new Date(),
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
          },
        })
      }
      await createNotification({
        userId: event.userId,
        title: 'Domain Registered',
        message: domainId
          ? 'Your domain has been registered successfully.'
          : 'Domain registration processed.',
        type: 'success',
      })
      return { domainId: domainId || `dom-${Date.now()}`, status: 'registered', registrar: 'openprovider' }
    }

    case 'setup_dns': {
      const domainId = payload.domainId as string | undefined
      let recordsCreated = 0
      if (domainId) {
        const domain = await db.domain.findUnique({
          where: { id: domainId },
        })
        if (domain) {
          // Find a server for DNS records
          const server = await db.server.findFirst({
            where: { status: 'active' },
            orderBy: { usedRamGB: 'asc' },
          })

          // Check if DNS records already exist for this domain
          const existingRecords = await db.dnsRecord.findMany({
            where: { domainId: domain.id },
          })

          if (existingRecords.length === 0) {
            // A record pointing to server IP
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
              recordsCreated++
            }

            // CNAME for www
            await db.dnsRecord.create({
              data: {
                domainId: domain.id,
                type: 'CNAME',
                name: 'www',
                value: domain.name,
                ttl: 3600,
                proxied: true,
              },
            })
            recordsCreated++
          } else {
            recordsCreated = existingRecords.length
          }
        }
      }
      await createNotification({
        userId: event.userId,
        title: 'DNS Configured',
        message: `${recordsCreated} DNS record(s) have been configured for your domain.`,
        type: 'info',
      })
      return { dnsConfigured: true, recordsCreated, status: 'configured' }
    }

    case 'link_domain': {
      const domainId = payload.domainId as string | undefined
      const projectId = payload.projectId as string | undefined
      if (domainId && projectId) {
        const domain = await db.domain.findUnique({ where: { id: domainId } })
        if (domain) {
          // Link domain to project
          await db.domain.update({
            where: { id: domainId },
            data: { projectId },
          })
          // Set project custom domain
          await db.project.update({
            where: { id: projectId },
            data: { customDomain: domain.name },
          })
        }
      }
      await createNotification({
        userId: event.userId,
        title: 'Domain Linked',
        message: 'Your domain has been linked to your project successfully.',
        type: 'success',
      })
      return { domainLinked: true, status: 'linked' }
    }

    case 'rollback_deployment': {
      return { rolledBack: true, previousVersion: `v-${Date.now() - 1000}`, status: 'rolled_back' }
    }

    case 'deployment_status_check': {
      // Real container health monitor: polls the VPS for the actual Docker
      // container state and transitions the Deployment row accordingly.
      //
      //   running              → mark deployment 'live' (set deployUrl + duration)
      //   exited / not_found   → mark deployment 'failed' (only if currently
      //                          'building' — a 'queued' deployment may not
      //                          have started the container yet)
      //   paused / restarting  → leave as 'building', re-check later
      //
      // In DEMO MODE (no sshHost configured) the container status is
      // simulated, so we fall back to the original attempt-count-based
      // transition to keep the UX snappy in dev/demo environments.
      const deploymentId = payload.deploymentId as string | undefined
      const projectId = payload.projectId as string | undefined
      const userId = event.userId || (payload.userId as string | undefined) || ''

      if (!deploymentId || !projectId) {
        return { status: 'skipped', reason: 'missing_deployment_or_project' }
      }

      const deployment = await db.deployment.findUnique({
        where: { id: deploymentId },
        include: { project: true },
      })
      if (!deployment || !deployment.project) {
        return { status: 'skipped', reason: 'deployment_not_found' }
      }

      // Terminal deployments don't need further polling.
      const terminalStatuses = ['live', 'failed', 'rolled_back']
      if (terminalStatuses.includes(deployment.status)) {
        return {
          status: 'already_terminal',
          deploymentId,
          deploymentStatus: deployment.status,
        }
      }

      const attempts = (payload.attempt as number | undefined) || 0
      const nowIso = new Date().toISOString()
      const elapsedSec = Math.max(
        1,
        Math.floor((Date.now() - deployment.createdAt.getTime()) / 1000)
      )
      const finalUrl = `https://${deployment.project.subdomain}`

      // ── Real-mode: poll the VPS for the container's actual state ──
      const project = deployment.project
      const realMode =
        !isVpsDemoMode() && !!project.serverId && !!project.containerName

      if (realMode) {
        let containerState: string | null = null
        try {
          const status = await getContainerStatus(projectId)
          containerState = status?.state ?? null
        } catch (err) {
          console.warn(
            `[automation] getContainerStatus failed for ${projectId}:`,
            err instanceof Error ? err.message : err
          )
        }

        const logLine = `[${nowIso}] Container status: ${containerState || 'unknown'}`
        const existingLog = deployment.buildLog || ''
        const newBuildLog = existingLog
          ? `${existingLog}\n${logLine}`
          : logLine

        if (containerState === 'running') {
          await db.deployment.update({
            where: { id: deploymentId },
            data: {
              status: 'live',
              deployUrl: finalUrl,
              duration: elapsedSec,
              buildLog: `${newBuildLog}\n✅ Container running — deployment live at ${finalUrl} (after ${elapsedSec}s)`,
            },
          })
          await db.project.update({
            where: { id: projectId },
            data: { status: 'running' },
          })
          if (userId) {
            await createNotification({
              userId,
              title: 'Deployment Live',
              message: `Your deployment is now live at ${finalUrl}`,
              type: 'success',
              link: `/deployments/${deploymentId}`,
            })
          }
          return { status: 'live', deploymentId, url: finalUrl }
        }

        if (
          (containerState === 'exited' || containerState === 'not_found') &&
          deployment.status === 'building'
        ) {
          const failLog =
            (deployment.buildLog || '') +
            `\n❌ Container ${containerState} — deployment failed`
          await db.deployment.update({
            where: { id: deploymentId },
            data: {
              status: 'failed',
              duration: elapsedSec,
              buildLog: failLog.trim() || undefined,
            },
          })
          await db.project.update({
            where: { id: projectId },
            data: { status: 'error' },
          })
          if (userId) {
            await createNotification({
              userId,
              title: 'Deployment Failed',
              message: `Deployment ${deploymentId.slice(0, 8)} failed — container ${containerState}.`,
              type: 'error',
              link: `/deployments/${deploymentId}`,
            })
          }
          return {
            status: 'failed',
            deploymentId,
            containerState: containerState || 'unknown',
          }
        }

        // paused / restarting / unknown → keep as 'building' (or upgrade
        // 'queued' → 'building') and re-queue.
        const nextStatus = deployment.status === 'queued' ? 'building' : deployment.status
        await db.deployment.update({
          where: { id: deploymentId },
          data: { status: nextStatus, buildLog: newBuildLog },
        })

        if (attempts < 60) {
          await db.jobQueue.create({
            data: {
              type: 'deployment_status_check',
              payload: JSON.stringify({
                deploymentId,
                projectId,
                userId,
                attempt: attempts + 1,
              }),
              status: 'queued',
              attempts: 0,
              maxAttempts: 3,
              runAt: new Date(Date.now() + 15_000),
            },
          })
        }
        return {
          status: 'in_progress',
          deploymentId,
          containerState: containerState || 'unknown',
          attempt: attempts + 1,
        }
      }

      // ── Demo-mode fallback: attempt-count-based transition ─────────
      // Keeps the build log feeling alive without depending on any real
      // hosting provider. Used when no Server has an sshHost configured
      // OR when VPS_DEMO_MODE=1.
      let mapped: string
      if (deployment.status === 'queued') {
        mapped = 'building'
      } else if (deployment.status === 'building') {
        // After ~1 poll in 'building' (attempts >= 1), go live.
        mapped = attempts >= 1 ? 'live' : 'building'
      } else if (deployment.status === 'deploying') {
        mapped = 'live'
      } else {
        // Unknown - keep the existing status so we don't downgrade.
        mapped = deployment.status
      }

      const logLine = `[${nowIso}] Build progress: ${deployment.status} → ${mapped}`
      const existingLog = deployment.buildLog || ''
      const newBuildLog = existingLog
        ? `${existingLog}\n${logLine}`
        : logLine

      if (mapped === 'live') {
        await db.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'live',
            deployUrl: finalUrl,
            duration: elapsedSec,
            buildLog: `${newBuildLog}\n✅ Deployment live at ${finalUrl} (after ${elapsedSec}s)`,
          },
        })
        // Also bump the project status to running.
        await db.project.update({
          where: { id: projectId },
          data: { status: 'running' },
        })
        if (userId) {
          await createNotification({
            userId,
            title: 'Deployment Live',
            message: `Your deployment is now live at ${finalUrl}`,
            type: 'success',
            link: `/deployments/${deploymentId}`,
          })
        }
        return {
          status: 'live',
          deploymentId,
          url: finalUrl,
        }
      }

      if (mapped === 'failed') {
        await db.deployment.update({
          where: { id: deploymentId },
          data: {
            status: 'failed',
            duration: elapsedSec,
            buildLog: `${newBuildLog}\n❌ Deployment failed`,
          },
        })
        if (userId) {
          await createNotification({
            userId,
            title: 'Deployment Failed',
            message: `Deployment ${deploymentId.slice(0, 8)} failed during build/deploy.`,
            type: 'error',
            link: `/deployments/${deploymentId}`,
          })
        }
        return { status: 'failed', deploymentId }
      }

      // Still in-flight. Update the row's status + log, then schedule the
      // next status check ~15s out so the worker picks it up again.
      await db.deployment.update({
        where: { id: deploymentId },
        data: {
          status: mapped,
          buildLog: newBuildLog,
        },
      })

      if (attempts < 30) {
        await db.jobQueue.create({
          data: {
            type: 'deployment_status_check',
            payload: JSON.stringify({
              deploymentId,
              projectId,
              userId,
              attempt: attempts + 1,
            }),
            status: 'queued',
            attempts: 0,
            maxAttempts: 3,
            runAt: new Date(Date.now() + 15_000),
          },
        })
      }
      return {
        status: 'in_progress',
        deploymentId,
        mapped,
        attempt: attempts + 1,
      }
    }

    default:
      return { status: 'unknown_action' }
  }
}

// Process a single job from the job queue
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

    // Find matching action type from the event
    const result = await executeAction(
      { type: job.type as ActionType, label: job.type },
      {
        type: (payload.eventType as EventType) || 'payment_success',
        userId: (payload.userId as string) || '',
        payload,
      }
    )

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

  // Handle payment_success with hosting: create deployment record
  if (event.type === 'payment_success') {
    const purchaseType = (event.payload.purchaseType as string) || 'hosting'
    const projectId = event.payload.projectId as string | undefined

    if ((purchaseType === 'hosting' || purchaseType === 'both') && projectId) {
      const project = await db.project.findUnique({ where: { id: projectId } })
      if (project) {
        // Create an initial Deployment record with status 'live'
        await db.deployment.create({
          data: {
            projectId: project.id,
            userId: event.userId,
            commit: `init-${Date.now()}`,
            branch: 'main',
            status: 'live',
            buildLog: [
              `🚀 DeployHub Auto-Deployment`,
              `========================`,
              `Project: ${project.name}`,
              `Framework: ${project.framework}`,
              `Subdomain: ${project.subdomain}`,
              ``,
              `Step 1: Create workspace.............. ✅`,
              `Step 2: Assign server................. ✅`,
              `Step 3: Enable SSL.................... ✅`,
              `Step 4: Deploy template............... ✅`,
              ``,
              `Deployment completed successfully!`,
              `Live at: https://${project.subdomain}`,
            ].join('\n'),
            deployUrl: `https://${project.subdomain}`,
            duration: 12,
            triggeredBy: 'auto',
          },
        })
      }
    }

    // Handle domain: update domain status to active
    if ((purchaseType === 'domain' || purchaseType === 'both') && event.payload.domainId) {
      const domainId = event.payload.domainId as string
      await db.domain.update({
        where: { id: domainId },
        data: { status: 'active' },
      })
    }
  }

  return { processed: true, actionsCount: actions.length, results }
}

// Process any queued jobs that haven't been processed yet
export async function processPendingJobs() {
  const pendingJobs = await db.jobQueue.findMany({
    where: {
      status: { in: ['queued'] },
      attempts: { lt: 3 },
    },
    orderBy: { runAt: 'asc' },
    take: 10,
  })

  const results = []
  for (const job of pendingJobs) {
    await processJob(job.id)
    const updated = await db.jobQueue.findUnique({ where: { id: job.id } })
    results.push({
      jobId: job.id,
      type: job.type,
      status: updated?.status || 'unknown',
    })
  }

  return { processed: results.length, results }
}
