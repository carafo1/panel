/**
 * The migration pipeline.
 * ======================
 *
 * Takes a `SiteMigration` row and drives it from "customer clicked Import" to
 * "site is live on HTTPS", one recorded stage at a time.
 *
 * Three properties shape the whole design:
 *
 *  1. **It is resumable.** Every stage transition is persisted before the work
 *     starts, so a panel restart mid-import leaves an accurate record instead
 *     of a row stuck at 12%.
 *
 *  2. **It rolls back.** Any stage that mutates the server records a
 *     compensating action first. On failure the runner replays those in
 *     reverse. This is the difference between "your import failed, try again"
 *     and "your import failed and also your existing site is gone".
 *
 *  3. **It is honest about failure.** Stages that genuinely cannot proceed
 *     throw; stages that merely produced an imperfect result add a warning and
 *     continue. Clearing a cache is not worth failing a completed import over;
 *     importing the database is.
 */
import { db } from '@/lib/db'
import { encrypt, decrypt } from '@/lib/encryption'
import { getServerCredentials } from '@/lib/vps/provisioner'
import { isServerInDemoMode, withConnection, type SshCredentials } from '@/lib/vps/ssh'
import { provisionProjectDatabase, dropProjectDatabase } from '@/lib/vps/database'
import { configureProjectProxy, removeProjectProxy } from '@/lib/vps/proxy'
import { deployProject } from '@/lib/vps/deployer'
import { COMPOSE_ENV, composeProjectFlag } from '@/lib/vps/deploy-safety'
import { resolvePinnedTarget, buildSafeDownloadCommand, parseDownloadStatus } from './fetch-safety'
import { broadcastMigrationLog, broadcastMigrationStatus } from '@/lib/realtime'
import {
  exec,
  shellQuote,
  ensureRemoteDir,
  removeRemotePath,
  copyContents,
  writeRemoteText,
  putFileFromPath,
  probeTools,
  remoteExists,
  remoteIsDir,
  remoteSize,
  remoteFreeBytes,
  listDirs,
  listFileNames,
  findFilesBySize,
  type AnyClient,
  type RemoteToolset,
} from './remote'
import { extractPayload, cloneRepository, redactUrl } from './extract'
import { generateImportCompose, generateStaticNginxConf } from './compose'
import { detectSite, validateDetection } from './detect'
import {
  importSqlDump,
  rewriteSiteUrls,
  generateWpConfig,
  generatePhpIni,
  disableCaching,
  flushWordPressCaches,
  fixPermissions,
  repairWordPressInstall,
  wipeDatabaseTables,
  IN_CONTAINER_SQL_CLIENT,
  type WpDatabaseConfig,
  type WpImportContext,
} from './wordpress'
import { getUpload, markConsumed, formatBytes } from './uploads'
import {
  MIGRATION_STAGES,
  TOTAL_STAGE_WEIGHT,
  type DetectionResult,
  type MigrationRunOptions,
  type MigrationRunResult,
  type MigrationSourceType,
  type MigrationStageName,
  type StartMigrationOptions,
  type UndoAction,
} from './types'

// ─── Constants ────────────────────────────────────────────────────────────

/** Scratch space for in-flight migrations, one directory per migration. */
const MIGRATION_ROOT = process.env.MIGRATION_WORK_ROOT || '/opt/deployhub/migrations'
const PROJECT_ROOT = '/opt/deployhub/projects'
const DOCKER_NETWORK = process.env.DOCKER_NETWORK || 'deployhub'

/** Per-stage log cap. Enough to diagnose a failure, small enough to store. */
const MAX_STAGE_LOG = 64 * 1024

/**
 * Stacks the runner serves directly from an official image, with no build
 * step. Everything else is handed to the existing deployer, which already
 * knows how to build Node/Python/Laravel/Docker projects — duplicating that
 * here would mean two build pipelines drifting apart.
 */
const RUNTIME_SERVED_STACKS = new Set(['wordpress', 'php', 'static'])

// ─── Stage context ────────────────────────────────────────────────────────

interface StageContext {
  migrationId: string
  projectId: string
  userId: string
  sourceType: MigrationSourceType
  opts: StartMigrationOptions
  /** Scratch dir for this migration on the target server. */
  workDir: string
  /** Project directory (holds compose/config). */
  deployPath: string
  /** Directory the web server serves — `deployPath/site` for runtime-served stacks. */
  sitePath: string
  creds: SshCredentials | null
  demo: boolean
  tools: RemoteToolset | null
  detection: DetectionResult | null
  dbConfig: WpDatabaseConfig | null
  /** Local (panel-side) path of the uploaded payload, when there is one. */
  localPayload: string | null
  payloadFilename: string
  /** Remote path of the archive once transferred. */
  remoteArchive: string | null
  extractDir: string | null
  targetUrl: string
  originalUrl: string | null
  warnings: string[]
  log: (line: string) => void
}

type StageFn = (ctx: StageContext) => Promise<UndoAction | UndoAction[] | void>

// ─── Creation ─────────────────────────────────────────────────────────────

/**
 * Persist a new migration and its planned stages.
 *
 * Stages are created up-front, all `pending`, so the progress UI can render
 * the full checklist the instant the customer lands on it rather than growing
 * a list as work happens.
 */
export async function createMigration(
  opts: StartMigrationOptions
): Promise<{ migrationId: string }> {
  const project = await db.project.findUnique({ where: { id: opts.projectId } })
  if (!project) throw new Error('Project not found')

  const migration = await db.siteMigration.create({
    data: {
      projectId: opts.projectId,
      userId: opts.userId,
      sourceType: opts.sourceType,
      sourceMode: opts.sourceMode,
      sourceRef: redactUrl(opts.sourceRef),
      sizeBytes: opts.sizeBytes ?? null,
      originalUrl: opts.originalUrl ?? null,
      targetUrl: opts.targetUrl ?? `https://${project.customDomain || project.subdomain}`,
      status: 'pending',
      progress: 0,
      // The token is deliberately dropped before persisting: a retry re-reads
      // everything else, and a stored PAT is a credential leak waiting to
      // happen.
      options: JSON.stringify({ ...opts, gitToken: undefined }),
    },
  })

  await db.migrationStage.createMany({
    data: MIGRATION_STAGES.map((s, i) => ({
      migrationId: migration.id,
      name: s.name,
      label: s.label,
      status: 'pending',
      order: i,
    })),
  })

  return { migrationId: migration.id }
}

// ─── Run ──────────────────────────────────────────────────────────────────

/**
 * Execute a migration end to end.
 *
 * Returns a result object rather than throwing on import failure — the caller
 * is usually a fire-and-forget background task and a rejected promise there
 * would be an unhandled rejection, not a useful signal. Genuine programming
 * errors (missing project, no server) still throw.
 */
