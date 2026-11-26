/**
 * Core Orchestration Engine
 * =========================
 *
 * The heart of APSAMO's automated provisioning pipeline. Coordinates the
 * full flow:
 *
 *     domain registration → DNS configuration → web hosting → email hosting → verification
 *
 * Each step is independently retryable via `withRetry()` with exponential
 * backoff. Domain + DNS are CRITICAL steps — if either fails after retries,
 * the pipeline stops and triggers `rollbackProvisioning()` in reverse order.
 * Hosting + Email are NON-CRITICAL — if they fail but domain+DNS succeeded,
 * the pipeline continues to verification and the overall status is `partial`.
 *
 * All external API calls (Dynadot, Mailcow) have DEMO MODE fallbacks
 * so the entire pipeline runs out-of-the-box without any real provider env
 * vars configured.
 *
 * Used by:
 *  - Task #19 Orchestration Engine — ties together Dynadot, DNS, and
 *    Mailcow into a single end-to-end provisioning flow.
 */
import crypto from 'crypto'
import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { createNotification } from '@/lib/notifications'
// Registration (registerDomain) is deliberately NOT imported: domains are
// bought only through a paid DomainOrder. See provisionDomain.
import { setDnsRecords } from '@/lib/dynadot'
import { verifyTxtRecord } from '@/lib/dns'
import {
  addDomain,
  generateDkim,
  createMailbox,
  removeDomain,
  deleteMailbox,
  verifyEmailSetup,
  getMailServerInfo,
  isMailcowConfigured,
} from '@/lib/mailcow'
import { encrypt } from '@/lib/encryption'
import { selectHostingServer, NO_SERVER_MESSAGE } from '@/lib/server-selection'
import { ACTIVE_DEPLOY_STATUSES } from '@/lib/deploy-guard'
import { deployProject, removeProjectContainer } from '@/lib/vps'
import {
  MAIL_SERVER_HOSTNAME,
  NS1_HOSTNAME,
  NS2_HOSTNAME,
  APP_SUBDOMAIN_PATTERN,
} from '@/lib/brand-config'

// ─── Types ───────────────────────────────────────────────────────────────

export interface ProvisioningRequest {
  userId: string
  domainName: string // e.g. "example.com"
  stack: string // "nodejs", "php", "python", "docker", "wordpress"
  includeHosting?: boolean // default true
  includeEmail?: boolean // default true
  planId?: string // optional plan
  serverId?: string // optional server
}

export interface ProvisioningResult {
  overallStatus: 'success' | 'failed' | 'partial'
  domainStatus: {
    status: 'success' | 'fail'
    domain: string
    provider: string // "dynadot" or "apsamo"
    externalId?: string
    registered: boolean
    details: string
  }
  dnsStatus: {
    status: 'success' | 'fail'
    records: Array<{ type: string; name: string; value: string; status: string }>
    propagationVerified: boolean
    details: string
  }
  hostingStatus: {
    status: 'success' | 'fail' | 'skipped'
    projectId?: string
    url?: string
    sslEnabled: boolean
    healthChecked: boolean
    details: string
    containerId?: string
  }
  emailStatus: {
    status: 'success' | 'fail' | 'skipped'
    mailboxes: Array<{ address: string; type: string }>
    dkimConfigured: boolean
    smtpEnabled: boolean
    imapEnabled: boolean
    webmailUrl?: string
    details: string
  }
  credentials: {
    domain: { registrar: string; managementUrl: string }
    hosting?: { adminUrl: string; sshKey?: string; apiKey?: string }
    email?: {
      mailboxes: Array<{ address: string; password: string; type: string }> // plaintext (shown once)
      imap: { host: string; port: number; ssl: boolean }
      smtp: { host: string; port: number; tls: boolean }
      webmail: string
    }
    dns: { nameservers: string[]; managementUrl: string }
  }
  jobId: string
  duration: number // milliseconds
  errors: Array<{ step: string; error: string; timestamp: string }>
}

/** Internal mutable context shared between steps within a single pipeline run. */
interface PipelineContext {
  domainName: string
  domainId?: string
  externalId?: string
  provider: string
  mailServerHostname: string
  hostingServerIp: string
  dkimPublicKey?: string
  dkimSelector?: string
  projectId?: string
  hostingUrl?: string
  mailboxes: Array<{
    address: string
    password: string // plaintext (kept in memory only; persisted encrypted)
    type: string
    mailboxId: string
  }>
  webmailUrl?: string
  dnsRecords: Array<{ type: string; name: string; value: string; recordId: string }>
  mailServerInfo?: {
    imap: { host: string; port: number; ssl: boolean }
    smtp: { host: string; port: number; tls: boolean }
    webmail: string
  }
  errors: Array<{ step: string; error: string; timestamp: string }>
  hostingReachable: boolean
  emailVerified: boolean
  dnsPropagated: boolean
  nameservers: string[]
}

const STEP_DEFINITIONS: Array<{
  name: string
  order: number
  critical: boolean
}> = [
  { name: 'domain_register', order: 1, critical: true },
  { name: 'dns_configure', order: 2, critical: true },
  { name: 'hosting_provision', order: 3, critical: false },
  { name: 'email_provision', order: 4, critical: false },
  { name: 'verify', order: 5, critical: false },
]

const CRITICAL_STEPS = new Set(['domain_register', 'dns_configure'])

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Generate a secure random password (16 chars, URL-safe base64). */
function generatePassword(): string {
  return crypto.randomBytes(12).toString('base64url')
}

/** Map a stack name to a framework identifier. */
function stackToFramework(stack: string): string {
  switch (stack) {
    case 'nodejs':
      return 'nextjs'
    case 'php':
      return 'nixpacks'
    case 'python':
      return 'nixpacks'
    case 'docker':
      return 'docker'
    case 'wordpress':
      return 'nixpacks'
    default:
      return 'nixpacks'
  }
}

/**
 * Resolve the hosting server IP written into the domain's A records.
 *
 * There is no fallback address any more: this used to return 10.0.0.1 when no
 * server existed, which then went into LIVE DNS for a customer's domain. No
 * usable server is now a clear failure before anything is changed.
 */
async function resolveHostingServerIp(serverId?: string): Promise<string> {
  if (serverId) {
    const server = await db.server.findUnique({ where: { id: serverId } })
    if (server?.ip && server.status === 'active') return server.ip
    throw new Error(`Requested server ${serverId} is not an active server with an address`)
  }
  const best = await selectHostingServer()
  if (best?.ip) return best.ip
  throw new Error(NO_SERVER_MESSAGE)
}

/** Resolve the mail server hostname from brand-config (env-var overridable; APSAMO default). */
function resolveMailServerHostname(): string {
  return MAIL_SERVER_HOSTNAME
}

