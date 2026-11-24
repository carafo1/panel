/**
 * Cron Jobs Module  (REAL in-process scheduler)
 * =============================================
 *
 * Manages scheduled tasks (cron jobs) for a project. Each cron job is stored
 * in the CronJob Prisma table. An in-process `node-cron` scheduler runs every
 * enabled job's command on its cron schedule — no Docker daemon required for
 * localhost servers.
 *
 * Execution model
 * ---------------
 *   - EVERY server type, localhost included: the command runs INSIDE the
 *       project's container via `docker exec` (lib/vps/terminal.ts
 *       buildContainerExecCommand: minimal environment for the docker CLI,
 *       refuses when the container is not running). A customer command never
 *       runs on the host. Localhost jobs are fired by the in-process
 *       scheduler; no host crontab is written.
 *
 *   - REMOTE servers WITH a real Docker container:
 *       The container's own crontab is the source of truth (synced via
 *       `syncCrontab` using a portable `docker cp` approach). The in-process
 *       scheduler is STILL registered so the panel can also fire the job
 *       (executing via `docker exec`), but the container cron daemon is
 *       authoritative for remote hosts.
 *
 *   - No usable execution path (no serverId, or server in demo mode but not
 *       localhost): `executeJobOnce` throws a clear error so the API returns
 *       500 with an actionable message.
 *
 * Lifecycle
 * ---------
 *   - createCronJob  → DB insert + register with in-process scheduler +
 *                      (remote+container only) sync container crontab
 *   - updateCronJob  → DB update + unregister/re-register scheduler +
 *                      (remote+container only) re-sync container crontab
 *   - deleteCronJob  → unregister scheduler + (remote+container only) re-sync
 *                      crontab + DB delete
 *   - runCronJobNow  → docker exec into the project container (all servers)
 *
 * `startCronScheduler()` is called lazily on first use (create / update /
 * run / list) so SSR cold-starts stay fast and we don't schedule twice during
 * dev hot-reload. It loads ALL enabled cron jobs from the DB and registers
 * them with node-cron.
 *
 * Cron expressions: standard 5-field or @yearly/@annually/@monthly/@weekly/
 * @daily/@midnight/@hourly/@reboot. Validated by BOTH our regex (for friendly
 * error messages) AND `node-cron.validate()` (for scheduler safety). @reboot
 * is accepted by our validator but node-cron will skip scheduling it (the
 * process already booted); the DB row is still kept.
 */
import cron, { type ScheduledTask } from 'node-cron'
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  putFile,
  isServerInDemoMode,
  isLocalHost,
} from './ssh'
import { type LocalClient } from './local-exec'
import { getServerCredentials } from './provisioner'
import {
  buildContainerExecCommand,
  isSafeContainerName,
  CONTAINER_NOT_RUNNING_MARKER,
} from './terminal'

/** Runs inside the container: $1 is the job's command (stderr folded into stdout). */
const CRON_SCRIPT = 'eval "$1" 2>&1'

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
 * Returns `{ ok, message }` with a human-friendly error for the API layer.
 * (The in-process scheduler additionally double-checks with `cron.validate()`.)
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

// ─── In-process scheduler state (module-level) ───────────────────────────

/**
 * Map of jobId → active ScheduledTask. Kept so we can destroy/recreate a
 * task when its expression or enabled flag changes, and tear it down on delete.
 */
const scheduledTasks = new Map<string, ScheduledTask>()

/** True once the initial DB sweep has completed. */
let schedulerStarted = false

/** In-flight boot promise so concurrent callers share one sweep. */
let schedulerStartPromise: Promise<void> | null = null

/**
 * Lazily boot the in-process cron scheduler. Loads ALL enabled CronJob rows
 * from the DB (with their project.server) and registers each with node-cron.
 *
 * Safe to call multiple times — idempotent. Does NOT throw (failures are
 * logged) so callers in hot request paths don't break. Should be called on
 * first use of any cron operation (create/update/run/list) rather than at
 * module load, to keep SSR cold-starts fast.
 */