export async function runMigration(
  runOpts: MigrationRunOptions
): Promise<MigrationRunResult> {
  const started = Date.now()
  const { migrationId } = runOpts

  const migration = await db.siteMigration.findUnique({
    where: { id: migrationId },
    include: { project: { include: { server: true } } },
  })
  if (!migration) throw new Error(`Migration ${migrationId} not found`)
  const project = migration.project
  if (!project) throw new Error('Migration has no project')

  const opts: StartMigrationOptions = migration.options
    ? { ...(JSON.parse(migration.options) as StartMigrationOptions), gitToken: runOpts.gitToken }
    : {
        projectId: migration.projectId,
        userId: migration.userId,
        sourceType: migration.sourceType as MigrationSourceType,
        sourceMode: 'upload',
        sourceRef: migration.sourceRef || '',
      }

  const demo = isServerInDemoMode(project.server)
  const deployPath = project.deployPath || `${PROJECT_ROOT}/${project.slug}`
  const workDir = `${MIGRATION_ROOT}/${migrationId}`
  const targetUrl =
    migration.targetUrl || `https://${project.customDomain || project.subdomain}`

  // Rolling log buffer per stage. `stageLogs` is keyed by stage name so a
  // resumed run appends rather than replaces.
  const stageLogs = new Map<MigrationStageName, string[]>()
  let currentStage: MigrationStageName = 'prepare'

  const log = (line: string) => {
    const bucket = stageLogs.get(currentStage) ?? []
    const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`
    bucket.push(stamped)
    stageLogs.set(currentStage, bucket)
    runOpts.onLog?.(stamped)
    broadcastMigrationLog(migrationId, stamped)
  }

  const ctx: StageContext = {
    migrationId,
    projectId: project.id,
    userId: migration.userId,
    sourceType: migration.sourceType as MigrationSourceType,
    opts,
    workDir,
    deployPath,
    sitePath: deployPath, // narrowed once detection knows the stack
    creds: null,
    demo,
    tools: null,
    detection: null,
    dbConfig: null,
    localPayload: null,
    payloadFilename: 'backup.zip',
    remoteArchive: null,
    extractDir: null,
    targetUrl,
    originalUrl: migration.originalUrl || opts.originalUrl || null,
    warnings: [],
    log,
  }

  await db.siteMigration.update({
    where: { id: migrationId },
    data: {
      status: 'running',
      startedAt: migration.startedAt ?? new Date(),
      attempts: { increment: 1 },
      error: null,
    },
  })
  broadcastMigrationStatus(migrationId, project.id, 'running', 0)

  // Undo actions accumulate as stages complete; rollback replays them in
  // reverse insertion order.
  const undoStack: Array<{ stage: MigrationStageName; action: UndoAction }> = []

  /** Persist a stage row and stream its transition to the dashboard. */
  async function persistStage(
    name: MigrationStageName,
    data: Record<string, unknown>
  ): Promise<void> {
    const row = await db.migrationStage.findFirst({
      where: { migrationId, name },
    })
    if (row) {
      await db.migrationStage.update({ where: { id: row.id }, data }).catch(() => {})
    } else {
      await db.migrationStage
        .create({
          data: {
            migrationId,
            name,
            label: MIGRATION_STAGES.find((s) => s.name === name)?.label ?? name,
            order: MIGRATION_STAGES.findIndex((s) => s.name === name),
            ...data,
          },
        })
        .catch(() => {})
    }
  }

  function truncatedLog(name: MigrationStageName): string {
    const text = (stageLogs.get(name) ?? []).join('\n')
    return text.length > MAX_STAGE_LOG
      ? `…(${text.length - MAX_STAGE_LOG} earlier characters trimmed)\n` +
          text.slice(-MAX_STAGE_LOG)
      : text
  }

  /** Completed + skipped weight, as a percentage. */
  async function computeProgress(): Promise<number> {
    const done = await db.migrationStage.findMany({
      where: { migrationId, status: { in: ['completed', 'skipped'] } },
      select: { name: true },
    })
    const weight = done.reduce((sum, s) => {
      const def = MIGRATION_STAGES.find((d) => d.name === s.name)
      return sum + (def?.weight ?? 0)
    }, 0)
    return Math.min(100, Math.round((weight / TOTAL_STAGE_WEIGHT) * 100))
  }

  async function runStage(
    name: MigrationStageName,
    fn: StageFn,
    stageOpts: { skip?: boolean; skipReason?: string } = {}
  ): Promise<void> {
    const def = MIGRATION_STAGES.find((s) => s.name === name)!
    currentStage = name

    if (stageOpts.skip) {
      log(`Skipped — ${stageOpts.skipReason ?? 'not applicable'}`)
      await persistStage(name, {
        status: 'skipped',
        log: truncatedLog(name),
        finishedAt: new Date(),
      })
      const pct = await computeProgress()
      await db.siteMigration
        .update({ where: { id: migrationId }, data: { progress: pct, currentStage: name } })
        .catch(() => {})
      broadcastMigrationStatus(migrationId, project.id, 'running', pct, name)
      return
    }

    // A resumed run treats already-completed stages as done. Every stage is
    // written to be idempotent, but re-transferring a 10 GB archive because
    // the SSL step failed would be an expensive way to be safe.
    const existing = await db.migrationStage.findFirst({ where: { migrationId, name } })
    if (runOpts.resume && existing?.status === 'completed') {
      log(`Already completed on a previous attempt — skipping.`)
      return
    }

    const t0 = Date.now()
    await persistStage(name, {
      status: 'running',
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      durationMs: null,
    })
    await db.siteMigration
      .update({ where: { id: migrationId }, data: { currentStage: name } })
      .catch(() => {})
    log(def.label + '…')

    try {
      const undo = await fn(ctx)
      const actions = !undo ? [] : Array.isArray(undo) ? undo : [undo]
      for (const a of actions) undoStack.push({ stage: name, action: a })

      const duration = Date.now() - t0
      await persistStage(name, {
        status: 'completed',
        finishedAt: new Date(),
        durationMs: duration,
        log: truncatedLog(name),
        undo: actions.length ? JSON.stringify(actions) : null,
      })
      const pct = await computeProgress()
      await db.siteMigration
        .update({ where: { id: migrationId }, data: { progress: pct } })
        .catch(() => {})
      broadcastMigrationStatus(migrationId, project.id, 'running', pct, name)
      log(`Done (${formatDuration(duration)})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log(`FAILED: ${message}`)
      await persistStage(name, {
        status: 'failed',
        finishedAt: new Date(),
        durationMs: Date.now() - t0,
        error: message.slice(0, 2000),
        log: truncatedLog(name),
      })
      throw err
    }
  }

  // ── The pipeline ──────────────────────────────────────────────────
  try {
    await runStage('prepare', stagePrepare)
    await runStage('fetch', stageFetch, {
      skip: ctx.sourceType === 'git',
      skipReason: 'Source is a Git repository — nothing to transfer',
    })
    await runStage('extract', stageExtract)
    await runStage('detect', stageDetect)

    // Detection decides the rest of the plan, so the remaining stages are
    // configured from it.
    const detection = ctx.detection!
    const isWordPress = detection.stack === 'wordpress'
    const needsDatabase = isWordPress || detection.sqlFiles.length > 0
    const runtimeServed = RUNTIME_SERVED_STACKS.has(detection.stack)
    ctx.sitePath = runtimeServed ? `${deployPath}/site` : deployPath

    await runStage('snapshot', stageSnapshot)
    await runStage('create_db', stageCreateDatabase, {
      skip: !needsDatabase,
      skipReason: 'This site does not use a database',
    })
    await runStage('import_files', stageImportFiles)
    await runStage('import_sql', stageImportSql, {
      skip: detection.sqlFiles.length === 0,
      skipReason: 'No database dump in this backup',
    })
    await runStage('configure', stageConfigure)
    await runStage('rewrite_urls', stageRewriteUrls, {
      skip: !isWordPress || opts.skipUrlRewrite === true || !ctx.originalUrl,
      skipReason: !isWordPress
        ? 'URL rewriting only applies to WordPress'
        : opts.skipUrlRewrite
          ? 'Disabled for this import'
          : 'Original site URL is unknown — nothing to rewrite',
    })
    await runStage('permissions', stagePermissions)
    await runStage('deploy', stageDeploy)
    await runStage('proxy_ssl', stageProxySsl)
    await runStage('clear_cache', stageClearCache, {
      skip: !isWordPress,
      skipReason: 'Cache clearing only applies to WordPress',
    })
    await runStage('verify', stageVerify)
    await runStage('finalize', stageFinalize)

    const finalProgress = await computeProgress()
    await db.siteMigration.update({
      where: { id: migrationId },
      data: {
        status: 'completed',
        progress: Math.max(finalProgress, 100),
        completedAt: new Date(),
        currentStage: 'finalize',
        detection: JSON.stringify({ ...detection, warnings: ctx.warnings }),
        originalUrl: ctx.originalUrl,
        error: null,
      },
    })
    broadcastMigrationStatus(migrationId, project.id, 'completed', 100, 'finalize', targetUrl)

    // The scratch copy has served its purpose; the live site is the source of
    // truth now and the archive is often larger than the site itself.
    await cleanupWorkspace(ctx).catch(() => {})

    return {
      ok: true,
      migrationId,
      projectId: project.id,
      status: 'completed',
      url: targetUrl,
      rolledBack: false,
      durationMs: Date.now() - started,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    currentStage = 'finalize'

    let rolledBack = false
    try {
      log('Import failed — rolling back changes so the account is left as it was.')
      await applyRollback(ctx, undoStack, log)
      rolledBack = true
    } catch (rollbackErr) {
      const rbMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      log(`Rollback could not complete cleanly: ${rbMsg}`)
    }

    await db.siteMigration
      .update({
        where: { id: migrationId },
        data: {
          status: rolledBack ? 'rolled_back' : 'failed',
          error: message.slice(0, 2000),
          completedAt: new Date(),
          detection: ctx.detection
            ? JSON.stringify({ ...ctx.detection, warnings: ctx.warnings })
            : undefined,
        },
      })
      .catch(() => {})
    broadcastMigrationStatus(
      migrationId,
      project.id,
      rolledBack ? 'rolled_back' : 'failed',
      await computeProgress()
    )

    // The workspace is kept on failure: it holds the extracted tree a retry
    // can reuse, and it is the only evidence left for diagnosing what went
    // wrong. The sweeper removes it after a week.
    return {
      ok: false,
      migrationId,
      projectId: project.id,
      status: rolledBack ? 'rolled_back' : 'failed',
      error: message,
      rolledBack,
      durationMs: Date.now() - started,
    }
  }
}

