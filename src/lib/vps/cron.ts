/**
 * Cron Jobs Module
 * ================
 *
 * Manages scheduled tasks (cron jobs) for a project. Each cron job is stored
 * in the CronJob Prisma table and (when a real VPS is configured) is written
 * into the project's container crontab via `docker exec`.
 *
 * Operations:
 *   - listCronJobs(projectId)        — list all jobs (DB rows)
 *   - createCronJob(projectId, opts) — validate + create DB row + write crontab
 *   - updateCronJob(jobId, patch)    — update DB row + sync crontab
 *   - deleteCronJob(jobId)           — remove from crontab + delete DB row
 *   - runCronJobNow(jobId)           — docker exec the command, capture output
 *
 * In DEMO MODE (no real SSH host configured), every SSH-side action is
 * simulated — the DB row is still created/updated/deleted so the UI works
 * end-to-end and the user sees realistic feedback.
 *
 * Cron expressions accepted:
 *   - Standard 5-field:  "min hour day month weekday"  (e.g. "0 3 * * *")
 *   - Special strings:   @yearly @annually @monthly @weekly @daily @hourly @reboot
 */
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  isServerInDemoMode,
} from './ssh'
import { getServerCredentials } from './provisioner'

// ─── Types ───────────────────────────────────────────────────────────────