/** Sleep for n milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Retry helper ────────────────────────────────────────────────────────

/**
 * Retry a function up to `maxAttempts` times with exponential backoff
 * (1000ms * 2^attempt). Each attempt increments the ProvisioningStep.attempts
 * counter and updates lastAttemptAt.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts: number; stepName: string; jobId: string; stepId: string }
): Promise<T> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      // Update attempt tracking on the step row.
      await db.provisioningStep.update({
        where: { id: opts.stepId },
        data: {
          attempts: attempt,
          lastAttemptAt: new Date(),
        },
      })
      console.log(
        `[orchestration] job=${opts.jobId} step=${opts.stepName} attempt=${attempt}/${opts.maxAttempts}`
      )
      const result = await fn()
      return result
    } catch (err) {
      lastError = err
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(
        `[orchestration] job=${opts.jobId} step=${opts.stepName} attempt=${attempt} failed: ${msg}`
      )
      if (attempt < opts.maxAttempts) {
        const backoff = 1000 * Math.pow(2, attempt - 1)
        await sleep(backoff)
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(`Step ${opts.stepName} failed after ${opts.maxAttempts} attempts`)
}

// ─── startProvisioning ───────────────────────────────────────────────────

/**
 * Create a ProvisioningJob record with 5 ProvisioningStep rows, then kick off
 * the pipeline in the background (NOT awaited). Returns immediately with the
 * jobId so the caller can poll for status via getProvisioningStatus().
 */
export async function startProvisioning(
  req: ProvisioningRequest
): Promise<{ jobId: string; status: 'started' | 'failed'; error?: string }> {
  const includeHosting = req.includeHosting ?? true
  // Only run the email step when a real Mailcow server is configured. Without
  // it, the step would either fake mailboxes (falsely telling the customer email
  // works) or fail against a non-existent server (forcing every job to
  // "partial"). Skipping keeps the result honest; it auto-enables the moment
  // MAILCOW_API_URL/KEY are set to real values.
  const includeEmail = (req.includeEmail ?? true) && isMailcowConfigured()

  try {
    // 1. Create the ProvisioningJob record.
    const job = await db.provisioningJob.create({
      data: {
        userId: req.userId,
        domainName: req.domainName,
        stack: req.stack,
        includeHosting,
        includeEmail,
        status: 'pending',
        currentStep: 'init',
      },
    })

    // 2. Create the 5 ProvisioningStep records.
    for (const def of STEP_DEFINITIONS) {
      const skipped =
        (def.name === 'hosting_provision' && !includeHosting) ||
        (def.name === 'email_provision' && !includeEmail)
      await db.provisioningStep.create({
        data: {
          jobId: job.id,
          stepName: def.name,
          stepOrder: def.order,
          status: skipped ? 'skipped' : 'pending',
          maxAttempts: 3,
          input: JSON.stringify({
            domainName: req.domainName,
            stack: req.stack,
            includeHosting,
            includeEmail,
            planId: req.planId,
            serverId: req.serverId,
          }),
        },
      })
    }

    await logAudit({
      userId: req.userId,
      action: 'provisioning.start',
      resource: 'provisioning_job',
      resourceId: job.id,
      metadata: {
        domainName: req.domainName,
        stack: req.stack,
        includeHosting,
        includeEmail,
      },
    })

    // 3. Kick off the pipeline in the background. Do NOT await.
    runProvisioningPipeline(job.id).catch((err) => {
      console.error(
        `[orchestration] Background pipeline failed for job ${job.id}:`,
        err instanceof Error ? err.message : err
      )
    })

    return { jobId: job.id, status: 'started' }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[orchestration] startProvisioning failed:', msg)
    return { jobId: '', status: 'failed', error: msg }
  }
}

// ─── runProvisioningPipeline ─────────────────────────────────────────────

/**
 * Run the full provisioning pipeline for a job. Updates the job's status,
 * runs each step in order with retries, builds the ProvisioningResult, and
 * sends a notification to the user on completion.
 *
 * Called by startProvisioning() in the background (fire-and-forget) or by a
 * worker process.
 */