export async function startCronScheduler(): Promise<void> {
  if (schedulerStarted) return
  if (schedulerStartPromise) return schedulerStartPromise

  schedulerStartPromise = (async () => {
    try {
      const jobs = await db.cronJob.findMany({
        where: { enabled: true },
        include: { project: { include: { server: true } } },
      })
      let registered = 0
      for (const job of jobs) {
        try {
          registerScheduledTask(
            {
              id: job.id,
              expression: job.expression,
              command: job.command,
              enabled: job.enabled,
            },
            job.project?.server?.sshHost
          )
          if (scheduledTasks.has(job.id)) registered++
        } catch (err) {
          console.error(
            `[vps-cron] failed to schedule job ${job.id} on startup:`,
            err
          )
        }
      }
      schedulerStarted = true
      console.log(
        `[vps-cron] scheduler started — ${registered}/${jobs.length} enabled job(s) registered`
      )
    } catch (err) {
      console.error('[vps-cron] failed to start scheduler:', err)
      // Leave schedulerStarted=false so a later call can retry.
    } finally {
      schedulerStartPromise = null
    }
  })()

  return schedulerStartPromise
}

/**
 * Register a single job with node-cron. Replaces any existing registration
 * for the same jobId (so expression/enabled changes take effect immediately).
 * The callback runs the job command via `executeJobOnce` and records the
 * result in the DB; failures are caught so a single bad job can't crash the
 * scheduler.
 */
function registerScheduledTask(
  job: { id: string; expression: string; command: string; enabled: boolean },
  sshHost?: string | null
): void {
  // Always unschedule first to avoid duplicates after expression/enabled changes.
  unregisterScheduledTask(job.id)

  if (!job.enabled) return

  // Double-check the expression with node-cron's own validator. @reboot and
  // other strings our regex accepts may not be schedulable by node-cron —
  // log and skip (the DB row is still kept for the UI).
  let valid = false
  try {
    valid = cron.validate(job.expression)
  } catch {
    valid = false
  }
  if (!valid) {
    console.error(
      `[vps-cron] node-cron rejected expression "${job.expression}" for job ${job.id} — not scheduling (DB row kept)`
    )
    return
  }

  const task = cron.schedule(
    job.expression,
    async () => {
      try {
        await executeJobOnce(job.id)
      } catch (err) {
        // A failing scheduled run must NEVER crash the scheduler.
        console.error(
          `[vps-cron] scheduled run failed for job ${job.id}:`,
          err
        )
      }
    },
    {
      // Prevent overlapping executions of the same job if a run takes longer
      // than the schedule interval.
      noOverlap: true,
      name: `cron-${job.id}`,
    }
  )

  scheduledTasks.set(job.id, task)
}

/**
 * Unregister (stop + remove) a scheduled task. Safe to call when no task is
 * registered for the jobId. Uses `stop()` (node-cron's documented destroy
 * method) and falls back to `destroy()` if available, then removes from our
 * map.
 */
function unregisterScheduledTask(jobId: string): void {
  const existing = scheduledTasks.get(jobId)
  if (!existing) return
  // The ScheduledTask surface exposes both `stop()` (pause) and `destroy()`
  // (full removal). Call both so the task is fully torn down regardless of
  // which node-cron version is installed — the spec calls out `.stop()` as the
  // destroy method; `destroy()` is the v4 "remove from registry" call.
  for (const fn of [existing.stop, existing.destroy]) {
    try {
      const ret = fn.call(existing)
      if (ret && typeof (ret as Promise<void>).then === 'function') {
        void (ret as Promise<void>).catch(() => {})
      }
    } catch {
      /* noop */
    }
  }
  scheduledTasks.delete(jobId)
}

// ─── Core execution (shared by scheduler + runCronJobNow) ────────────────

/**
 * Execute a cron job ONCE and record the result in the DB.
 *
 *   - Any server with a container → `docker exec` into it (never the host).
 *   - REMOTE server + container → run via `docker exec` over SSH.
 *   - Neither path available → throw a clear, actionable error.
 *
 * Updates `lastStatus` → 'running' before execution, then 'success'/'failed'
 * with `lastRunAt` + truncated `lastOutput` after. Never swallows the
 * "no execution path" error — that propagates to the caller (and the API
 * route turns it into a 500 with a helpful message).
 */