export interface CronJobRow {
  id: string
  projectId: string
  expression: string
  command: string
  description: string | null
  enabled: boolean
  lastRunAt: string | null
  lastStatus: string | null // success | failed | running
  lastOutput: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateCronJobInput {
  expression: string
  command: string
  description?: string | null
}

export interface UpdateCronJobPatch {
  expression?: string
  command?: string
  description?: string | null
  enabled?: boolean
}

export interface RunCronJobResult {
  ok: boolean
  status: 'success' | 'failed'
  output: string
  exitCode: number | null
  durationMs: number
}

// ─── Validation ──────────────────────────────────────────────────────────

const SPECIAL_STRINGS = new Set([
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
  '@reboot',
])

// Each field is one of: * , a-b , a/n , a,b,c , or a number in range.
const FIELD_RE =
  /^(?:\*|(?:\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|\d{1,2}\/\d{1,2})(?:,\s*(?:\d{1,2}|\d{1,2}-\d{1,2}|\*\/\d{1,2}|\d{1,2}\/\d{1,2}))*)$/

/**
 * Validate a cron expression. Accepts the 5-field form or a @-special string.
 * Returns `{ ok, message }`.
 */
export function validateCronExpression(expr: string): {
  ok: boolean
  message: string
} {
  const trimmed = (expr || '').trim()
  if (!trimmed) {
    return { ok: false, message: 'Cron expression is required' }
  }
  if (trimmed.startsWith('@')) {
    if (SPECIAL_STRINGS.has(trimmed.toLowerCase())) {
      return { ok: true, message: 'Valid special string' }
    }
    return {
      ok: false,
      message: `Unknown @-string. Valid: ${[...SPECIAL_STRINGS].join(', ')}`,
    }
  }
  const fields = trimmed.split(/\s+/)
  if (fields.length !== 5) {
    return {
      ok: false,
      message: 'Cron expression must have exactly 5 fields (min hour day month weekday)',
    }
  }
  for (const f of fields) {
    if (!FIELD_RE.test(f)) {
      return {
        ok: false,
        message: `Invalid cron field: "${f}"`,
      }
    }
  }
  return { ok: true, message: 'Valid cron expression' }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function shellQuoteLocal(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function toRow(r: {
  id: string
  projectId: string
  expression: string
  command: string
  description: string | null
  enabled: boolean
  lastRunAt: Date | null
  lastStatus: string | null
  lastOutput: string | null
  createdAt: Date
  updatedAt: Date
}): CronJobRow {
  return {
    id: r.id,
    projectId: r.projectId,
    expression: r.expression,
    command: r.command,
    description: r.description,
    enabled: r.enabled,
    lastRunAt: r.lastRunAt ? r.lastRunAt.toISOString() : null,
    lastStatus: r.lastStatus,
    lastOutput: r.lastOutput,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

function truncateOutput(s: string, max = 5000): string {
  if (!s) return ''
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... [truncated, ${s.length - max} more chars]`
}

// ─── List ────────────────────────────────────────────────────────────────

export async function listCronJobs(projectId: string): Promise<CronJobRow[]> {
  const rows = await db.cronJob.findMany({
    where: { projectId },
    orderBy: [{ createdAt: 'asc' }],
  })
  return rows.map(toRow)
}

// ─── Create ──────────────────────────────────────────────────────────────

export async function createCronJob(
  projectId: string,
  opts: CreateCronJobInput
): Promise<CronJobRow> {
  const expression = (opts.expression || '').trim()
  const command = (opts.command || '').trim()
  if (!expression) throw new Error('Cron expression is required')
  if (!command) throw new Error('Command is required')

  const valid = validateCronExpression(expression)
  if (!valid.ok) throw new Error(valid.message)

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  const row = await db.cronJob.create({
    data: {
      projectId,
      expression,
      command,
      description: opts.description?.trim() || null,
      enabled: true,
    },
  })

  // Best-effort: write to container crontab if SSH is available.
  if (
    project.serverId &&
    project.containerName &&
    !isServerInDemoMode(project.server)
  ) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        // Append a line "expr command" to the container's root crontab.
        const line = `${expression} ${command}`
        await exec(
          client,
          `docker exec ${shellQuoteLocal(project.containerName!)} sh -c ${shellQuoteLocal(
            `mkdir -p /var/spool/cron/crontabs && echo ${shellQuoteLocal(line)} >> /var/spool/cron/crontabs/root`
          )}`,
          { timeoutMs: 15000 }
        )
      })
    } catch (err) {
      console.error('[vps-cron] failed to write crontab on create:', err)
    }
  } else {
    console.log(
      `[demo] cron create — would append "${expression} ${command}" to ${project.containerName || 'container'} crontab`
    )
  }

  return toRow(row)
}

// ─── Update ──────────────────────────────────────────────────────────────

export async function updateCronJob(
  jobId: string,
  patch: UpdateCronJobPatch
): Promise<CronJobRow> {
  const existing = await db.cronJob.findUnique({ where: { id: jobId } })
  if (!existing) throw new Error('Cron job not found')

  const data: Record<string, unknown> = {}
  if (patch.expression !== undefined) {
    const expr = patch.expression.trim()
    if (!expr) throw new Error('Cron expression cannot be empty')
    const v = validateCronExpression(expr)
    if (!v.ok) throw new Error(v.message)
    data.expression = expr
  }
  if (patch.command !== undefined) {
    const cmd = patch.command.trim()
    if (!cmd) throw new Error('Command cannot be empty')
    data.command = cmd
  }
  if (patch.description !== undefined) {
    data.description = patch.description?.trim() || null
  }
  if (patch.enabled !== undefined) {
    data.enabled = !!patch.enabled
  }

  const updated = await db.cronJob.update({
    where: { id: jobId },
    data,
  })

  // Best-effort: re-sync crontab (remove old line, add new if enabled).
  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    include: { server: true },
  })
  if (
    project?.serverId &&
    project.containerName &&
    !isServerInDemoMode(project.server)
  ) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        // Naive but safe: rewrite the entire crontab from the DB rows.
        await syncCrontab(client, project.containerName!, existing.projectId)
      })
    } catch (err) {
      console.error('[vps-cron] failed to sync crontab on update:', err)
    }
  } else {
    console.log(
      `[demo] cron update — would re-sync crontab for ${project?.containerName || 'container'}`
    )
  }

  return toRow(updated)
}

// ─── Delete ──────────────────────────────────────────────────────────────

export async function deleteCronJob(jobId: string): Promise<{ ok: boolean }> {
  const existing = await db.cronJob.findUnique({ where: { id: jobId } })
  if (!existing) return { ok: false }

  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    include: { server: true },
  })

  if (
    project?.serverId &&
    project.containerName &&
    !isServerInDemoMode(project.server)
  ) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        await syncCrontab(client, project.containerName!, existing.projectId, jobId)
      })
    } catch (err) {
      console.error('[vps-cron] failed to remove crontab on delete:', err)
    }
  } else {
    console.log(
      `[demo] cron delete — would remove crontab line for job ${jobId}`
    )
  }

  await db.cronJob.delete({ where: { id: jobId } })
  return { ok: true }
}

// ─── Run Now ─────────────────────────────────────────────────────────────

export async function runCronJobNow(jobId: string): Promise<RunCronJobResult> {
  const job = await db.cronJob.findUnique({ where: { id: jobId } })
  if (!job) throw new Error('Cron job not found')

  const project = await db.project.findUnique({
    where: { id: job.projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  await db.cronJob.update({
    where: { id: jobId },
    data: { lastStatus: 'running' },
  })

  const start = Date.now()
  const demoMode =
    !project.serverId ||
    !project.containerName ||
    !project.server ||
    isServerInDemoMode(project.server)

  let output = ''
  let exitCode: number | null = null
  let status: 'success' | 'failed' = 'failed'

  if (demoMode) {
    console.log(`[demo] cron run — would docker exec ${project.containerName || 'container'}: ${job.command}`)
    // Simulate a quick successful run.
    await new Promise((r) => setTimeout(r, 400))
    output = `[demo] Running command inside ${project.containerName || 'container'}:\n$ ${job.command}\n\n[demo] Command completed successfully (exit code 0).`
    exitCode = 0
    status = 'success'
  } else {
    try {
      const creds = await getServerCredentials(project.serverId!)
      const result = await withConnection(creds, async (client) => {
        return await exec(
          client,
          `docker exec ${shellQuoteLocal(project.containerName!)} sh -c ${shellQuoteLocal(job.command)} 2>&1`,
          { timeoutMs: 60000 }
        )
      })
      output = (result.stdout || '') + (result.stderr ? `\n[stderr]\n${result.stderr}` : '')
      exitCode = result.exitCode
      status = result.exitCode === 0 ? 'success' : 'failed'
    } catch (err) {
      output = err instanceof Error ? err.message : String(err)
      exitCode = -1
      status = 'failed'
    }
  }

  const durationMs = Date.now() - start
  await db.cronJob.update({
    where: { id: jobId },
    data: {
      lastRunAt: new Date(),
      lastStatus: status,
      lastOutput: truncateOutput(output),
    },
  })

  return {
    ok: status === 'success',
    status,
    output: truncateOutput(output),
    exitCode,
    durationMs,
  }
}

// ─── Internal: rewrite the entire container crontab from the DB ──────────

async function syncCrontab(
  client: import('ssh2').Client,
  containerName: string,
  projectId: string,
  excludeJobId?: string
): Promise<void> {
  const jobs = await db.cronJob.findMany({
    where: excludeJobId
      ? { projectId, id: { not: excludeJobId }, enabled: true }
      : { projectId, enabled: true },
  })
  // Build the new crontab content. Add a header so it's clearly managed.
  const lines = [
    '# Managed by Apsamo Panel — DO NOT EDIT MANUALLY',
    ...jobs.map((j) => `${j.expression} ${j.command}`),
    '',
  ]
  const content = lines.join('\n')
  // Write to a temp file inside the container then move into place.
  // Use printf to avoid newline escaping headaches.
  const writeCmd = `docker exec ${shellQuoteLocal(containerName)} sh -c ${shellQuoteLocal(
    `mkdir -p /var/spool/cron/crontabs && printf %s ${shellQuoteLocal(content)} > /var/spool/cron/crontabs/root && chmod 600 /var/spool/cron/crontabs/root`
  )}`
  await exec(client, writeCmd, { timeoutMs: 15000 })
}