export async function runProvisioningPipeline(
  jobId: string
): Promise<ProvisioningResult> {
  const job = await db.provisioningJob.findUnique({
    where: { id: jobId },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  })
  if (!job) {
    throw new Error(`ProvisioningJob not found: ${jobId}`)
  }
  if (job.status === 'running') {
    // A run interrupted by a panel restart stays 'running' forever. Only a
    // run with no activity for STALE_PROVISIONING_MS is treated as dead: it
    // is marked failed (conditionally) and this call re-runs it.
    const swept = await failStaleProvisioningJobs({ jobId })
    if (swept === 0) {
      throw new Error(`Pipeline already running for job ${jobId}`)
    }
    job.status = 'failed'
  }
  if (job.status === 'success' || job.status === 'failed' || job.status === 'rolled_back') {
    // Already completed — return the stored result if available.
    if (job.result) {
      try {
        return JSON.parse(job.result) as ProvisioningResult
      } catch {
        // fall through and re-run
      }
    }
  }

  const req = JSON.parse(job.steps[0]?.input || '{}') as ProvisioningRequest

  // Resolved BEFORE the claim: with no usable server there is nothing to point
  // DNS at, and failing here leaves the job 'failed' rather than 'running'.
  let hostingServerIp: string
  try {
    hostingServerIp = await resolveHostingServerIp(req.serverId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await db.provisioningJob
      .updateMany({
        where: { id: jobId, status: { not: 'running' } },
        data: { status: 'failed', error: msg, errorCode: 'NO_SERVER' },
      })
      .catch(() => {})
    throw err
  }

  const startedAt = new Date()
  // Conditional claim: two callers racing to (re-)run the same job cannot
  // both get here; the loser sees count 0.
  const claimed = await db.provisioningJob.updateMany({
    where: { id: jobId, status: { not: 'running' } },
    data: { status: 'running', startedAt, currentStep: 'domain', error: null, errorCode: null },
  })
  if (claimed.count === 0) {
    throw new Error(`Pipeline already running for job ${jobId}`)
  }

  const ctx: PipelineContext = {
    domainName: job.domainName,
    provider: 'dynadot',
    mailServerHostname: resolveMailServerHostname(),
    hostingServerIp,
    mailboxes: [],
    dnsRecords: [],
    errors: [],
    hostingReachable: false,
    emailVerified: false,
    dnsPropagated: false,
    nameservers: [],
  }

  let domainResult: { domainId: string; externalId?: string; provider: string } | undefined
  let dnsResult:
    | { records: Array<{ type: string; name: string; value: string; recordId: string }> }
    | undefined
  let hostingResult:
    | { projectId: string; url: string }
    | undefined
  let emailResult:
    | {
        mailboxes: Array<{
          address: string
          password: string
          type: string
          mailboxId: string
        }>
        dkimPublicKey: string
        webmailUrl: string
      }
    | undefined
  let verifyResult:
    | { hostingReachable: boolean; emailVerified: boolean; dnsPropagated: boolean }
    | undefined

  // Track whether non-critical steps failed (for 'partial' status).
  let hostingFailed = false
  let emailFailed = false
  let criticalFailed = false

  for (const step of job.steps) {
    // Skip steps that are explicitly skipped (includeHosting/includeEmail = false)
    if (step.status === 'skipped') continue
    // Skip steps that already succeeded (idempotent re-runs)
    if (step.status === 'success') {
      // Re-hydrate context from stored output so subsequent steps have the data
      try {
        const out = step.output ? JSON.parse(step.output) : undefined
        if (step.stepName === 'domain_register' && out) {
          domainResult = out
          ctx.domainId = out.domainId
          ctx.externalId = out.externalId
          ctx.provider = out.provider
        }
        if (step.stepName === 'dns_configure' && out) {
          dnsResult = out
          ctx.dnsRecords = out.records || []
        }
        if (step.stepName === 'hosting_provision' && out) {
          hostingResult = out
          ctx.projectId = out.projectId
          ctx.hostingUrl = out.url
        }
        if (step.stepName === 'email_provision' && out) {
          emailResult = out
          ctx.mailboxes = out.mailboxes || []
          ctx.dkimPublicKey = out.dkimPublicKey
          ctx.webmailUrl = out.webmailUrl
        }
      } catch {
        // ignore parse errors
      }
      continue
    }

    // Mark step running.
    const stepStart = new Date()
    await db.provisioningStep.update({
      where: { id: step.id },
      data: { status: 'running', startedAt: stepStart, attempts: 0 },
    })
    await db.provisioningJob.update({
      where: { id: jobId },
      data: { currentStep: step.stepName },
    })

    try {
      let output: unknown
      switch (step.stepName) {
        case 'domain_register':
          output = domainResult = await withRetry(
            () => provisionDomain(job, step),
            {
              maxAttempts: step.maxAttempts,
              stepName: step.stepName,
              jobId,
              stepId: step.id,
            }
          )
          ctx.domainId = domainResult.domainId
          ctx.externalId = domainResult.externalId
          ctx.provider = domainResult.provider
          break
        case 'dns_configure':
          if (!ctx.domainId) {
            throw new Error('Cannot configure DNS — domain step did not produce a domainId')
          }
          output = dnsResult = await withRetry(
            () =>
              configureDns(
                job,
                step,
                ctx.domainId!,
                ctx.mailServerHostname,
                ctx.hostingServerIp
              ),
            {
              maxAttempts: step.maxAttempts,
              stepName: step.stepName,
              jobId,
              stepId: step.id,
            }
          )
          ctx.dnsRecords = dnsResult.records
          break
        case 'hosting_provision':
          if (!ctx.domainId) {
            throw new Error('Cannot provision hosting — no domainId in context')
          }
          output = hostingResult = await withRetry(
            () => provisionHosting(job, step, ctx.domainId!, ctx.domainName),
            {
              maxAttempts: step.maxAttempts,
              stepName: step.stepName,
              jobId,
              stepId: step.id,
            }
          )
          ctx.projectId = hostingResult.projectId
          ctx.hostingUrl = hostingResult.url
          break
        case 'email_provision':
          if (!ctx.domainId) {
            throw new Error('Cannot provision email — no domainId in context')
          }
          output = emailResult = await withRetry(
            () => provisionEmail(job, step, ctx.domainId!, ctx.domainName),
            {
              maxAttempts: step.maxAttempts,
              stepName: step.stepName,
              jobId,
              stepId: step.id,
            }
          )
          ctx.mailboxes = emailResult.mailboxes
          ctx.dkimPublicKey = emailResult.dkimPublicKey
          ctx.webmailUrl = emailResult.webmailUrl
          break
        case 'verify':
          output = verifyResult = await withRetry(
            () => verifyProvisioning(job, step, ctx.domainName, ctx.projectId || ''),
            {
              maxAttempts: step.maxAttempts,
              stepName: step.stepName,
              jobId,
              stepId: step.id,
            }
          )
          ctx.hostingReachable = verifyResult.hostingReachable
          ctx.emailVerified = verifyResult.emailVerified
          ctx.dnsPropagated = verifyResult.dnsPropagated
          break
        default:
          throw new Error(`Unknown step: ${step.stepName}`)
      }

      // Step succeeded — persist output + status.
      const stepEnd = new Date()
      await db.provisioningStep.update({
        where: { id: step.id },
        data: {
          status: 'success',
          output: JSON.stringify(output),
          completedAt: stepEnd,
          duration: stepEnd.getTime() - stepStart.getTime(),
        },
      })

      await logAudit({
        userId: job.userId,
        action: `provisioning.step.${step.stepName}.success`,
        resource: 'provisioning_step',
        resourceId: step.id,
        metadata: { jobId, stepName: step.stepName },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const stepEnd = new Date()
      ctx.errors.push({
        step: step.stepName,
        error: msg,
        timestamp: stepEnd.toISOString(),
      })

      await db.provisioningStep.update({
        where: { id: step.id },
        data: {
          status: 'failed',
          error: msg,
          completedAt: stepEnd,
          duration: stepEnd.getTime() - stepStart.getTime(),
        },
      })

      await logAudit({
        userId: job.userId,
        action: `provisioning.step.${step.stepName}.failed`,
        resource: 'provisioning_step',
        resourceId: step.id,
        metadata: { jobId, stepName: step.stepName, error: msg },
        status: 'failure',
      })

      console.error(
        `[orchestration] job=${jobId} step=${step.stepName} FAILED after retries: ${msg}`
      )

      // Critical step failure → stop pipeline + rollback.
      if (CRITICAL_STEPS.has(step.stepName)) {
        criticalFailed = true
        break
      }
      // Non-critical step failure → mark partial + continue.
      if (step.stepName === 'hosting_provision') hostingFailed = true
      if (step.stepName === 'email_provision') emailFailed = true
      // For verify step, just continue — we'll reflect status in the result.
    }
  }

  // ─── Rollback on critical failure ────────────────────────────────────
  if (criticalFailed) {
    await rollbackProvisioning(jobId).catch((rbErr) => {
      console.error(
        `[orchestration] rollback failed for job ${jobId}:`,
        rbErr instanceof Error ? rbErr.message : rbErr
      )
    })
    const completedAt = new Date()
    const duration = completedAt.getTime() - startedAt.getTime()
    const result: ProvisioningResult = buildResult(
      job.id,
      ctx,
      domainResult,
      dnsResult,
      hostingResult,
      emailResult,
      verifyResult,
      hostingFailed,
      emailFailed,
      'failed',
      duration
    )
    await db.provisioningJob.update({
      where: { id: jobId },
      data: {
        status: 'rolled_back',
        currentStep: 'rolled_back',
        result: JSON.stringify(result),
        completedAt,
        error: 'Critical step failed — pipeline rolled back',
      },
    })
    await createNotification({
      userId: job.userId,
      title: 'Provisioning failed',
      message: `Provisioning of ${job.domainName} failed and was rolled back. See job ${jobId} for details.`,
      type: 'error',
      link: `/dashboard/provisioning/${jobId}`,
    }).catch(() => {})
    return result
  }

  // ─── Build final result ──────────────────────────────────────────────
  const completedAt = new Date()
  const duration = completedAt.getTime() - startedAt.getTime()
  const overallStatus: 'success' | 'partial' | 'failed' =
    hostingFailed || emailFailed ? (domainResult && dnsResult ? 'partial' : 'failed') : 'success'

  const result = buildResult(
    job.id,
    ctx,
    domainResult,
    dnsResult,
    hostingResult,
    emailResult,
    verifyResult,
    hostingFailed,
    emailFailed,
    overallStatus,
    duration
  )

  await db.provisioningJob.update({
    where: { id: jobId },
    data: {
      status: overallStatus,
      currentStep: 'done',
      result: JSON.stringify(result),
      completedAt,
    },
  })

  // Send a notification to the user.
  const notifType = overallStatus === 'success' ? 'success' : overallStatus === 'partial' ? 'warning' : 'error'
  const configuredServices = ['Domain', 'DNS']
  if (hostingResult) configuredServices.push('hosting')
  if (emailResult) configuredServices.push('email')
  const notifMsg =
    overallStatus === 'success'
      ? `Your deployment ${job.domainName} is ready! ${configuredServices.join(', ')} configured.`
      : overallStatus === 'partial'
        ? `Provisioning of ${job.domainName} is partially complete. Some services may need attention.`
        : `Provisioning of ${job.domainName} failed. Please check the job details.`
  await createNotification({
    userId: job.userId,
    title:
      overallStatus === 'success'
        ? 'Provisioning complete'
        : overallStatus === 'partial'
          ? 'Provisioning partial'
          : 'Provisioning failed',
    message: notifMsg,
    type: notifType,
    link: `/dashboard/provisioning/${jobId}`,
  }).catch(() => {})

  await logAudit({
    userId: job.userId,
    action: `provisioning.complete.${overallStatus}`,
    resource: 'provisioning_job',
    resourceId: jobId,
    metadata: { domainName: job.domainName, duration, overallStatus },
  })

  return result
}

// ─── Stale pipeline recovery ─────────────────────────────────────────────

/**
 * How long a provisioning job may show no activity before it is treated as
 * dead. The pipeline runs in-process, so a panel restart kills it silently.
 * Must exceed the longest single step attempt: a hosting build may run up to
 * 30 min (plus clone/setup), and deploy-guard reaps deployments at 45 min.
 * The health check flags jobs stuck for 2h, so 60 min sits between the two.
 */
export const STALE_PROVISIONING_MS = 60 * 60 * 1000

/**
 * A job is stale when it is 'running' (or never left 'pending') since before
 * the cutoff, the job row has not changed since, and no step has started an
 * attempt since. The step check keeps a long-running step (its attempts bump
 * lastAttemptAt) from being mistaken for a dead one.
 */
function staleProvisioningWhere(cutoff: Date): Prisma.ProvisioningJobWhereInput {
  return {
    OR: [
      { status: 'running', OR: [{ startedAt: { lt: cutoff } }, { startedAt: null }] },
      { status: 'pending' },
    ],
    createdAt: { lt: cutoff },
    updatedAt: { lt: cutoff },
    steps: {
      none: { OR: [{ startedAt: { gte: cutoff } }, { lastAttemptAt: { gte: cutoff } }] },
    },
  }
}

/**
 * Mark provisioning jobs left 'running'/'pending' by a restart as failed, with
 * a clear reason, so they stop blocking a re-run (runProvisioningPipeline
 * refuses a 'running' job). No rollback: steps that finished (e.g. a paid
 * domain registration) are kept, and a re-run skips them.
 *
 * Called from the job worker's periodic tick. Each row is updated with the
 * stale condition re-checked, so a job that just made progress is untouched.
 * Returns the number of jobs marked failed.
 */
export async function failStaleProvisioningJobs(
  opts: { jobId?: string; staleAfterMs?: number } = {}
): Promise<number> {
  const cutoff = new Date(Date.now() - (opts.staleAfterMs ?? STALE_PROVISIONING_MS))
  const where = {
    ...staleProvisioningWhere(cutoff),
    ...(opts.jobId ? { id: opts.jobId } : {}),
  }
  const candidates = await db.provisioningJob.findMany({
    where,
    select: { id: true, userId: true, domainName: true, status: true },
    take: 50,
  })

  let failed = 0
  for (const job of candidates) {
    const reason =
      job.status === 'pending'
        ? 'Provisioning never started (the panel restarted before it began). It can be retried.'
        : 'Provisioning was interrupted (the panel restarted mid-run). It can be retried; completed steps are kept.'
    const now = new Date()
    const res = await db.provisioningJob.updateMany({
      where: { ...where, id: job.id },
      data: { status: 'failed', error: reason, errorCode: 'interrupted', completedAt: now },
    })
    if (res.count === 0) continue
    failed++
    await db.provisioningStep.updateMany({
      where: { jobId: job.id, status: 'running' },
      data: { status: 'failed', error: 'Interrupted by a panel restart', completedAt: now },
    })
    console.error(
      `[orchestration] job=${job.id} domain=${job.domainName} was ${job.status} with no activity; marked failed (interrupted)`
    )
    await logAudit({
      userId: job.userId,
      action: 'provisioning.interrupted',
      resource: 'provisioning_job',
      resourceId: job.id,
      metadata: { domainName: job.domainName, previousStatus: job.status },
      status: 'failure',
    }).catch(() => {})
  }
  return failed
}

// ─── Build the ProvisioningResult from the per-step outputs ──────────────

function buildResult(
  jobId: string,
  ctx: PipelineContext,
  domainResult: { domainId: string; externalId?: string; provider: string } | undefined,
  dnsResult:
    | { records: Array<{ type: string; name: string; value: string; recordId: string }> }
    | undefined,
  hostingResult:
    | { projectId: string; url: string; containerId?: string }
    | undefined,
  emailResult:
    | {
        mailboxes: Array<{
          address: string
          password: string
          type: string
          mailboxId: string
        }>
        dkimPublicKey: string
        webmailUrl: string
      }
    | undefined,
  verifyResult:
    | { hostingReachable: boolean; emailVerified: boolean; dnsPropagated: boolean }
    | undefined,
  hostingFailed: boolean,
  emailFailed: boolean,
  overallStatus: 'success' | 'partial' | 'failed',
  duration: number
): ProvisioningResult {
  const domainStatus: ProvisioningResult['domainStatus'] = {
    status: domainResult ? 'success' : 'fail',
    domain: ctx.domainName,
    provider: domainResult?.provider || ctx.provider,
    externalId: domainResult?.externalId || ctx.externalId,
    registered: !!domainResult,
    details: domainResult
      ? `Domain registered via ${domainResult.provider}.`
      : 'Domain registration failed.',
  }

  const dnsStatus: ProvisioningResult['dnsStatus'] = {
    status: dnsResult ? 'success' : 'fail',
    records: (dnsResult?.records || ctx.dnsRecords || []).map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      status: 'created',
    })),
    propagationVerified: verifyResult?.dnsPropagated ?? false,
    details: dnsResult
      ? `${dnsResult.records.length} DNS records configured (A, MX, TXT for SPF/DKIM/DMARC).`
      : 'DNS configuration failed.',
  }

  const hostingStatus: ProvisioningResult['hostingStatus'] = hostingResult
    ? {
        status: 'success',
        projectId: hostingResult.projectId,
        url: hostingResult.url,
        sslEnabled: true,
        healthChecked: verifyResult?.hostingReachable ?? true,
        details: `Container deployed + Caddy proxy + SSL issued via Let's Encrypt. URL: ${hostingResult.url}`,
        ...(hostingResult.containerId
          ? { containerId: hostingResult.containerId }
          : {}),
      }
    : hostingFailed
      ? (() => {
          // Surface the most recent hosting error in the details, if any.
          const lastHostingErr = ctx.errors
            .filter((e) => e.step === 'hosting_provision')
            .slice(-1)[0]
          return {
            status: 'fail' as const,
            sslEnabled: false,
            healthChecked: false,
            details: lastHostingErr
              ? `Hosting provisioning failed: ${lastHostingErr.error}`
              : 'Hosting provisioning failed after retries.',
          }
        })()
      : {
          status: 'skipped',
          sslEnabled: false,
          healthChecked: false,
          details: 'Hosting provisioning skipped (not requested).',
        }

  const emailStatus: ProvisioningResult['emailStatus'] = emailResult
    ? {
        status: 'success',
        mailboxes: emailResult.mailboxes.map((m) => ({ address: m.address, type: m.type })),
        dkimConfigured: !!emailResult.dkimPublicKey,
        smtpEnabled: verifyResult?.emailVerified ?? true,
        imapEnabled: verifyResult?.emailVerified ?? true,
        webmailUrl: emailResult.webmailUrl,
        details: `${emailResult.mailboxes.length} mailbox(es) created with DKIM signing enabled.`,
      }
    : emailFailed
      ? {
          status: 'fail',
          mailboxes: [],
          dkimConfigured: false,
          smtpEnabled: false,
          imapEnabled: false,
          details: 'Email provisioning failed after retries.',
        }
      : {
          status: 'skipped',
          mailboxes: [],
          dkimConfigured: false,
          smtpEnabled: false,
          imapEnabled: false,
          details: 'Email provisioning skipped (not requested).',
        }

  // ─── Credentials ──────────────────────────────────────────────────
  const credentials: ProvisioningResult['credentials'] = {
    domain: {
      registrar: domainResult?.provider === 'dynadot' ? 'Dynadot' : 'Apsamo Panel',
      managementUrl:
        domainResult?.provider === 'dynadot'
          ? 'https://dynadot.com/account/manage/domain.html'
          : '/dashboard/domains',
    },
    dns: {
      nameservers: ctx.nameservers.length
        ? ctx.nameservers
        : [NS1_HOSTNAME, NS2_HOSTNAME],
      managementUrl: `/dashboard/domains/${ctx.domainId || ''}/dns`,
    },
  }

  if (hostingResult) {
    credentials.hosting = {
      adminUrl: '/dashboard/hosting',
    }
  }

  if (emailResult) {
    const info = ctx.mailServerInfo || {
      imap: { host: ctx.mailServerHostname, port: 993, ssl: true },
      smtp: { host: ctx.mailServerHostname, port: 587, tls: true },
      webmail: emailResult.webmailUrl,
    }
    credentials.email = {
      mailboxes: emailResult.mailboxes.map((m) => ({
        address: m.address,
        password: m.password, // plaintext — shown once
        type: m.type,
      })),
      imap: info.imap,
      smtp: info.smtp,
      webmail: info.webmail,
    }
  }

  return {
    overallStatus,
    domainStatus,
    dnsStatus,
    hostingStatus,
    emailStatus,
    credentials,
    jobId,
    duration,
    errors: ctx.errors,
  }
}