async function executeJobOnce(jobId: string): Promise<RunCronJobResult> {
  const job = await db.cronJob.findUnique({
    where: { id: jobId },
    include: { project: { include: { server: true } } },
  })
  if (!job) throw new Error('Cron job not found')
  if (!job.project) throw new Error('Project not found for cron job')

  const project = job.project
  const server = project.server

  // Customer commands run ONLY inside the project's own container, on every
  // server type including localhost. (Localhost used to run them straight on
  // the panel host as root, with the panel's secrets in the environment.)
  const containerPath =
    !!project.serverId &&
    isSafeContainerName(project.containerName) &&
    !!server &&
    (isLocalHost(server.sshHost) || !isServerInDemoMode(server))

  // No usable execution path → clear, actionable error.
  if (!containerPath) {
    throw new Error(
      `Cron job ${jobId} cannot run: the website has no container yet. ` +
        `Deploy and start the website; cron jobs run inside its container.`
    )
  }

  await db.cronJob.update({
    where: { id: jobId },
    data: { lastStatus: 'running' },
  })

  const start = Date.now()
  let output = ''
  let exitCode: number | null = null
  let status: 'success' | 'failed' = 'failed'

  // ── docker exec into the project's container (localhost or remote) ──
  // The command reaches the container as an argument of a fixed script; the
  // docker CLI runs with a minimal environment; a stopped container fails the
  // run instead of falling back to the host.
  try {
    const creds = await getServerCredentials(project.serverId!)
    const result = await withConnection(creds, async (client) => {
      return await exec(
        client,
        buildContainerExecCommand(project.containerName!, CRON_SCRIPT, [job.command]),
        { timeoutMs: 60000 }
      )
    })
    if ((result.stderr || '').includes(CONTAINER_NOT_RUNNING_MARKER)) {
      output = "The website's container is not running — the job was not run."
      exitCode = -1
      status = 'failed'
    } else {
      output =
        (result.stdout || '') +
        (result.stderr ? `\n[stderr]\n${result.stderr}` : '')
      exitCode = result.exitCode
      status = result.exitCode === 0 ? 'success' : 'failed'
    }
  } catch (err) {
    output = err instanceof Error ? err.message : String(err)
    exitCode = -1
    status = 'failed'
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

// ─── List ────────────────────────────────────────────────────────────────

export async function listCronJobs(projectId: string): Promise<CronJobRow[]> {
  // Boot the scheduler opportunistically when the cron tab is viewed.
  void startCronScheduler()
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

  // ALWAYS register with the in-process scheduler (localhost jobs run here;
  // remote jobs are also registered as a backup executor).
  await startCronScheduler()
  registerScheduledTask(row, project.server?.sshHost)

  // ONLY sync the container crontab for remote servers with a real container.
  // Localhost servers are executed by the in-process scheduler — no crontab.
  if (
    project.serverId &&
    project.containerName &&
    project.server &&
    !isLocalHost(project.server.sshHost) &&
    !isServerInDemoMode(project.server)
  ) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        await syncCrontab(client, project.containerName!, projectId)
      })
    } catch (err) {
      console.error('[vps-cron] failed to sync crontab on create:', err)
    }
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

  const project = await db.project.findUnique({
    where: { id: existing.projectId },
    include: { server: true },
  })

  // ALWAYS re-register with the in-process scheduler so expression/enabled
  // changes take effect immediately (unregister-then-register is handled
  // inside registerScheduledTask).
  await startCronScheduler()
  registerScheduledTask(updated, project?.server?.sshHost)

  // ONLY re-sync the container crontab for remote servers with a container.
  if (
    project?.serverId &&
    project.containerName &&
    project.server &&
    !isLocalHost(project.server.sshHost) &&
    !isServerInDemoMode(project.server)
  ) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        await syncCrontab(client, project.containerName!, existing.projectId)
      })
    } catch (err) {
      console.error('[vps-cron] failed to sync crontab on update:', err)
    }
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

  // ALWAYS unregister from the in-process scheduler.
  unregisterScheduledTask(jobId)

  // ONLY re-sync the container crontab (excluding this job) for remote
  // servers with a container.
  if (
    project?.serverId &&
    project.containerName &&
    project.server &&
    !isLocalHost(project.server.sshHost) &&
    !isServerInDemoMode(project.server)
  ) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        await syncCrontab(
          client,
          project.containerName!,
          existing.projectId,
          jobId
        )
      })
    } catch (err) {
      console.error('[vps-cron] failed to sync crontab on delete:', err)
    }
  }

  await db.cronJob.delete({ where: { id: jobId } })
  return { ok: true }
}