// ═══ Stages ═══════════════════════════════════════════════════════════════

// ─── prepare ──────────────────────────────────────────────────────────────

const stagePrepare: StageFn = async (ctx) => {
  const project = await db.project.findUnique({
    where: { id: ctx.projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')
  if (!project.serverId) {
    throw new Error(
      'This website has no server assigned yet. Finish creating it before importing.'
    )
  }

  if (ctx.demo) {
    ctx.log('Running in demo mode — no server is attached, so steps are simulated.')
    await sleep(400)
    return
  }

  ctx.creds = await getServerCredentials(project.serverId)

  // Resolve the payload on the panel side before touching the server, so a
  // missing upload fails in milliseconds.
  if (ctx.opts.sourceMode === 'upload') {
    const upload = await getUpload(ctx.opts.sourceRef, ctx.userId, { allowAnyOwner: true })
    if (!upload) {
      throw new Error(
        'The uploaded backup is no longer available. Uploads are kept for 48 hours — please upload it again.'
      )
    }
    if (!upload.complete) {
      throw new Error('The upload never finished. Please upload the backup again.')
    }
    ctx.localPayload = upload.storedPath
    ctx.payloadFilename = upload.filename
    await markConsumed(upload.uploadId, ctx.migrationId)
  }

  await withConnection(ctx.creds, async (client) => {
    ctx.tools = await probeTools(client)
    ctx.log(
      `Server tools: ${Object.entries(ctx.tools)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ') || 'none detected'}`
    )
    if (!ctx.tools.docker) {
      throw new Error(
        'Docker is not available on the target server, so the imported site cannot be started.'
      )
    }

    await ensureRemoteDir(client, ctx.workDir)
    await ensureRemoteDir(client, `${ctx.workDir}/rollback`)

    // Disk check. An import needs room for the archive, the extracted tree,
    // and the copy into the project directory — roughly three times the
    // archive size. Running out halfway leaves a truncated site, so it is
    // worth refusing up front.
    const free = await remoteFreeBytes(client, MIGRATION_ROOT)
    const needed = (ctx.opts.sizeBytes ?? 0) * 3
    if (free > 0 && needed > 0 && free < needed) {
      throw new Error(
        `Not enough disk space on the server: ${formatBytes(free)} free, about ${formatBytes(needed)} needed to import a ${formatBytes(ctx.opts.sizeBytes ?? 0)} backup.`
      )
    }
    if (free > 0) ctx.log(`Disk space available: ${formatBytes(free)}`)
  })

  return { type: 'rmdir', path: ctx.workDir }
}

// ─── fetch ────────────────────────────────────────────────────────────────

const stageFetch: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(900)
    ctx.log(`Transferred ${formatBytes(ctx.opts.sizeBytes ?? 52_428_800)} to the server.`)
    return
  }

  if (ctx.opts.sourceMode === 'url') {
    // Remote fetch. The API layer checked the URL, but that was minutes ago
    // and by name: re-check now and pin curl to the checked address, with no
    // redirects (lib/migration/fetch-safety) — otherwise a redirect or a DNS
    // rebind reaches cloud metadata or the host's own services as root.
    const dest = `${ctx.workDir}/${sanitizeRemoteName(ctx.opts.sourceRef)}`
    const target = await resolvePinnedTarget(ctx.opts.sourceRef)
    await withConnection(ctx.creds!, async (client) => {
      ctx.log(`Downloading ${redactUrl(ctx.opts.sourceRef)}…`)
      const r = await exec(
        client,
        buildSafeDownloadCommand(ctx.opts.sourceRef, dest, target),
        { timeoutMs: 3_600_000 }
      )
      const { status, redirect } = parseDownloadStatus(r.stdout || '')
      if (r.exitCode !== 0 || status < 200 || status >= 300) {
        await exec(client, `rm -f ${shellQuote(dest)}`, { timeoutMs: 30_000 }).catch(() => {})
        if (status >= 300 && status < 400) {
          throw new Error(
            'Download failed: the link redirects' +
              (redirect ? ` to ${redactUrl(redirect)}` : '') +
              '. Redirects are not followed for security — use the final direct download link.'
          )
        }
        throw new Error(
          `Download failed${status ? ` (HTTP ${status})` : ''}: ${redactUrl(r.stdout || r.stderr || '').slice(-300)}`
        )
      }
      const size = await remoteSize(client, dest)
      ctx.log(`Downloaded ${formatBytes(size)}.`)
      ctx.remoteArchive = dest
      ctx.payloadFilename = sanitizeRemoteName(ctx.opts.sourceRef)
    })
    return
  }

  if (!ctx.localPayload) throw new Error('No uploaded backup to transfer')

  const remote = `${ctx.workDir}/${ctx.payloadFilename}`
  await withConnection(ctx.creds!, async (client) => {
    ctx.log(`Uploading ${ctx.payloadFilename} to the server…`)
    let lastPct = -1
    await putFileFromPath(client, ctx.localPayload!, remote, {
      mode: 0o600,
      onProgress: (sent, total) => {
        if (!total) return
        const pct = Math.floor((sent / total) * 100)
        // Log every 10% — one line per chunk would flood the log with
        // thousands of entries for a large archive.
        if (pct >= lastPct + 10) {
          lastPct = pct
          ctx.log(`  ${pct}% (${formatBytes(sent)} of ${formatBytes(total)})`)
        }
      },
    })
    const size = await remoteSize(client, remote)
    if (size === 0) throw new Error('The transferred archive is empty.')
    ctx.log(`Transfer complete — ${formatBytes(size)} on the server.`)
  })
  ctx.remoteArchive = remote

  // Also handle the second upload used by the files+SQL flow.
  if (ctx.opts.sqlUploadId) {
    const sqlUpload = await getUpload(ctx.opts.sqlUploadId, ctx.userId, {
      allowAnyOwner: true,
    })
    if (sqlUpload) {
      const sqlRemote = `${ctx.workDir}/${sqlUpload.filename}`
      await withConnection(ctx.creds!, async (client) => {
        ctx.log(`Uploading database dump ${sqlUpload.filename}…`)
        await putFileFromPath(client, sqlUpload.storedPath, sqlRemote, { mode: 0o600 })
      })
      await markConsumed(sqlUpload.uploadId, ctx.migrationId)
    } else {
      ctx.warnings.push('The separate SQL upload was not found and has been skipped.')
    }
  }
}

// ─── extract ──────────────────────────────────────────────────────────────

const stageExtract: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(1100)
    ctx.extractDir = `${ctx.workDir}/extracted`
    ctx.log('Archive extracted — 4,812 files, 312 folders.')
    return
  }

  await withConnection(ctx.creds!, async (client) => {
    if (ctx.sourceType === 'git') {
      const result = await cloneRepository(client, {
        repoUrl: ctx.opts.sourceRef,
        branch: ctx.opts.gitBranch,
        token: ctx.opts.gitToken,
        workDir: ctx.workDir,
        onLog: ctx.log,
      })
      ctx.extractDir = result.extractDir
      ctx.warnings.push(...result.warnings)
      return
    }

    if (!ctx.remoteArchive) throw new Error('No archive on the server to extract')

    const result = await extractPayload(client, {
      archivePath: ctx.remoteArchive,
      filename: ctx.payloadFilename,
      sourceType: ctx.sourceType,
      workDir: ctx.workDir,
      tools: ctx.tools ?? undefined,
      onLog: ctx.log,
    })
    ctx.extractDir = result.extractDir
    ctx.warnings.push(...result.warnings)

    // A separately-uploaded dump lives beside the archive, not inside it.
    if (ctx.opts.sqlUploadId) {
      const names = await listFileNames(client, ctx.workDir)
      for (const n of names) {
        if (/\.sql(\.gz)?$/i.test(n)) {
          result.sqlFiles.unshift(`${ctx.workDir}/${n}`)
          ctx.log(`Using the separately uploaded dump: ${n}`)
        }
      }
    }
    // Stash the list for the detect stage rather than re-scanning.
    ;(ctx as StageContext & { _sqlFiles?: string[] })._sqlFiles = result.sqlFiles

    // The archive is now redundant and is often the largest thing on disk.
    await exec(client, `rm -f ${shellQuote(ctx.remoteArchive)}`, { timeoutMs: 120_000 })
  })
}