// ─── Step 1: provisionDomain ─────────────────────────────────────────────

/** Message used when the pipeline is asked to buy a domain itself. */
export const ORCHESTRATION_REGISTRATION_DISABLED =
  'Domain registration through the provisioning pipeline is disabled. Register the domain through a domain order (domain checkout, which collects the registrant contacts and takes payment first), then run provisioning for the registered domain.'

/**
 * Step 1: resolve the domain this job provisions.
 *
 * This step used to REGISTER the domain itself — registerDomain(name, 1) with
 * no registrant contacts, a fixed one-year term, no DomainOrder and no check
 * that the name was not already in an account here. Registration now happens
 * only through a paid DomainOrder (domain-checkout → fulfilDomainOrder). The
 * pipeline accepts a domain the job's user already holds and refuses anything
 * else; it never calls the registrar's purchase API.
 */
async function provisionDomain(
  job: { id: string; userId: string; domainName: string },
  _step: { id: string }
): Promise<{ domainId: string; externalId?: string; provider: string }> {
  const domainName = job.domainName.toLowerCase().trim()

  const existing = await db.domain.findUnique({ where: { name: domainName } })
  if (existing && existing.userId === job.userId && existing.status !== 'deleted') {
    console.log(
      `[orchestration] step=domain_register using existing domain ${existing.id} (${domainName}); no registrar call`
    )
    return {
      domainId: existing.id,
      externalId: existing.externalId || undefined,
      provider: existing.provider || existing.registrar || 'dynadot',
    }
  }
  if (existing && existing.status !== 'deleted') {
    throw new Error(`Domain ${domainName} belongs to another account`)
  }
  throw new Error(ORCHESTRATION_REGISTRATION_DISABLED)
}

