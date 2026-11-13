/**
 * Pipeline runner
 * ===============
 *
 * Executes a pipeline's stages for real. Each stage carries a shell `command`
 * (e.g. `npm run build`, `npm test`). Commands run in the project's deployed
 * Docker container via `docker exec` (falling back to the project's deploy path
 * on the host when there is no container), through the same SSH/exec transport
 * the deployer uses. Stages run sequentially and fail-fast: the first non-zero
 * exit marks the run `failed` and the remaining stages stay `skipped`.
 *
 * Runs are executed in the background (the POST handler returns immediately with
 * a `running` run) and this function updates the PipelineRun + Pipeline rows when
 * finished. `reconcileStaleRuns` rescues runs orphaned by a server restart.
 */
import { db } from '@/lib/db'
import { withConnection, exec } from '@/lib/vps/ssh'
import { getServerCredentials } from '@/lib/vps/provisioner'

/**
 * A stage as stored. Two shapes exist: the original `config.command`, and
 * the editor's current one with `command`, `workingDir`, `env`, `timeout`
 * (seconds) and `continueOnError` at the top level. The runner used to read
 * only `config.command`, so every pipeline saved from the editor failed with
 * "No command configured" — and a deploy-gated one blocked all deployments.
 */
export interface PipelineStageDef {
  name: string
  type: string
  config?: { command?: string } & Record<string, unknown>
  command?: string
  workingDir?: string
  env?: Record<string, string>
  timeout?: number
  continueOnError?: boolean
  order: number
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const MIN_TIMEOUT_S = 10
const MAX_TIMEOUT_S = 60 * 60

interface ResolvedStage {
  command: string
  /** Relative to the app root; null = the container's own WORKDIR. */
  workingDir: string | null
  env: Array<[string, string]>
  timeoutMs: number
  continueOnError: boolean
  problem: string | null
}

/** Normalise either stored shape into what the runner executes. */
export function resolveStage(stage: PipelineStageDef): ResolvedStage {
  const command = String(stage.command ?? stage.config?.command ?? '').trim()

  // '/' and '' are the editor's default and mean "wherever the app runs".
  // Anything else is a path inside the app; '..' could escape it.
  const rawDir = String(stage.workingDir ?? '').trim()
  let workingDir: string | null = null
  let problem: string | null = null
  if (rawDir && rawDir !== '/' && rawDir !== '.') {
    if (rawDir.split('/').includes('..')) problem = `Working directory "${rawDir}" may not contain "..".`
    else workingDir = rawDir.replace(/^\/+/, '')
  }

  const env: Array<[string, string]> = []
  for (const [k, v] of Object.entries(stage.env ?? {})) {
    if (!ENV_NAME.test(k)) {
      problem = problem ?? `"${k}" is not a valid environment variable name.`
      continue
    }
    env.push([k, String(v ?? '')])
  }

  const seconds = Number(stage.timeout)
  const timeoutMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(Math.max(seconds, MIN_TIMEOUT_S), MAX_TIMEOUT_S) * 1000
    : STAGE_TIMEOUT_MS

  return {
    command,
    workingDir,
    env,
    timeoutMs,
    continueOnError: stage.continueOnError === true,
    problem,
  }
}

/** The shell line for a stage, inside the container or in the deploy path. */
export function buildStageCommand(
  s: ResolvedStage,
  target: { containerName: string | null; deployPath: string | null }
): string {
  if (target.containerName) {
    // `docker exec -w` needs an absolute path; resolve relative ones against
    // the container's WORKDIR via `cd` instead, so `npm test` still works.
    const envFlags = s.env.map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`).join(' ')
    const inner = s.workingDir ? `cd ${shellQuote(s.workingDir)} && ${s.command}` : s.command
    return `docker exec ${envFlags} ${shellQuote(target.containerName)} sh -c ${shellQuote(inner)} 2>&1`
  }
  const exports = s.env.map(([k, v]) => `export ${k}=${shellQuote(v)};`).join(' ')
  const dir = s.workingDir
    ? `${shellQuote(target.deployPath!)}/${shellQuote(s.workingDir)}`
    : shellQuote(target.deployPath!)
  return `cd ${dir} && ( ${exports} ${s.command} ) 2>&1`
}

export interface PipelineStageResult {
  name: string
  type: string
  status: 'running' | 'success' | 'failed' | 'skipped'
  duration: number
  output: string
}

const MAX_STAGE_OUTPUT = 8000 // chars kept per stage (tail)
const STAGE_TIMEOUT_MS = 10 * 60 * 1000 // 10 minutes per stage
const RUN_STALE_MS = 30 * 60 * 1000 // a "running" run older than this is orphaned

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Initial stage results for a freshly-created run (nothing executed yet). */
export function queuedStageResults(stages: PipelineStageDef[]): PipelineStageResult[] {
  return [...stages]
    .sort((a, b) => a.order - b.order)
    .map((s) => ({ name: s.name, type: s.type, status: 'running', duration: 0, output: 'Queued…' }))
}

/**
 * Execute a pipeline run to completion, then persist the results. Never throws
 * — failures are captured into the run's status/output.
 */
export async function executePipelineRun(
  runId: string,
  pipelineId: string,
  projectId: string,
  stages: PipelineStageDef[]
): Promise<void> {
  const startedMs = Date.now()
  const ordered = [...stages].sort((a, b) => a.order - b.order)
  const results: PipelineStageResult[] = ordered.map((s) => ({
    name: s.name,
    type: s.type,
    status: 'skipped',
    duration: 0,
    output: '',
  }))
  let overall: 'success' | 'failed' = 'success'

  try {
    const project = await db.project.findUnique({
      where: { id: projectId },
      include: { server: true },
    })
    if (!project || !project.serverId) {
      throw new Error('Project has no server assigned — deploy it first.')
    }
    if (!project.containerName && !project.deployPath) {
      throw new Error('Project has not been deployed yet — nothing to run against.')
    }

    const creds = await getServerCredentials(project.serverId)
    await withConnection(creds, async (client) => {
      for (let i = 0; i < ordered.length; i++) {
        const stage = ordered[i]
        const resolved = resolveStage(stage)
        const t0 = Date.now()

        if (!resolved.command || resolved.problem) {
          results[i] = {
            name: stage.name,
            type: stage.type,
            status: 'failed',
            duration: 0,
            output: resolved.problem || 'No command configured for this stage.',
          }
          if (resolved.continueOnError) continue
          overall = 'failed'
          break
        }

        // Prefer running inside the project's container (its runtime + build
        // tools live there); fall back to the deploy path on the host.
        const wrapped = buildStageCommand(resolved, {
          containerName: project.containerName,
          deployPath: project.deployPath,
        })

        const r = await exec(client, wrapped, { timeoutMs: resolved.timeoutMs })
        const duration = Math.round((Date.now() - t0) / 1000)
        const out = (r.stdout || r.stderr || '').slice(-MAX_STAGE_OUTPUT)

        if (r.exitCode === 0) {
          results[i] = {
            name: stage.name,
            type: stage.type,
            status: 'success',
            duration,
            output: out || '(no output)',
          }
        } else {
          results[i] = {
            name: stage.name,
            type: stage.type,
            status: 'failed',
            duration,
            output:
              (out || `Command exited with code ${r.exitCode}`) +
              (resolved.continueOnError ? '\n(continuing: this stage may fail)' : ''),
          }
          // "Continue on error" records the failure but lets later stages
          // run, and does not fail the run on its own account.
          if (resolved.continueOnError) continue
          overall = 'failed'
          break // fail-fast: remaining stages stay 'skipped'
        }
      }
    })
  } catch (err) {
    overall = 'failed'
    const msg = err instanceof Error ? err.message : String(err)
    const idx = results.findIndex((s) => s.status === 'skipped')
    if (idx >= 0) {
      results[idx] = { ...results[idx], status: 'failed', output: `Pipeline error: ${msg}` }
    }
  }

  const completedAt = new Date()
  const duration = Math.round((Date.now() - startedMs) / 1000)
  try {
    await db.pipelineRun.update({
      where: { id: runId },
      data: { status: overall, stages: JSON.stringify(results), completedAt, duration },
    })
    await db.pipeline.update({
      where: { id: pipelineId },
      data: { lastRunAt: completedAt, lastRunStatus: overall },
    })
  } catch (e) {
    console.error('[pipeline] failed to persist run result', e)
  }
}

/**
 * Mark runs stuck in `running` past the stale window as `failed` (they were
 * orphaned by a panel restart). Cheap to call from the runs GET handler.
 */
export async function reconcileStaleRuns(pipelineId: string): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_STALE_MS)
  try {
    await db.pipelineRun.updateMany({
      where: { pipelineId, status: 'running', startedAt: { lt: cutoff } },
      data: { status: 'failed', completedAt: new Date() },
    })
  } catch {
    /* best-effort */
  }
}

/* ── Pre-deploy gate ───────────────────────────────────────────────────────
 *
 * The runner above executes stages with `docker exec` against the container
 * that is ALREADY RUNNING — that is, against the code already in production.
 * Useful for an ad-hoc command, useless as a check: by the time it runs, the
 * change it was meant to vet is live.
 *
 * This runs the same stages against the image that was just built and has not
 * been started yet, from inside the deploy stage, before the container is
 * swapped. A failure aborts the deployment, `docker compose up` never runs, and
 * the previous container keeps serving.
 *
 * `docker compose run --rm --no-deps app` is used rather than a raw
 * `docker run` so the checks see exactly the image, environment and network the
 * real service will get, without publishing its ports or starting its
 * dependencies.
 */

/**
 * Does this pipeline want to gate deployments?
 *
 * Only the explicit 'deploy' trigger does. This started out accepting 'push'
 * too, which was wrong twice over.
 *
 * Semantically: 'push' means "run this when new code arrives" — a CI run whose
 * result is information. Gating a release is a different, stronger request and
 * deserves to be asked for separately.
 *
 * Practically: 'active' and 'push' already existed and did nothing, so people
 * had set them with no idea a gate would later attach to them. Treating those
 * rows as gates changed the meaning of a setting under the customer and blocked
 * deployments they had every reason to expect to work — which is exactly what
 * happened to the first project that had one.
 *
 * 'deploy' is a value nothing set before this, so no existing pipeline can
 * start gating by surprise. Opting in has to be a decision.
 */
function gatesDeploys(pipeline: { status: string; triggerEvents: string }): boolean {
  if (pipeline.status !== 'active') return false
  let events: unknown = pipeline.triggerEvents
  try {
    const parsed = JSON.parse(pipeline.triggerEvents)
    if (Array.isArray(parsed)) events = parsed
  } catch {
    /* stored as a bare string */
  }
  const list = Array.isArray(events) ? events.map(String) : [String(events)]
  return list.includes('deploy')
}

export interface PreDeployResult {
  ok: boolean
  ran: number
  failures: string[]
}

/**
 * Run every active gating pipeline for this project against the freshly built
 * image. Returns ok:false with a human-readable reason for each failure.
 *
 * `client` is the caller's live SSH connection, so this adds no new session.
 */
export async function runPreDeployChecks(
  projectId: string,
  deployPath: string,
  client: Parameters<typeof exec>[0],
  opts: { commit?: string | null; branch?: string | null; onLog?: (m: string) => void } = {}
): Promise<PreDeployResult> {
  const log = (m: string) => opts.onLog?.(m)
  const out: PreDeployResult = { ok: true, ran: 0, failures: [] }

  const pipelines = await db.pipeline.findMany({ where: { projectId } })
  const gating = pipelines.filter(gatesDeploys)
  if (gating.length === 0) return out

  for (const pipeline of gating) {
    let stages: PipelineStageDef[] = []
    try {
      const parsed = JSON.parse(pipeline.stages)
      if (Array.isArray(parsed)) stages = parsed as PipelineStageDef[]
    } catch {
      /* malformed config is not a reason to block a deploy */
    }
    if (stages.length === 0) continue

    const ordered = [...stages].sort((a, b) => a.order - b.order)
    const results: PipelineStageResult[] = ordered.map((s) => ({
      name: s.name,
      type: s.type,
      status: 'skipped',
      duration: 0,
      output: '',
    }))

    const run = await db.pipelineRun.create({
      data: {
        pipelineId: pipeline.id,
        status: 'running',
        trigger: 'deploy',
        commit: opts.commit || null,
        branch: opts.branch || pipeline.triggerBranch,
        stages: JSON.stringify(results),
      },
      select: { id: true },
    })

    out.ran++
    const startedMs = Date.now()
    let overall: 'success' | 'failed' = 'success'
    log(`Pipeline "${pipeline.name}": ${ordered.length} check(s) against the new image`)

    for (let i = 0; i < ordered.length; i++) {
      const stage = ordered[i]
      const resolved = resolveStage(stage)
      const t0 = Date.now()
      if (!resolved.command || resolved.problem) {
        const why = resolved.problem || 'No command configured for this stage.'
        results[i] = { name: stage.name, type: stage.type, status: 'failed', duration: 0, output: why }
        if (resolved.continueOnError) continue
        overall = 'failed'
        out.failures.push(`${pipeline.name} → ${stage.name}: ${why}`)
        break
      }

      // Same env / working-directory handling as a manual run, but against a
      // throwaway container of the image about to be deployed.
      const envFlags = resolved.env.map(([k, v]) => `-e ${shellQuote(`${k}=${v}`)}`).join(' ')
      const inner = resolved.workingDir
        ? `cd ${shellQuote(resolved.workingDir)} && ${resolved.command}`
        : resolved.command
      const wrapped =
        `cd ${shellQuote(deployPath)} && docker compose run --rm --no-deps ${envFlags} ` +
        `--entrypoint sh app -c ${shellQuote(inner)} 2>&1`
      const r = await exec(client, wrapped, { timeoutMs: resolved.timeoutMs })
      const duration = Math.round((Date.now() - t0) / 1000)
      const output = (r.stdout || r.stderr || '').slice(-MAX_STAGE_OUTPUT)

      if (r.exitCode === 0) {
        results[i] = { name: stage.name, type: stage.type, status: 'success', duration, output: output || '(no output)' }
        log(`  ✓ ${stage.name} (${duration}s)`)
      } else if (resolved.continueOnError) {
        results[i] = { name: stage.name, type: stage.type, status: 'failed', duration, output: (output || `Command exited with code ${r.exitCode}`) + '\n(continuing: this stage may fail)' }
        log(`  ! ${stage.name} failed but may fail (${duration}s)`)
      } else {
        results[i] = { name: stage.name, type: stage.type, status: 'failed', duration, output: output || `Command exited with code ${r.exitCode}` }
        overall = 'failed'
        out.failures.push(`${pipeline.name} → ${stage.name} (exit ${r.exitCode})`)
        log(`  ✗ ${stage.name} failed (${duration}s)`)
        log(output.slice(-1500))
        break
      }
    }

    const completedAt = new Date()
    await db.pipelineRun
      .update({
        where: { id: run.id },
        data: {
          status: overall,
          stages: JSON.stringify(results),
          completedAt,
          duration: Math.round((Date.now() - startedMs) / 1000),
        },
      })
      .catch(() => {})
    await db.pipeline
      .update({ where: { id: pipeline.id }, data: { lastRunAt: completedAt, lastRunStatus: overall } })
      .catch(() => {})

    if (overall === 'failed') out.ok = false
  }

  return out
}