// ─── detect ───────────────────────────────────────────────────────────────

const stageDetect: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(600)
    ctx.detection = demoDetection(ctx)
    ctx.originalUrl = ctx.detection.wordpress?.siteUrl ?? ctx.originalUrl
    ctx.log(`Detected WordPress ${ctx.detection.wordpress?.version} at ${ctx.originalUrl}`)
    await db.siteMigration
      .update({
        where: { id: ctx.migrationId },
        data: { detection: JSON.stringify(ctx.detection), originalUrl: ctx.originalUrl },
      })
      .catch(() => {})
    return
  }

  let stashed = (ctx as StageContext & { _sqlFiles?: string[] })._sqlFiles ?? []

  await withConnection(ctx.creds!, async (client) => {
    // On a resumed run the extract stage is skipped, so the in-memory list of
    // dumps it found is gone. Rescanning is cheap next to the alternative:
    // detection would report "no database in this backup" and the import would
    // quietly produce a site with no content.
    if (stashed.length === 0) {
      const found = await findFilesBySize(client, `${ctx.workDir}/extracted`, '*.sql', {
        limit: 30,
      })
      stashed = found
        .filter((f) => !/\/wp-content\/(uploads|ai1wm-backups|updraft|backup)/i.test(f.path))
        .map((f) => f.path)
      if (stashed.length > 0) {
        ctx.log(`Re-scanned the workspace and found ${stashed.length} SQL dump(s).`)
      }
    }

    const detection = await detectSite(client, {
      extractDir: ctx.extractDir!,
      sqlFiles: stashed,
      sourceType: ctx.sourceType,
      priorWarnings: ctx.warnings,
      onLog: ctx.log,
    })
    ctx.detection = detection
    ctx.warnings = detection.warnings
  })

  const issues = validateDetection(ctx.detection!, {
    requireDatabase: ctx.sourceType === 'files-sql' && Boolean(ctx.opts.sqlUploadId),
  })
  const blockers = issues.filter((i) => i.level === 'error')
  for (const i of issues) {
    ctx.log(`${i.level === 'error' ? 'ERROR' : 'Warning'}: ${i.message}`)
  }
  if (blockers.length > 0) {
    throw new Error(blockers.map((b) => b.message).join(' '))
  }

  // Collapse 'unknown' to 'static' as soon as validation has passed.
  //
  // Downstream, two separate decisions read the stack: which runtime serves
  // the site, and which deployment method the Project row records. Leaving
  // 'unknown' in place made them disagree — the project was recorded as a
  // static site while the runner handed it to the image-building pipeline,
  // which has nothing to build. Normalising here keeps one answer.
  if (ctx.detection!.stack === 'unknown') {
    ctx.log('Unrecognised site type — serving the uploaded files as a static site.')
    ctx.detection!.stack = 'static'
  }

  // Prefer the URL the customer supplied; fall back to what the dump says.
  ctx.originalUrl =
    ctx.opts.originalUrl || ctx.detection!.wordpress?.siteUrl || ctx.originalUrl

  await db.siteMigration
    .update({
      where: { id: ctx.migrationId },
      data: {
        detection: JSON.stringify(ctx.detection),
        originalUrl: ctx.originalUrl,
        status: 'running',
      },
    })
    .catch(() => {})
}

// ─── snapshot ─────────────────────────────────────────────────────────────

/**
 * Tar the current project directory before overwriting it.
 *
 * Most imports target an empty project, in which case this is a no-op. But
 * "re-import over my existing site" is a real and reasonable thing to do, and
 * without a snapshot a failure at the SQL stage would leave the customer with
 * neither their old site nor the new one.
 */
const stageSnapshot: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(400)
    ctx.log('Project directory is empty — no snapshot needed.')
    return
  }

  let undo: UndoAction | undefined
  await withConnection(ctx.creds!, async (client) => {
    if (!(await remoteIsDir(client, ctx.deployPath))) {
      ctx.log('Nothing to snapshot — this is a fresh project directory.')
      await ensureRemoteDir(client, ctx.deployPath)
      return
    }
    const entries = [
      ...(await listFileNames(client, ctx.deployPath)),
      ...(await listDirs(client, ctx.deployPath)),
    ]
    if (entries.length === 0) {
      ctx.log('Nothing to snapshot — the project directory is empty.')
      return
    }

    const tarball = `${ctx.workDir}/rollback/site-before-import.tar.gz`
    const size = await remoteSize(client, ctx.deployPath)
    ctx.log(`Snapshotting the existing site (${formatBytes(size)}) so it can be restored…`)
    const r = await exec(
      client,
      `tar -czf ${shellQuote(tarball)} -C ${shellQuote(ctx.deployPath)} . 2>/dev/null`,
      { timeoutMs: 3_600_000 }
    )
    // tar exits 1 for "file changed as we read it", which is expected on a
    // live site and does not invalidate the archive.
    if (r.exitCode !== 0 && r.exitCode !== 1) {
      throw new Error(`Snapshot failed: ${r.stderr.slice(-300)}`)
    }
    ctx.log(`Snapshot saved (${formatBytes(await remoteSize(client, tarball))}).`)
    undo = { type: 'restore_path', path: ctx.deployPath, tarball }
  })

  // Also record the Project columns we are about to change, so rollback can
  // put the row back exactly as it was.
  const before = await db.project.findUnique({
    where: { id: ctx.projectId },
    select: {
      status: true,
      framework: true,
      stack: true,
      deploymentMethod: true,
      deploymentSource: true,
      runtime: true,
      runtimeVersion: true,
      documentRoot: true,
      appPort: true,
      containerName: true,
      containerPort: true,
      externalPort: true,
      deployPath: true,
      databaseType: true,
      databaseName: true,
      databaseUser: true,
      databasePassword: true,
      databaseHost: true,
      databasePort: true,
    },
  })

  const actions: UndoAction[] = []
  if (undo) actions.push(undo)
  if (before) actions.push({ type: 'restore_project', fields: before })
  return actions
}

// ─── create_db ────────────────────────────────────────────────────────────

const stageCreateDatabase: StageFn = async (ctx) => {
  const project = await db.project.findUnique({ where: { id: ctx.projectId } })
  if (!project) throw new Error('Project not found')

  const prefix = ctx.detection?.wordpress?.tablePrefix || 'wp_'

  if (ctx.demo) {
    await sleep(700)
    ctx.dbConfig = {
      host: `deployhub-db-${project.slug}`,
      port: 3306,
      name: `wp_${project.slug.replace(/[^a-z0-9]/g, '').slice(0, 8)}`,
      user: `wp_${project.slug.replace(/[^a-z0-9]/g, '').slice(0, 8)}`,
      password: 'demo-password',
      tablePrefix: prefix,
      container: `deployhub-db-${project.slug}`,
    }
    ctx.log(`Created MariaDB database ${ctx.dbConfig.name}.`)
    return
  }

  // Reuse path — the customer asked to import into the database this project
  // already has. We must be able to undo that by emptying it, since dropping
  // a database we did not create would destroy data outside this import.
  if (ctx.opts.reuseDatabase && project.databaseName && project.databasePassword) {
    ctx.dbConfig = {
      host: project.databaseHost || 'db',
      port: project.databasePort ?? 3306,
      name: project.databaseName,
      user: project.databaseUser || 'wp',
      password: safeDecrypt(project.databasePassword),
      tablePrefix: prefix,
      container: project.databaseHost,
    }
    ctx.log(`Reusing the existing database ${ctx.dbConfig.name}.`)
    return {
      type: 'wipe_database',
      databaseName: ctx.dbConfig.name,
      container: ctx.dbConfig.container || '',
    }
  }

  const provisioned = await provisionProjectDatabase(ctx.projectId, {
    type: 'mariadb',
    onLog: ctx.log,
  })
  await db.project.update({
    where: { id: ctx.projectId },
    data: {
      databaseType: provisioned.type,
      databaseName: provisioned.name,
      databaseUser: provisioned.username,
      databasePassword: encrypt(provisioned.password),
      databaseHost: provisioned.host,
      databasePort: provisioned.port,
    },
  })
  ctx.dbConfig = {
    host: provisioned.host,
    port: provisioned.port,
    name: provisioned.name,
    user: provisioned.username,
    password: provisioned.password,
    tablePrefix: prefix,
    container: provisioned.externalRef || provisioned.host,
  }
  ctx.log(`Database ${provisioned.name} ready on ${provisioned.host}.`)

  const row = await db.websiteDatabase.findFirst({
    where: { projectId: ctx.projectId, name: provisioned.name },
    select: { id: true },
  })
  return row ? { type: 'drop_database', databaseId: row.id } : undefined
}