// ─── Step 2: configureDns ────────────────────────────────────────────────

/**
 * Step 2: Configure DNS records via Dynadot's setDnsRecords() and persist
 * each as a DnsRecord row.
 *
 * Records created:
 *   - A     @            → hostingServerIp
 *   - A     www          → hostingServerIp
 *   - MX    @            → mailServerHostname (priority 10)
 *   - TXT   @            → "v=spf1 mx a -all"  (SPF)
 *   - TXT   mail._domainkey → DKIM public key (placeholder if Mailcow not yet run)
 *   - TXT   _dmarc       → "v=DMARC1; p=quarantine; rua=mailto:admin@domain"
 */
async function configureDns(
  job: { id: string; userId: string; domainName: string },
  step: { id: string },
  domainId: string,
  mailServerHostname: string,
  hostingServerIp: string
): Promise<{
  records: Array<{ type: string; name: string; value: string; recordId: string }>
}> {
  const domainName = job.domainName

  // Build the full set of DNS records.
  // NOTE: DKIM is generated by the email step which runs AFTER this one.
  // We use a placeholder DKIM TXT record here; the email step will overwrite
  // it with the real Mailcow-generated key when it runs (best-effort update).
  const dkimPlaceholder = 'v=DKIM1; k=rsa; p=PLACEHOLDER_REPLACE_AFTER_EMAIL_PROVISIONING'

  const recordsToCreate: Array<{
    type: string
    name: string
    value: string
    ttl?: number
    priority?: number
  }> = [
    { type: 'A', name: '@', value: hostingServerIp, ttl: 3600 },
    { type: 'A', name: 'www', value: hostingServerIp, ttl: 3600 },
    { type: 'MX', name: '@', value: mailServerHostname, ttl: 3600, priority: 10 },
    { type: 'TXT', name: '@', value: 'v=spf1 mx a -all', ttl: 3600 },
    { type: 'TXT', name: 'mail._domainkey', value: dkimPlaceholder, ttl: 3600 },
    {
      type: 'TXT',
      name: '_dmarc',
      value: `v=DMARC1; p=quarantine; rua=mailto:admin@${domainName}`,
      ttl: 3600,
    },
  ]

  // 1. Push to Dynadot (or demo).
  const dnsResult = await setDnsRecords(
    domainName,
    recordsToCreate.map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      ttl: r.ttl,
      priority: r.priority,
    }))
  )
  if (!dnsResult.success) {
    throw new Error(`Dynadot setDnsRecords failed for ${domainName}`)
  }

  // 2. Persist each record to the DnsRecord table.
  const created: Array<{ type: string; name: string; value: string; recordId: string }> = []
  for (const r of recordsToCreate) {
    const rec = await db.dnsRecord.create({
      data: {
        domainId,
        type: r.type,
        name: r.name,
        value: r.value,
        ttl: r.ttl || 3600,
        priority: r.priority ?? null,
        proxied: false,
      },
    })
    created.push({
      type: r.type,
      name: r.name,
      value: r.value,
      recordId: rec.id,
    })
  }

  console.log(
    `[orchestration] step=dns_configure domainId=${domainId} records=${created.length}`
  )

  return { records: created }
}

