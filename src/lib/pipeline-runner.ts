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

export interface PipelineStageDef {
  name: string
  type: string
  config?: { command?: string } & Record<string, unknown>
  order: number
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
        const command = stage.config?.command?.trim()
        const t0 = Date.now()

        if (!command) {
          results[i] = {
            name: stage.name,
            type: stage.type,
            status: 'failed',
            duration: 0,
            output: 'No command configured for this stage.',
          }
          overall = 'failed'
          break
        }

        // Prefer running inside the project's container (its runtime + build
        // tools live there); fall back to the deploy path on the host.
        const wrapped = project.containerName
          ? `docker exec ${shellQuote(project.containerName)} sh -c ${shellQuote(command)} 2>&1`
          : `cd ${shellQuote(project.deployPath!)} && ( ${command} ) 2>&1`

        const r = await exec(client, wrapped, { timeoutMs: STAGE_TIMEOUT_MS })
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
            output: out || `Command exited with code ${r.exitCode}`,
          }
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