// ─── import_files ─────────────────────────────────────────────────────────

const stageImportFiles: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(1200)
    ctx.log(`Copied 4,812 files into ${ctx.sitePath}.`)
    return
  }

  await withConnection(ctx.creds!, async (client) => {
    await ensureRemoteDir(client, ctx.sitePath)

    // Clear the destination first. Merging an import into leftover files from
    // a previous site produces a hybrid that boots but behaves unpredictably —
    // old plugins loading against new core, stale drop-ins, orphaned themes.
    const existing = [
      ...(await listFileNames(client, ctx.sitePath)),
      ...(await listDirs(client, ctx.sitePath)),
    ]
    if (existing.length > 0) {
      ctx.log(`Clearing ${existing.length} existing item(s) from the target directory…`)
      await exec(
        client,
        `find ${shellQuote(ctx.sitePath)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true`,
        { timeoutMs: 600_000 }
      )
    }

    const size = await remoteSize(client, ctx.extractDir!)
    ctx.log(`Copying ${formatBytes(size)} of website files…`)
    await copyContents(client, ctx.extractDir!, ctx.sitePath)

    // A wp-config.php from the old host names a database that does not exist
    // here. It is replaced in the `configure` stage, but move it aside now so
    // a failure between here and there cannot leave the wrong credentials in
    // place.
    const oldConfig = `${ctx.sitePath}/wp-config.php`
    if (await remoteExists(client, oldConfig)) {
      await exec(
        client,
        `mv -f ${shellQuote(oldConfig)} ${shellQuote(oldConfig + '.imported')}`,
        { timeoutMs: 30000 }
      )
      ctx.log('Kept the original wp-config.php as wp-config.php.imported for reference.')
    }

    const count = await exec(
      client,
      `find ${shellQuote(ctx.sitePath)} -type f | wc -l`,
      { timeoutMs: 300_000 }
    )
    ctx.log(`${count.stdout.trim()} file(s) in place.`)
  })
}

// ─── import_sql ───────────────────────────────────────────────────────────

const stageImportSql: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(1500)
    ctx.log('Imported 34 tables (18.2 MB).')
    return
  }
  if (!ctx.dbConfig) throw new Error('No database was created for this import')

  const dump = ctx.detection!.sqlFiles[0]
  if (!dump) throw new Error('No SQL dump to import')

  const result = await withConnection(ctx.creds!, async (client) =>
    importSqlDump(client, dump, ctx.dbConfig!, { onLog: ctx.log })
  )

  // If the dump's tables use a different prefix than wp-config will declare,
  // the site boots to a fresh-install screen and looks like the import lost
  // everything. Detect and correct rather than shipping a broken site.
  if (ctx.detection!.stack === 'wordpress') {
    await withConnection(ctx.creds!, async (client) => {
      const r = await exec(
        client,
        `docker exec -e MYSQL_PWD=${shellQuote(ctx.dbConfig!.password)} ${shellQuote(ctx.dbConfig!.container || '')} sh -c ` +
          shellQuote(
            `${IN_CONTAINER_SQL_CLIENT} -N -B -h 127.0.0.1 -u ${shellQuote(ctx.dbConfig!.user)} -e ` +
              shellQuote(
                `SELECT table_name FROM information_schema.tables WHERE table_schema='${ctx.dbConfig!.name}' AND table_name LIKE '%options' LIMIT 5`
              )
          ),
        { timeoutMs: 120_000 }
      )
      const table = r.stdout.trim().split('\n')[0]?.trim()
      if (table && table.endsWith('options')) {
        const actual = table.slice(0, -'options'.length)
        if (actual && actual !== ctx.dbConfig!.tablePrefix) {
          ctx.log(
            `Table prefix in the dump is "${actual}", not "${ctx.dbConfig!.tablePrefix}" — using the dump's prefix.`
          )
          ctx.dbConfig!.tablePrefix = actual
        }
      }
    })
  }

  ctx.log(`${result.tablesImported} table(s) imported.`)
}

// ─── configure ────────────────────────────────────────────────────────────

const stageConfigure: StageFn = async (ctx) => {
  const project = await db.project.findUnique({ where: { id: ctx.projectId } })
  if (!project) throw new Error('Project not found')
  const detection = ctx.detection!
  const runtimeServed = RUNTIME_SERVED_STACKS.has(detection.stack)

  // Reflect what we actually found onto the project row, so the rest of the
  // panel (files tab, deploys, backups) treats the site correctly.
  await db.project.update({
    where: { id: ctx.projectId },
    data: {
      framework: detection.stack,
      stack: detection.stack,
      deploymentMethod: mapStackToMethod(detection.stack),
      // Tells the deployer these files were placed by an import and must not
      // be replaced with a placeholder app.
      deploymentSource: 'imported',
      runtime: detection.runtime ?? runtimeForStack(detection.stack),
      documentRoot: detection.documentRoot,
      deployPath: ctx.deployPath,
      status: 'deploying',
    },
  })

  if (ctx.demo) {
    await sleep(500)
    ctx.log('Wrote wp-config.php, php.ini and docker-compose.yml.')
    return
  }

  await withConnection(ctx.creds!, async (client) => {
    await ensureRemoteDir(client, ctx.deployPath)

    // PHP tuning, mounted read-only into the container.
    if (detection.stack === 'wordpress' || detection.stack === 'php') {
      await writeRemoteText(client, `${ctx.deployPath}/php.ini`, generatePhpIni(), {
        mode: 0o644,
      })
      ctx.log('Wrote PHP configuration (256 MB uploads, 512 MB memory, 300 s timeout).')
    }

    if (detection.stack === 'static') {
      // The static compose mounts this file. Without it Docker creates a
      // directory at the mount path and nginx refuses to start, so the two
      // are written as a pair.
      await writeRemoteText(
        client,
        `${ctx.deployPath}/nginx.conf`,
        generateStaticNginxConf(detection.documentRoot),
        { mode: 0o644 }
      )
      ctx.log('Wrote nginx configuration for the static site.')
    }

    if (detection.stack === 'wordpress' && ctx.dbConfig) {
      const config = generateWpConfig({
        db: ctx.dbConfig,
        siteUrl: ctx.targetUrl,
      })
      await writeRemoteText(client, `${ctx.sitePath}/wp-config.php`, config, {
        mode: 0o640,
      })
      ctx.log(
        `Wrote wp-config.php (database ${ctx.dbConfig.name}, table prefix "${ctx.dbConfig.tablePrefix}").`
      )
    }

    if (runtimeServed) {
      const containerName = project.containerName || `deployhub-${project.slug}`
      const externalPort = project.externalPort ?? (await pickPort(project.serverId!))
      const compose = generateImportCompose({
        stack: detection.stack,
        containerName,
        externalPort,
        documentRoot: detection.documentRoot,
        cpuCores: project.resourceCpuCores,
        ramMB: project.resourceRamMB,
      })
      await writeRemoteText(client, `${ctx.deployPath}/docker-compose.yml`, compose, {
        mode: 0o644,
      })
      await db.project.update({
        where: { id: ctx.projectId },
        data: {
          containerName,
          containerPort: 80,
          externalPort,
        },
      })
      ctx.log(`Wrote docker-compose.yml (${containerName} on host port ${externalPort}).`)
    }
  })
}

// ─── rewrite_urls ─────────────────────────────────────────────────────────