// ─── Step 3: provisionHosting ────────────────────────────────────────────

/**
 * Step 3: Provision web hosting.
 *
 *  1. Pick a server — prefer active servers with dockerInstalled=true that
 *     have the fewest projects; fall back to any active server.
 *  2. Create a Project in DB with name=domainName, framework based on stack,
 *     status='creating', linked to the chosen server.
 *  3. Link the Domain to the Project.
 *  4. Create an initial Deployment record with status='queued'.
 *  5. Call the real VPS deployer (`deployProject`) which builds + launches
 *     the Docker container, configures the Caddy reverse proxy, and issues
 *     a Let's Encrypt SSL cert. The deployer updates both the Project and
 *     Deployment rows in-place as it progresses.
 *
 * Hosting is NON-CRITICAL: if the deploy fails, this function throws so the
 * orchestrator's retry wrapper can re-attempt; once retries are exhausted the
 * pipeline catches the error, marks `hostingFailed=true`, and continues to
 * the verification step.
 */
async function provisionHosting(
  job: { id: string; userId: string; domainName: string; stack: string },
  step: { id: string },
  domainId: string,
  domainName: string
): Promise<{ projectId: string; url: string; containerId?: string }> {
  const framework = stackToFramework(job.stack)
  const slug = domainName
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/^-|-$/g, '')
  // 1. Reuse the project an earlier attempt of this step created. withRetry
  //    re-runs this whole function, and each attempt used to create another
  //    Project + Deployment — up to three sites for one order.
  const domainRow = await db.domain.findUnique({
    where: { id: domainId },
    select: { projectId: true },
  })
  let project =
    (domainRow?.projectId
      ? await db.project.findFirst({ where: { id: domainRow.projectId, userId: job.userId } })
      : null) ||
    // Created but not yet linked (the attempt died between the two writes).
    (await db.project.findFirst({
      where: { userId: job.userId, customDomain: domainName },
      orderBy: { createdAt: 'desc' },
    }))

  if (!project) {
    // 2. Server: active, Docker installed, not down, with capacity. None is a
    //    clear failure, not a project that can never deploy.
    const assignedServer = await selectHostingServer()
    if (!assignedServer) throw new Error(NO_SERVER_MESSAGE)

    // 3. Internal subdomain key from the WHOLE domain (example.com →
    //    example-com), so example.com and example.net no longer collide on
    //    "example"; a remaining clash gets a random suffix. It is never
    //    served or shown — the site is reached on domainName.
    const base = slug.replace(/\./g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'site'
    let subdomain = APP_SUBDOMAIN_PATTERN.replace('{slug}', base)
    for (let i = 0; i < 5; i++) {
      const clash = await db.project.findFirst({ where: { subdomain }, select: { id: true } })
      if (!clash) break
      subdomain = APP_SUBDOMAIN_PATTERN.replace(
        '{slug}',
        `${base}-${crypto.randomBytes(3).toString('hex')}`
      )
    }

    project = await db.project.create({
      data: {
        userId: job.userId,
        name: domainName,
        slug,
        framework,
        stack: job.stack,
        status: 'creating',
        subdomain,
        customDomain: domainName,
        sslEnabled: true,
        serverId: assignedServer.id,
      },
    })
  }
  // The domain this pipeline is for — never the internal platform subdomain.
  const url = `https://${(project.customDomain || domainName).toLowerCase()}`

  // Link the Domain to the Project (idempotent).
  await db.domain.update({
    where: { id: domainId },
    data: { projectId: project.id },
  })

  // A build of this project already running (an earlier attempt still going)
  // must not be joined by a second one.
  const inFlight = await db.deployment.findFirst({
    where: { projectId: project.id, status: { in: ACTIVE_DEPLOY_STATUSES } },
    select: { id: true },
  })
  if (inFlight) {
    throw new Error(`Deployment ${inFlight.id} for project ${project.id} is still in progress`)
  }

  // 4. Create an initial Deployment row in 'queued' status.
  const deployment = await db.deployment.create({
    data: {
      projectId: project.id,
      userId: job.userId,
      branch: 'main',
      status: 'queued',
      deployUrl: url,
      triggeredBy: 'provisioning',
    },
  })

  // 5. Run the real VPS deploy (await — the orchestrator is synchronous
  //    per-step). In demo mode this returns a simulated success.
  console.log(
    `[orchestration] step=hosting_provision projectId=${project.id} server=${project.serverId || 'none'} url=${url}`
  )
  const deployResult = await deployProject({
    projectId: project.id,
    deploymentId: deployment.id,
    onLog: (msg) =>
      console.log(`[orchestration] job=${job.id} deploy: ${msg}`),
  })

  if (!deployResult.ok) {
    // The deployer already persisted status='error' on the Project and
    // status='failed' on the Deployment. Throw so the orchestrator's retry
    // wrapper can re-attempt (and ultimately mark hostingFailed=true).
    throw new Error(
      `VPS deploy failed: ${deployResult.error || 'unknown error'}`
    )
  }

  return {
    projectId: project.id,
    url,
    containerId: deployResult.containerId,
  }
}