// ─── Run Now ─────────────────────────────────────────────────────────────

/**
 * Run a cron job immediately (ignoring its schedule). Boots the scheduler
 * opportunistically so existing DB jobs get registered, then delegates to
 * `executeJobOnce` which picks the right execution path:
 *   - any server → `docker exec` into the project container (never the host)
 *   - remote+container → `docker exec` over SSH
 * Throws a clear error if no execution path is available.
 */
export async function runCronJobNow(jobId: string): Promise<RunCronJobResult> {
  // Opportunistic boot — don't block on it (executeJobOnce runs directly).
  void startCronScheduler()
  return executeJobOnce(jobId)
}

// ─── Internal: portable container crontab sync ───────────────────────────

/**
 * Rewrite the entire root crontab inside a container from the DB rows for a
 * project. Portable across Alpine/BusyBox AND Debian-based containers by
 * avoiding `printf`/heredoc quirks — instead:
 *
 *   1. SFTP the new crontab content to a temp file on the remote host.
 *   2. `docker cp <remote-tmp> <container>:/var/spool/cron/crontabs/root`
 *   3. `docker exec <container> sh -c 'mkdir -p /var/spool/cron/crontabs &&
 *      chmod 600 /var/spool/cron/crontabs/root'`
 *   4. Clean up the temp file.
 *
 * `excludeJobId` (when set) omits that job — used by `deleteCronJob` so the
 * crontab is re-synced WITHOUT the deleted job in a single pass.
 *
 * NOTE: only called for REMOTE servers with a real container. Localhost
 * servers are executed by the in-process node-cron scheduler and never touch
 * a container crontab.
 */
async function syncCrontab(
  client: import('ssh2').Client | LocalClient,
  containerName: string,
  projectId: string,
  excludeJobId?: string
): Promise<void> {
  const jobs = await db.cronJob.findMany({
    where: excludeJobId
      ? { projectId, id: { not: excludeJobId }, enabled: true }
      : { projectId, enabled: true },
  })
  // Build the new crontab content with a managed-by header.
  const lines = [
    '# Managed by Apsamo Panel — DO NOT EDIT MANUALLY',
    ...jobs.map((j) => `${j.expression} ${j.command}`),
    '',
  ]
  const content = lines.join('\n')

  // 1. Upload the content to a temp file on the remote host (portable: no
  //    shell-escaping of the content needed — SFTP handles it as bytes).
  const remoteTmp = `/tmp/apsamo-cron-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.txt`
  await putFile(client, remoteTmp, content, { mode: 0o600 })

  // 2. docker cp into the container + ensure dir/chmod. Using sh -c so the
  //    mkdir+chmod run inside the container regardless of the container's
  //    default shell (Alpine=sh, Debian=sh via coreutils).
  const cpCmd =
    `docker cp ${shellQuoteLocal(remoteTmp)} ` +
    `${shellQuoteLocal(containerName)}:/var/spool/cron/crontabs/root && ` +
    `docker exec ${shellQuoteLocal(containerName)} sh -c ` +
    shellQuoteLocal(
      'mkdir -p /var/spool/cron/crontabs && chmod 600 /var/spool/cron/crontabs/root'
    )

  try {
    await exec(client, cpCmd, { timeoutMs: 20000 })
  } finally {
    // Best-effort cleanup of the temp file on the remote host.
    await exec(client, `rm -f ${shellQuoteLocal(remoteTmp)}`, {
      timeoutMs: 5000,
    }).catch(() => {
      /* noop */
    })
  }
}