const stageRewriteUrls: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(900)
    ctx.log(`Rewrote 1,284 references from ${ctx.originalUrl} to ${ctx.targetUrl}.`)
    return
  }
  if (!ctx.dbConfig || !ctx.originalUrl) return

  const wpCtx: WpImportContext = {
    sitePath: ctx.sitePath,
    db: ctx.dbConfig,
    onLog: ctx.log,
  }
  const result = await withConnection(ctx.creds!, async (client) =>
    rewriteSiteUrls(client, wpCtx, ctx.originalUrl!, ctx.targetUrl, {
      dockerNetwork: DOCKER_NETWORK,
    })
  )
  ctx.warnings.push(...result.warnings)
  ctx.log(
    `URL rewrite complete via ${result.method} — ${result.replacements} replacement(s).`
  )
}

// ─── permissions ──────────────────────────────────────────────────────────

const stagePermissions: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(500)
    ctx.log('Ownership set to www-data, directories 755, files 644, wp-config 640.')
    return
  }
  await withConnection(ctx.creds!, async (client) => {
    await fixPermissions(client, ctx.sitePath, {
      onLog: ctx.log,
      wordpress: ctx.detection!.stack === 'wordpress',
    })
  })
}

// ─── deploy ───────────────────────────────────────────────────────────────

const stageDeploy: StageFn = async (ctx) => {
  const project = await db.project.findUnique({ where: { id: ctx.projectId } })
  if (!project) throw new Error('Project not found')
  const runtimeServed = RUNTIME_SERVED_STACKS.has(ctx.detection!.stack)

  if (ctx.demo) {
    await sleep(1300)
    await db.project.update({
      where: { id: ctx.projectId },
      data: {
        status: 'running',
        containerName: project.containerName || `deployhub-${project.slug}`,
        containerPort: 80,
        deployPath: ctx.deployPath,
        lastDeployedAt: new Date(),
      },
    })
    ctx.log('Container started and healthy.')
    return
  }

  if (!runtimeServed) {
    // Node/Python/Laravel/Docker imports go through the existing deployer,
    // which builds an image from the files we just placed. `deploymentSource`
    // is 'imported', so its source stage leaves them alone.
    ctx.log(`Handing off to the ${ctx.detection!.stack} build pipeline…`)
    // Deployment.userId means the project OWNER (lists, reinstatement and the
    // assistant read it that way). ctx.userId is whoever started the import,
    // which for a shared project may be a team member.
    const owner = await db.project.findUnique({
      where: { id: ctx.projectId },
      select: { userId: true },
    })
    const deployment = await db.deployment.create({
      data: {
        projectId: ctx.projectId,
        userId: owner?.userId ?? ctx.userId,
        commit: `import-${ctx.migrationId.slice(0, 8)}`,
        branch: ctx.opts.gitBranch || 'main',
        status: 'queued',
        triggeredBy: 'migration',
        buildLog: `Imported site — building ${ctx.detection!.stack} project.`,
      },
    })
    const result = await deployProject({
      projectId: ctx.projectId,
      deploymentId: deployment.id,
      onLog: ctx.log,
    })
    if (!result.ok) {
      throw new Error(result.error || 'The build pipeline failed for the imported project.')
    }
    return {
      type: 'remove_container',
      name: result.containerName || `deployhub-${project.slug}`,
      composePath: ctx.deployPath,
    }
  }

  const containerName = project.containerName || `deployhub-${project.slug}`
  await withConnection(ctx.creds!, async (client) => {
    // The shared network must exist before compose references it as external.
    await exec(
      client,
      `docker network inspect ${shellQuote(DOCKER_NETWORK)} >/dev/null 2>&1 || docker network create ${shellQuote(DOCKER_NETWORK)}`,
      { timeoutMs: 60_000 }
    )
    // Remove any container left from a previous attempt; `compose up` would
    // otherwise fail on the name conflict.
    await exec(client, `docker rm -f ${shellQuote(containerName)} >/dev/null 2>&1 || true`, {
      timeoutMs: 120_000,
    })

    ctx.log('Starting the website container…')
    const r = await exec(
      client,
      // Stripped environment and a pinned project name, exactly as the
      // deployer runs compose (see lib/vps/deploy-safety).
      `cd ${shellQuote(ctx.deployPath)} && (${COMPOSE_ENV}docker compose ${composeProjectFlag(ctx.deployPath)}up -d 2>&1 || ` +
        `${COMPOSE_ENV}docker-compose ${composeProjectFlag(ctx.deployPath)}up -d 2>&1)`,
      { timeoutMs: 900_000 }
    )
    if (r.exitCode !== 0) {
      throw new Error(`Could not start the container: ${(r.stdout || r.stderr).slice(-500)}`)
    }
    ctx.log(r.stdout.trim().split('\n').slice(-4).join('\n'))

    const idResult = await exec(
      client,
      `docker inspect --format '{{.Id}}' ${shellQuote(containerName)} 2>/dev/null || true`,
      { timeoutMs: 30_000 }
    )
    const containerId = idResult.stdout.trim() || null

    await db.project.update({
      where: { id: ctx.projectId },
      data: {
        containerId,
        containerName,
        containerPort: 80,
        deployPath: ctx.deployPath,
        status: 'running',
        lastDeployedAt: new Date(),
      },
    })
  })

  return {
    type: 'remove_container',
    name: containerName,
    composePath: ctx.deployPath,
  }
}

// ─── proxy_ssl ────────────────────────────────────────────────────────────

const stageProxySsl: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(700)
    ctx.log(`Routed ${ctx.targetUrl} and requested a Let's Encrypt certificate.`)
    return
  }

  await configureProjectProxy(ctx.projectId, { onLog: ctx.log })
  ctx.log(
    `${ctx.targetUrl} is routed to the site. Caddy obtains the Let's Encrypt certificate on the first HTTPS request.`
  )
  await db.project
    .update({
      where: { id: ctx.projectId },
      data: { sslCertStatus: 'pending' },
    })
    .catch(() => {})

  return { type: 'remove_proxy', projectId: ctx.projectId }
}

// ─── clear_cache ──────────────────────────────────────────────────────────

const stageClearCache: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(500)
    ctx.log('Disabled 2 caching plugins and flushed the object cache.')
    return
  }
  if (!ctx.dbConfig) return

  const wpCtx: WpImportContext = {
    sitePath: ctx.sitePath,
    db: ctx.dbConfig,
    onLog: ctx.log,
  }

  await withConnection(ctx.creds!, async (client) => {
    if (ctx.opts.disableCachePlugins !== false) {
      const plugins = ctx.detection!.wordpress?.cachePlugins ?? []
      const { disabled } = await disableCaching(client, ctx.sitePath, plugins, {
        onLog: ctx.log,
      })
      if (disabled.length > 0) {
        ctx.warnings.push(
          `Caching plugins were disabled during import (${disabled.join(', ')}). Re-enable them from wp-admin once the site looks correct.`
        )
      }
    }
    // These run against a container that is already serving, so a failure is
    // cosmetic — logged inside, never thrown.
    await flushWordPressCaches(client, wpCtx, { network: DOCKER_NETWORK })
    const notes = await repairWordPressInstall(client, wpCtx, {
      network: DOCKER_NETWORK,
      siteUrl: ctx.targetUrl,
    })
    for (const n of notes) ctx.log(n)

    // .htaccess was just rewritten as root; hand it back to the web server.
    await exec(
      client,
      `chown 33:33 ${shellQuote(`${ctx.sitePath}/.htaccess`)} 2>/dev/null || true`,
      { timeoutMs: 30_000 }
    )
  })
}

// ─── verify ───────────────────────────────────────────────────────────────

/**
 * Prove the site actually answers before telling the customer it is live.
 *
 * The request goes to the container's published port with the real Host
 * header, which exercises the app without depending on DNS having propagated
 * to the new server yet — the customer may not have repointed their domain.
 */