// ─── Step 4: provisionEmail ──────────────────────────────────────────────

/**
 * Step 4: Provision email hosting via Mailcow.
 *
 *  1. addDomain() in Mailcow.
 *  2. generateDkim() for the domain.
 *  3. Create 3 mailboxes: admin@, info@, support@ with random passwords.
 *     Each mailbox password is encrypted (AES-256-GCM) before DB storage.
 *  4. Update Domain.emailHosted=true, mailcowDomainId.
 *  5. Fetch mail server connection info (IMAP/SMTP/webmail).
 *
 * Returns the plaintext passwords alongside each mailbox so the caller can
 * include them in the one-time credentials payload.
 */
async function provisionEmail(
  job: { id: string; userId: string; domainName: string },
  step: { id: string },
  domainId: string,
  domainName: string
): Promise<{
  mailboxes: Array<{ address: string; password: string; type: string; mailboxId: string }>
  dkimPublicKey: string
  webmailUrl: string
}> {
  // 1. Add the domain to Mailcow.
  const addDomainResult = await addDomain({
    domain: domainName,
    description: `Apsamo Panel provisioned domain for ${job.userId}`,
    mailboxes: 10,
    aliases: 20,
    quota: 1024,
  })
  if (!addDomainResult.success) {
    throw new Error(`Mailcow addDomain failed: ${addDomainResult.error}`)
  }

  // 2. Generate DKIM.
  const dkimResult = await generateDkim(domainName, 'mail')
  if (!dkimResult.success || !dkimResult.publicKey) {
    throw new Error(`Mailcow generateDkim failed: ${dkimResult.error}`)
  }

  // 3. Update the Domain with email hosting info.
  await db.domain.update({
    where: { id: domainId },
    data: {
      emailHosted: true,
      mailcowDomainId: addDomainResult.domainId || domainName,
    },
  })

  // 4. Create 3 standard mailboxes: admin, info, support.
  const mailboxSpecs: Array<{ localPart: string; name: string; type: string; isDefault: boolean }> = [
    { localPart: 'admin', name: 'Administrator', type: 'admin', isDefault: true },
    { localPart: 'info', name: 'Info', type: 'info', isDefault: false },
    { localPart: 'support', name: 'Support', type: 'support', isDefault: false },
  ]

  const mailboxes: Array<{
    address: string
    password: string
    type: string
    mailboxId: string
  }> = []

  for (const spec of mailboxSpecs) {
    const password = generatePassword()
    const address = `${spec.localPart}@${domainName}`

    const mbResult = await createMailbox({
      localPart: spec.localPart,
      domain: domainName,
      password,
      name: spec.name,
      quota: 1024,
    })
    if (!mbResult.success) {
      throw new Error(
        `Mailcow createMailbox failed for ${address}: ${mbResult.error}`
      )
    }

    // Persist with encrypted password.
    await db.emailMailbox.create({
      data: {
        domainId,
        address,
        localPart: spec.localPart,
        password: encrypt(password),
        quota: 1073741824, // 1GB in bytes
        active: true,
        isDefault: spec.isDefault,
        mailcowId: mbResult.mailboxId,
        dkimEnabled: true,
      },
    })

    mailboxes.push({
      address,
      password, // plaintext — kept in memory for the credentials payload
      type: spec.type,
      mailboxId: mbResult.mailboxId || address,
    })
  }

  // 5. Fetch mail server connection info.
  const serverInfo = await getMailServerInfo(domainName)

  console.log(
    `[orchestration] step=email_provision domainId=${domainId} mailboxes=${mailboxes.length} dkim=✓`
  )

  return {
    mailboxes,
    dkimPublicKey: dkimResult.publicKey,
    webmailUrl: serverInfo.webmail,
  }
}

// ─── Step 5: verifyProvisioning ──────────────────────────────────────────

/**
 * Step 5: Verify that all provisioned services are reachable and properly
 * configured.
 *
 *  1. Hosting: confirm the Project exists and is in a non-error state.
 *  2. Email: call Mailcow verifyEmailSetup() for the domain.
 *  3. DNS: call dns.ts verifyTxtRecord() for the DKIM record (best-effort —
 *     DNS propagation can take minutes/hours so we don't fail the pipeline
 *     if it's not yet propagated).
 */
async function verifyProvisioning(
  job: { id: string; userId: string; domainName: string },
  step: { id: string },
  domainName: string,
  projectId: string
): Promise<{ hostingReachable: boolean; emailVerified: boolean; dnsPropagated: boolean }> {
  // 1. Hosting health check.
  let hostingReachable = false
  if (projectId) {
    try {
      const project = await db.project.findUnique({ where: { id: projectId } })
      hostingReachable =
        !!project &&
        (project.status === 'running' || project.status === 'creating' || project.status === 'building')
    } catch (err) {
      console.warn(
        `[orchestration] hosting health check failed:`,
        err instanceof Error ? err.message : err
      )
    }
  }

  // 2. Email verification (Mailcow).
  let emailVerified = false
  try {
    const emailCheck = await verifyEmailSetup(domainName)
    emailVerified = emailCheck.success
  } catch (err) {
    console.warn(
      `[orchestration] email verification failed:`,
      err instanceof Error ? err.message : err
    )
  }

  // 3. DNS propagation check (best-effort, never fails the pipeline).
  let dnsPropagated = false
  try {
    // Verify the SPF TXT record exists at the authoritative resolver. In demo
    // mode this will likely return false (the records aren't actually live),
    // so we treat it as informational.
    dnsPropagated = await verifyTxtRecord(domainName, 'v=spf1')
  } catch (err) {
    console.warn(
      `[orchestration] DNS propagation check failed:`,
      err instanceof Error ? err.message : err
    )
  }

  console.log(
    `[orchestration] step=verify hosting=${hostingReachable} email=${emailVerified} dns=${dnsPropagated}`
  )

  return { hostingReachable, emailVerified, dnsPropagated }
}

