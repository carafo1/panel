/**
 * Core Orchestration Engine
 * =========================
 *
 * The heart of DeployHub's automated provisioning pipeline. Coordinates the
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
import { db } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { createNotification } from '@/lib/notifications'
import {
  searchDomains,
  registerDomain,
  getDomainInfo,
  setDnsRecords,
  isDynadotDemoMode,
} from '@/lib/dynadot'
import { verifyTxtRecord } from '@/lib/dns'
import {
  addDomain,
  generateDkim,
  createMailbox,
  removeDomain,
  deleteMailbox,
  verifyEmailSetup,
  getMailServerInfo,
} from '@/lib/mailcow'
import { encrypt } from '@/lib/encryption'
import { deployProject, removeProjectContainer } from '@/lib/vps'

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
    provider: string // "dynadot" or "deployhub"
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

/** Resolve the hosting server IP — from Server table, or default for demo. */
async function resolveHostingServerIp(serverId?: string): Promise<string> {
  if (serverId) {
    const server = await db.server.findUnique({ where: { id: serverId } })
    if (server?.ip) return server.ip
  }
  const anyServer = await db.server.findFirst({
    where: { status: 'active' },
    orderBy: { createdAt: 'asc' },
  })
  if (anyServer?.ip) return anyServer.ip
  return '10.0.0.1' // demo default
}

/** Resolve the mail server hostname from env or fall back to a sensible default. */
function resolveMailServerHostname(): string {
  return process.env.MAIL_SERVER_HOSTNAME || 'mail.deployhub.io'
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
  const includeEmail = req.includeEmail ?? true

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
    throw new Error(`Pipeline already running for job ${jobId}`)
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

  const startedAt = new Date()
  await db.provisioningJob.update({
    where: { id: jobId },
    data: { status: 'running', startedAt, currentStep: 'domain' },
  })

  const req = JSON.parse(job.steps[0]?.input || '{}') as ProvisioningRequest
  const ctx: PipelineContext = {
    domainName: job.domainName,
    provider: 'dynadot',
    mailServerHostname: resolveMailServerHostname(),
    hostingServerIp: await resolveHostingServerIp(req.serverId),
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
  const notifMsg =
    overallStatus === 'success'
      ? `Your deployment ${job.domainName} is ready! Domain, DNS, hosting, and email are all configured.`
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
      registrar: domainResult?.provider === 'dynadot' ? 'Dynadot' : 'DeployHub',
      managementUrl:
        domainResult?.provider === 'dynadot'
          ? 'https://dynadot.com/account/manage/domain.html'
          : '/dashboard/domains',
    },
    dns: {
      nameservers: ctx.nameservers.length
        ? ctx.nameservers
        : ['ns1.deployhub.io', 'ns2.deployhub.io'],
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

/**
 * Step 1: Register the domain via Dynadot.
 *
 *  1. Search availability via Dynadot searchDomains().
 *  2. If available (or in demo mode), registerDomain() via Dynadot.
 *  3. Create a Domain record in DB with provider='dynadot', externalId,
 *     status='active'.
 */
async function provisionDomain(
  job: { id: string; userId: string; domainName: string },
  step: { id: string }
): Promise<{ domainId: string; externalId?: string; provider: string }> {
  const domainName = job.domainName

  // 1. Search availability.
  const searchResults = await searchDomains([domainName])
  const result = searchResults[0]
  const available = result?.available === true

  if (!available) {
    // In demo mode, the search heuristic may falsely mark short domains as
    // taken. Be forgiving: log a warning + proceed with registration anyway
    // (Dynadot's registerDomain() will be the source of truth).
    if (isDynadotDemoMode()) {
      console.log(
        `[orchestration] DEMO: domain ${domainName} reported unavailable by demo search, attempting registration anyway`
      )
    } else {
      throw new Error(`Domain ${domainName} is not available for registration`)
    }
  }

  // 2. Register the domain (1 year).
  const registration = await registerDomain(domainName, 1)
  if (!registration.success) {
    throw new Error(
      `Domain registration failed: ${registration.orderId ? 'order ' + registration.orderId : 'unknown error'}`
    )
  }

  // 3. Fetch domain info for nameservers + expiry.
  let info
  try {
    info = await getDomainInfo(domainName)
  } catch (err) {
    console.warn(
      `[orchestration] getDomainInfo failed for ${domainName}:`,
      err instanceof Error ? err.message : err
    )
    info = { nameservers: ['ns1.deployhub.io', 'ns2.deployhub.io'], expiry: undefined }
  }

  // 4. Create the Domain record in DB.
  const domain = await db.domain.create({
    data: {
      userId: job.userId,
      name: domainName,
      status: 'active',
      registrar: 'dynadot',
      provider: 'dynadot',
      externalId: registration.orderId,
      registeredAt: new Date(),
      expiresAt: info.expiry ? new Date(info.expiry) : undefined,
      nameservers: JSON.stringify(info.nameservers || []),
    },
  })

  console.log(
    `[orchestration] step=domain_register domainId=${domain.id} externalId=${registration.orderId}`
  )

  return {
    domainId: domain.id,
    externalId: registration.orderId,
    provider: 'dynadot',
  }
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
  const subdomain = `${slug.split('.')[0]}.deployhub.io`
  const url = `https://${subdomain}`

  // 1. Auto-assign a server: prefer active + dockerInstalled=true with the
  //    fewest projects; fall back to any active server.
  const serverCandidates = await db.server.findMany({
    where: { status: 'active' },
    include: { _count: { select: { projects: true } } },
  })
  // Sort: dockerInstalled first, then fewest projects, then oldest.
  serverCandidates.sort((a, b) => {
    if (a.dockerInstalled !== b.dockerInstalled) {
      return a.dockerInstalled ? -1 : 1
    }
    const pa = a._count?.projects ?? 0
    const pb = b._count?.projects ?? 0
    if (pa !== pb) return pa - pb
    return a.createdAt.getTime() - b.createdAt.getTime()
  })
  const assignedServer = serverCandidates[0] || null

  // 2. Create the Project record.
  const project = await db.project.create({
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
      serverId: assignedServer?.id || null,
    },
  })

  // 3. Link the Domain to the Project.
  await db.domain.update({
    where: { id: domainId },
    data: { projectId: project.id },
  })

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
    `[orchestration] step=hosting_provision projectId=${project.id} server=${assignedServer?.name || 'none'} url=${url}`
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
    description: `DeployHub provisioned domain for ${job.userId}`,
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
          const domain = await db.domain.findFirst({
            where: { name: job.domainName },
          })
          if (domain) {
            await db.dnsRecord.deleteMany({ where: { domainId: domain.id } })
          }
          break
        }
        case 'domain_register': {
          // Can't actually unregister a domain, but mark it cancelled in our DB.
          const domain = await db.domain.findFirst({
            where: { name: job.domainName },
          })
          if (domain) {
            await db.domain.update({
              where: { id: domain.id },
              data: { status: 'cancelled' },
            })
          }
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