const stageVerify: StageFn = async (ctx) => {
  if (ctx.demo) {
    await sleep(800)
    ctx.log('HTTP 200 · WordPress responded in 240 ms.')
    return
  }

  const project = await db.project.findUnique({ where: { id: ctx.projectId } })
  if (!project?.externalPort || !project.containerName) {
    ctx.log('No published port to check — skipping the HTTP verification.')
    return
  }
  const host = project.customDomain || project.subdomain

  await withConnection(ctx.creds!, async (client) => {
    let lastStatus = '000'
    let body = ''
    for (let attempt = 0; attempt < 20; attempt++) {
      const r = await exec(
        client,
        `curl -sS -m 15 -o /tmp/apsamo-verify-${ctx.migrationId}.html -w '%{http_code}' -H ${shellQuote(`Host: ${host}`)} http://127.0.0.1:${project.externalPort}/ 2>/dev/null || echo 000`,
        { timeoutMs: 30_000 }
      )
      lastStatus = r.stdout.trim().slice(-3)
      if (/^(200|301|302|304)$/.test(lastStatus)) {
        const b = await exec(
          client,
          `head -c 4000 /tmp/apsamo-verify-${ctx.migrationId}.html 2>/dev/null || true`,
          { timeoutMs: 20_000 }
        )
        body = b.stdout
        break
      }
      await sleep(3000)
    }
    await exec(client, `rm -f /tmp/apsamo-verify-${ctx.migrationId}.html`, {
      timeoutMs: 15_000,
    })

    if (!/^(200|301|302|304)$/.test(lastStatus)) {
      throw new Error(
        `The imported site did not respond successfully (HTTP ${lastStatus}). The container is running but the application is returning an error.`
      )
    }

    // A 200 is not sufficient on its own: WordPress renders its database
    // error page with a 200 status, so an import with bad credentials would
    // "verify" perfectly and go live broken.
    const lower = body.toLowerCase()
    if (lower.includes('error establishing a database connection')) {
      throw new Error(
        'The site loaded but cannot reach its database. The imported wp-config credentials do not match the provisioned database.'
      )
    }
    if (lower.includes('/wp-admin/install.php') || lower.includes('wordpress &rsaquo; installation')) {
      throw new Error(
        'The site loaded the WordPress installer, which means the database has no content under the configured table prefix. The dump may not have imported correctly.'
      )
    }
    if (lower.includes('fatal error') && lower.includes('stack trace')) {
      ctx.warnings.push(
        'The site responded with a PHP fatal error on the homepage. A plugin or theme from the old host may be incompatible.'
      )
    }

    ctx.log(`HTTP ${lastStatus} · the site is responding.`)
  })
}

// ─── finalize ─────────────────────────────────────────────────────────────

const stageFinalize: StageFn = async (ctx) => {
  await db.project.update({
    where: { id: ctx.projectId },
    data: {
      status: 'running',
      lastDeployedAt: new Date(),
      installSettings: JSON.stringify({
        importedFrom: ctx.sourceType,
        importedAt: new Date().toISOString(),
        originalUrl: ctx.originalUrl,
        migrationId: ctx.migrationId,
        detection: ctx.detection,
      }),
    },
  })

  await db.notification
    .create({
      data: {
        userId: ctx.userId,
        title: 'Website import complete',
        message: `Your site is live at ${ctx.targetUrl}.`,
        type: 'success',
      },
    })
    .catch(() => {})

  ctx.log(`Import complete — the website is live at ${ctx.targetUrl}`)
  if (ctx.warnings.length > 0) {
    ctx.log(`${ctx.warnings.length} note(s) to review:`)
    for (const w of ctx.warnings) ctx.log(`  • ${w}`)
  }
}

// ═══ Rollback ═════════════════════════════════════════════════════════════

/**
 * Undo everything a failed run changed, newest change first.
 *
 * Each action is attempted independently: one that cannot complete (a
 * container already removed by hand, a database the operator dropped) must not
 * stop the rest from running, or a single stale entry would strand the
 * customer's old site in the tarball.
 */
async function applyRollback(
  ctx: StageContext,
  undoStack: Array<{ stage: MigrationStageName; action: UndoAction }>,
  log: (l: string) => void
): Promise<void> {
  if (undoStack.length === 0) {
    log('Nothing to roll back — no changes had been made yet.')
    return
  }

  for (let i = undoStack.length - 1; i >= 0; i--) {
    const { stage, action } = undoStack[i]
    try {
      await applyUndoAction(ctx, action, log)
      await db.migrationStage
        .updateMany({
          where: { migrationId: ctx.migrationId, name: stage, status: 'completed' },
          data: { status: 'rolled_back' },
        })
        .catch(() => {})
    } catch (err) {
      log(
        `  Could not undo ${action.type} from "${stage}": ${err instanceof Error ? err.message : err}`
      )
    }
  }
  log('Rollback finished.')
}

async function applyUndoAction(
  ctx: StageContext,
  action: UndoAction,
  log: (l: string) => void
): Promise<void> {
  switch (action.type) {
    case 'rmdir': {
      if (ctx.demo || !ctx.creds) return
      log(`  Removing workspace ${action.path}`)
      await withConnection(ctx.creds, async (client) => {
        await removeRemotePath(client, action.path, [MIGRATION_ROOT])
      })
      return
    }

    case 'drop_database': {
      log('  Dropping the database created for this import')
      await dropProjectDatabase(ctx.projectId, action.databaseId).catch(() => {})
      await db.project
        .update({
          where: { id: ctx.projectId },
          data: {
            databaseType: null,
            databaseName: null,
            databaseUser: null,
            databasePassword: null,
            databaseHost: null,
            databasePort: null,
          },
        })
        .catch(() => {})
      return
    }

    case 'wipe_database': {
      if (ctx.demo || !ctx.creds || !ctx.dbConfig) return
      log(`  Emptying the tables imported into ${action.databaseName}`)
      await withConnection(ctx.creds, async (client) => {
        await wipeDatabaseTables(client, ctx.dbConfig!)
      })
      return
    }

    case 'restore_path': {
      if (ctx.demo || !ctx.creds) return
      log(`  Restoring ${action.path} from the pre-import snapshot`)
      await withConnection(ctx.creds, async (client) => {
        if (!(await remoteExists(client, action.tarball))) {
          throw new Error('the snapshot archive is missing')
        }
        await exec(
          client,
          `find ${shellQuote(action.path)} -mindepth 1 -maxdepth 1 -exec rm -rf {} + 2>/dev/null || true`,
          { timeoutMs: 600_000 }
        )
        const r = await exec(
          client,
          `tar -xzf ${shellQuote(action.tarball)} -C ${shellQuote(action.path)} 2>&1`,
          { timeoutMs: 3_600_000 }
        )
        if (r.exitCode !== 0) throw new Error(r.stdout.slice(-200))
      })
      return
    }

    case 'remove_container': {
      if (ctx.demo || !ctx.creds) return
      log(`  Stopping and removing container ${action.name}`)
      await withConnection(ctx.creds, async (client) => {
        if (action.composePath) {
          await exec(
            client,
            `cd ${shellQuote(action.composePath)} && (${COMPOSE_ENV}docker compose ${composeProjectFlag(action.composePath)}down 2>/dev/null || ` +
              `${COMPOSE_ENV}docker-compose ${composeProjectFlag(action.composePath)}down 2>/dev/null) || true`,
            { timeoutMs: 300_000 }
          )
        }
        await exec(client, `docker rm -f ${shellQuote(action.name)} 2>/dev/null || true`, {
          timeoutMs: 120_000,
        })
      })
      await db.project
        .update({
          where: { id: ctx.projectId },
          data: { containerId: null, status: 'stopped' },
        })
        .catch(() => {})
      return
    }

    case 'remove_proxy': {
      log('  Removing the reverse-proxy entry')
      await removeProjectProxy(action.projectId).catch(() => {})
      return
    }

    case 'restore_project': {
      log('  Restoring the project record to its pre-import state')
      await db.project
        .update({ where: { id: ctx.projectId }, data: action.fields as never })
        .catch(() => {})
      return
    }
  }
}

/**
 * Roll back a migration that already finished — the customer looked at the
 * imported site and wants their previous state back.
 */