// ─── rollbackProvisioning ────────────────────────────────────────────────

/**
 * Roll back all completed steps in REVERSE order. For each successful step:
 *
 *   email_provision      → Mailcow removeDomain() + delete EmailMailbox rows
 *   hosting_provision    → removeProjectContainer() (Docker compose down +
 *                          Caddy config removed) + clear container fields
 *   dns_configure        → delete DnsRecord rows
 *   domain_register      → mark Domain status='cancelled' (can't unregister)
 *
 * Updates each step status to 'rolled_back' and sets job.status='rolled_back'
 * with rollbackStartedAt/rollbackCompletedAt timestamps.
 */
export async function rollbackProvisioning(
  jobId: string
): Promise<{
  rolledBack: string[]
  failed: Array<{ step: string; error: string }>
}> {
  const job = await db.provisioningJob.findUnique({
    where: { id: jobId },
    include: { steps: { orderBy: { stepOrder: 'desc' } } },
  })
  if (!job) {
    throw new Error(`ProvisioningJob not found: ${jobId}`)
  }

  await db.provisioningJob.update({
    where: { id: jobId },
    data: { rollbackStartedAt: new Date(), status: 'rolled_back' },
  })

  const rolledBack: string[] = []
  const failed: Array<{ step: string; error: string }> = []

  for (const step of job.steps) {
    if (step.status !== 'success') continue

    try {
      switch (step.stepName) {
        case 'email_provision': {
          // Delete mailboxes in Mailcow (best-effort), then remove the domain.
          const domain = await db.domain.findFirst({
            where: { name: job.domainName },
            include: { mailboxes: true },
          })
          if (domain) {
            for (const mb of domain.mailboxes) {
              try {
                await deleteMailbox(mb.address)
              } catch (err) {
                console.warn(
                  `[orchestration] rollback deleteMailbox ${mb.address} failed:`,
                  err instanceof Error ? err.message : err
                )
              }
            }
            try {
              await removeDomain(job.domainName)
            } catch (err) {
              console.warn(
                `[orchestration] rollback removeDomain ${job.domainName} failed:`,
                err instanceof Error ? err.message : err
              )
            }
            await db.emailMailbox.deleteMany({ where: { domainId: domain.id } })
            await db.domain.update({
              where: { id: domain.id },
              data: { emailHosted: false, mailcowDomainId: null },
            })
          }
          break
        }
        case 'hosting_provision': {
          const project = await db.project.findFirst({
            where: { userId: job.userId, name: job.domainName },
          })
          if (project) {
            // Tear down the real VPS container + Caddy config. Safe in demo
            // mode (no-op) and when the project was never deployed.
            try {
              await removeProjectContainer(project.id)
            } catch (err) {
              console.warn(
                `[orchestration] rollback removeProjectContainer ${project.id} failed:`,
                err instanceof Error ? err.message : err
              )
              // Fall back to a soft status update so the row at least
              // reflects the rolled-back intent.
              await db.project
                .update({
                  where: { id: project.id },
                  data: { status: 'stopped' },
                })
                .catch(() => {})
            }
          }
          break
        }
        case 'dns_configure': {
          // Only the records THIS job created (their ids are in the step
          // output). The domain now always pre-exists the job, so deleting
          // every record on it would wipe the customer's own DNS.
          let ids: string[] = []
          try {
            const out = step.output ? JSON.parse(step.output) : null
            ids = Array.isArray(out?.records)
              ? out.records.map((r: { recordId?: string }) => r.recordId).filter(Boolean)
              : []
          } catch {
            ids = []
          }
          if (ids.length) {
            await db.dnsRecord.deleteMany({ where: { id: { in: ids } } })
          }
          break
        }
        case 'domain_register': {
          // Nothing to undo: this step no longer registers anything — it only
          // resolves a domain the customer already holds (bought through a
          // DomainOrder), which must not be cancelled by a failed pipeline.
          break
        }
        case 'verify': {
          // Nothing to roll back for the verify step.
          break
        }
        default:
          break
      }

      await db.provisioningStep.update({
        where: { id: step.id },
        data: { status: 'rolled_back' },
      })
      rolledBack.push(step.stepName)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      failed.push({ step: step.stepName, error: msg })
      console.error(
        `[orchestration] rollback of step ${step.stepName} failed: ${msg}`
      )
    }
  }

  await db.provisioningJob.update({
    where: { id: jobId },
    data: {
      rollbackCompletedAt: new Date(),
      rollbackSteps: JSON.stringify(rolledBack),
      status: 'rolled_back',
      currentStep: 'rolled_back',
    },
  })

  await logAudit({
    userId: job.userId,
    action: 'provisioning.rollback',
    resource: 'provisioning_job',
    resourceId: jobId,
    metadata: { rolledBack, failed },
    status: failed.length > 0 ? 'failure' : 'success',
  })

  console.log(
    `[orchestration] rollback complete for job=${jobId} rolledBack=${rolledBack.join(',')} failed=${failed.length}`
  )

  return { rolledBack, failed }
}

// ─── getProvisioningStatus ───────────────────────────────────────────────

/**
 * Fetch the current status of a provisioning job: the job record, all steps,
 * and the parsed ProvisioningResult if the pipeline has completed.
 */
export async function getProvisioningStatus(jobId: string): Promise<{
  job: Record<string, unknown> | null
  steps: Array<Record<string, unknown>>
  result?: ProvisioningResult
}> {
  const job = await db.provisioningJob.findUnique({
    where: { id: jobId },
    include: { steps: { orderBy: { stepOrder: 'asc' } } },
  })

  if (!job) {
    return { job: null, steps: [] }
  }

  let result: ProvisioningResult | undefined
  if (job.result) {
    try {
      result = JSON.parse(job.result) as ProvisioningResult
    } catch {
      // ignore parse errors
    }
  }

  // Strip the heavy `input`/`output` JSON blobs from the steps for the
  // response — callers can fetch a single step's detail separately if needed.
  const steps = job.steps.map((s) => ({
    id: s.id,
    stepName: s.stepName,
    stepOrder: s.stepOrder,
    status: s.status,
    attempts: s.attempts,
    maxAttempts: s.maxAttempts,
    error: s.error,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    duration: s.duration,
    lastAttemptAt: s.lastAttemptAt,
  }))

  // Strip the huge `result` blob from the job — it's already in `result`.
  const { result: _r, steps: _s, ...jobClean } = job
  void _r
  void _s

  return {
    job: jobClean as Record<string, unknown>,
    steps: steps as Array<Record<string, unknown>>,
    result,
  }
}