export async function rollbackMigration(
  migrationId: string,
  opts: { onLog?: (l: string) => void } = {}
): Promise<{ ok: boolean; message: string }> {
  const migration = await db.siteMigration.findUnique({
    where: { id: migrationId },
    include: {
      project: { include: { server: true } },
      stages: { orderBy: { order: 'asc' } },
    },
  })
  if (!migration) throw new Error('Migration not found')
  if (migration.status === 'rolled_back') {
    return { ok: true, message: 'This import has already been rolled back.' }
  }
  if (migration.status === 'running') {
    return {
      ok: false,
      message: 'This import is still running. Cancel it first, then roll back.',
    }
  }

  const project = migration.project
  const log = (l: string) => {
    opts.onLog?.(l)
    broadcastMigrationLog(migrationId, l)
  }

  const demo = isServerInDemoMode(project.server)
  const ctx: StageContext = {
    migrationId,
    projectId: project.id,
    userId: migration.userId,
    sourceType: migration.sourceType as MigrationSourceType,
    opts: JSON.parse(migration.options || '{}'),
    workDir: `${MIGRATION_ROOT}/${migrationId}`,
    deployPath: project.deployPath || `${PROJECT_ROOT}/${project.slug}`,
    sitePath: project.deployPath || `${PROJECT_ROOT}/${project.slug}`,
    creds: demo || !project.serverId ? null : await getServerCredentials(project.serverId),
    demo,
    tools: null,
    detection: migration.detection ? JSON.parse(migration.detection) : null,
    dbConfig: buildDbConfigFromProject(project, migration),
    localPayload: null,
    payloadFilename: '',
    remoteArchive: null,
    extractDir: null,
    targetUrl: migration.targetUrl || `https://${project.customDomain || project.subdomain}`,
    originalUrl: migration.originalUrl,
    warnings: [],
    log,
  }

  // Replay the persisted undo records in reverse stage order.
  const stack: Array<{ stage: MigrationStageName; action: UndoAction }> = []
  for (const stage of migration.stages) {
    if (!stage.undo || stage.status === 'rolled_back') continue
    try {
      const actions = JSON.parse(stage.undo) as UndoAction[]
      for (const a of actions) {
        stack.push({ stage: stage.name as MigrationStageName, action: a })
      }
    } catch {
      /* a malformed record must not block the rest of the rollback */
    }
  }

  await applyRollback(ctx, stack, log)

  await db.siteMigration.update({
    where: { id: migrationId },
    data: { status: 'rolled_back', currentStage: null },
  })
  broadcastMigrationStatus(migrationId, project.id, 'rolled_back', migration.progress)

  return { ok: true, message: 'The import was rolled back and the previous state restored.' }
}

// ═══ Retry / cancel ═══════════════════════════════════════════════════════

/**
 * Retry a failed import.
 *
 * The run starts over from the first stage rather than resuming, because a
 * failure triggers an automatic rollback — the server state is back to where
 * it began, so resuming mid-pipeline would build on undone work. The uploaded
 * archive is still on the panel, so the customer does not re-upload.
 */
export async function retryMigration(
  migrationId: string,
  opts: { gitToken?: string; onLog?: (l: string) => void } = {}
): Promise<MigrationRunResult> {
  await prepareRetry(migrationId)
  return runMigration({ migrationId, onLog: opts.onLog, gitToken: opts.gitToken })
}

/**
 * Validate that a migration may be retried and reset it to a clean slate.
 *
 * Split out from `retryMigration` because callers that launch the run in the
 * background need the *validation* to happen synchronously. When the guards
 * lived inside the async run, a rejected precondition ("this import already
 * completed") reached the caller's generic failure handler and was written to
 * the row — flipping a successful import to `failed` and destroying a record
 * of work that had gone perfectly well. Awaiting this first means a rejected
 * retry changes nothing at all.
 *
 * Throws with a customer-readable message; the caller maps that to a 400.
 */
export async function prepareRetry(migrationId: string): Promise<void> {
  const migration = await db.siteMigration.findUnique({
    where: { id: migrationId },
  })
  if (!migration) throw new Error('Migration not found')
  if (['pending', 'detecting', 'running', 'verifying'].includes(migration.status)) {
    throw new Error('This import is already running.')
  }
  if (migration.status === 'completed') {
    throw new Error('This import already completed successfully.')
  }
  if (migration.attempts >= 5) {
    throw new Error(
      'This import has failed five times. Check the logs and start a new import once the underlying problem is fixed.'
    )
  }

  await db.migrationStage.updateMany({
    where: { migrationId },
    data: {
      status: 'pending',
      error: null,
      log: null,
      undo: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
    },
  })
  await db.siteMigration.update({
    where: { id: migrationId },
    data: {
      status: 'pending',
      progress: 0,
      error: null,
      currentStage: null,
      completedAt: null,
    },
  })
}

/**
 * Mark a running import as cancelled.
 *
 * This is cooperative: an SSH command already in flight (a `tar` over 40 GB)
 * cannot be interrupted from here, so the row is marked and the runner's next
 * database write reflects it. The customer can roll back afterwards to undo
 * whatever had completed.
 */
export async function cancelMigration(
  migrationId: string
): Promise<{ ok: boolean; message: string }> {
  const migration = await db.siteMigration.findUnique({ where: { id: migrationId } })
  if (!migration) throw new Error('Migration not found')
  if (['completed', 'rolled_back', 'cancelled'].includes(migration.status)) {
    return { ok: false, message: `This import is already ${migration.status}.` }
  }
  await db.siteMigration.update({
    where: { id: migrationId },
    data: { status: 'cancelled', error: 'Cancelled by the user', completedAt: new Date() },
  })
  await db.migrationStage.updateMany({
    where: { migrationId, status: { in: ['pending', 'running'] } },
    data: { status: 'skipped' },
  })
  broadcastMigrationStatus(migrationId, migration.projectId, 'cancelled', migration.progress)
  return {
    ok: true,
    message:
      'Import cancelled. Any step already in progress finishes on the server; roll back to undo what completed.',
  }
}

// ═══ Helpers ══════════════════════════════════════════════════════════════

async function cleanupWorkspace(ctx: StageContext): Promise<void> {
  if (ctx.demo || !ctx.creds) return
  await withConnection(ctx.creds, async (client) => {
    await removeRemotePath(client, ctx.workDir, [MIGRATION_ROOT])
  })
  ctx.log('Removed the temporary import workspace.')
}

/** Pick a free host port, reusing the deployer's allocator. */
async function pickPort(serverId: string): Promise<number> {
  const { pickExternalPortForServer } = await import('@/lib/vps/deployer')
  return pickExternalPortForServer(serverId)
}

function mapStackToMethod(stack: string): string {
  switch (stack) {
    case 'wordpress':
      return 'wordpress'
    case 'laravel':
      return 'laravel'
    case 'nodejs':
      return 'nodejs'
    case 'python':
      return 'python'
    case 'docker':
      return 'docker'
    case 'php':
      return 'php'
    default:
      return 'static'
  }
}

function runtimeForStack(stack: string): string {
  switch (stack) {
    case 'wordpress':
    case 'php':
    case 'laravel':
      return 'php'
    case 'nodejs':
      return 'nodejs'
    case 'python':
      return 'python'
    case 'docker':
      return 'docker'
    default:
      return 'static'
  }
}

function buildDbConfigFromProject(
  project: {
    databaseHost: string | null
    databaseName: string | null
    databaseUser: string | null
    databasePassword: string | null
    databasePort: number | null
  },
  migration: { detection: string | null }
): WpDatabaseConfig | null {
  if (!project.databaseName || !project.databasePassword) return null
  let prefix = 'wp_'
  try {
    const d = migration.detection ? (JSON.parse(migration.detection) as DetectionResult) : null
    prefix = d?.wordpress?.tablePrefix || 'wp_'
  } catch {
    /* default prefix is fine */
  }
  return {
    host: project.databaseHost || 'db',
    port: project.databasePort ?? 3306,
    name: project.databaseName,
    user: project.databaseUser || 'wp',
    password: safeDecrypt(project.databasePassword),
    tablePrefix: prefix,
    container: project.databaseHost,
  }
}

function safeDecrypt(value: string): string {
  try {
    return decrypt(value)
  } catch {
    return ''
  }
}

function sanitizeRemoteName(source: string): string {
  try {
    const u = new URL(source)
    const base = u.pathname.split('/').filter(Boolean).pop() || 'download'
    return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'download'
  } catch {
    return 'download.zip'
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** A plausible detection result so the wizard is exercisable without a VPS. */
function demoDetection(ctx: StageContext): DetectionResult {
  return {
    stack: 'wordpress',
    rootDir: `${ctx.workDir}/extracted`,
    documentRoot: null,
    sqlFiles: [`${ctx.workDir}/extracted/database.sql`],
    sizeBytes: ctx.opts.sizeBytes ?? 52_428_800,
    fileCount: 4812,
    warnings: [],
    hasDockerfile: false,
    hasCompose: false,
    wordpress: {
      version: '6.5.2',
      tablePrefix: 'wp_',
      siteUrl: ctx.opts.originalUrl || 'https://old-site.example.com',
      homeUrl: ctx.opts.originalUrl || 'https://old-site.example.com',
      hasWpContent: true,
      pluginCount: 14,
      themeCount: 3,
      isMultisite: false,
      cachePlugins: ['wp-super-cache'],
    },
  }
}
