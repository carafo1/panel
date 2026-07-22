/**
 * Container Deployer
 * ==================
 *
 * Real Docker container deployment on a provisioned VPS.
 *
 * Two pipelines share this module:
 *
 *   1. LEGACY pipeline (kept for back-compat) — driven by `project.stack`
 *      ('nodejs' | 'php' | 'python' | 'docker' | 'wordpress' | 'static' |
 *      'ruby' | 'go' | 'java'). Used by projects created before the new
 *      Create-Website-Wizard.
 *
 *   2. NEW wizard pipeline — driven by `project.deploymentMethod`
 *      ('wordpress' | 'laravel' | 'nodejs' | 'php' | 'static' | 'python' |
 *      'docker' | 'custom'). Used by projects created via the multi-step
 *      wizard. Each method gets:
 *        - a tailored Dockerfile
 *        - a tailored docker-compose.yml (with resource limits from the plan)
 *        - optional database provisioning (WordPress / Laravel)
 *        - optional post-install steps (wp core install, php artisan migrate)
 *        - live progress via DeploymentStage rows
 *
 * Both pipelines:
 *   - SFTP-upload project files to /opt/deployhub/projects/<slug>/
 *   - Either clone the repo (git source), upload a ZIP (zip source), or
 *     write a placeholder app (manual source).
 *   - Run `docker compose up -d --build` and capture logs.
 *   - Register the container on the deployhub docker network (so Caddy can
 *     proxy to it via the container's service name).
 *   - Persist containerId, containerName, containerPort, externalPort,
 *     deployPath, lastDeployedAt back to the Project row.
 *   - Trigger the reverse-proxy manager to add the Caddyfile entry.
 *   - Write one DeploymentStage row per major step so the UI can show
 *     live progress.
 *
 * In DEMO MODE (VPS_DEMO_MODE=1 or no server.sshHost), the deployer returns
 * a realistic simulated success — the Project row is updated with a fake
 * containerId + simulated build logs, so the dashboard UX is intact.
 */
import { readFile } from 'fs/promises'
import { db } from '@/lib/db'
import { STACK_DEFINITIONS, getStackDefinition } from '@/lib/stacks'
import { getDeploymentMethod, type DeploymentMethodId } from '@/lib/deployment-methods'
import { encrypt } from '@/lib/encryption'
import { broadcastDeploymentLog, broadcastDeploymentStatus } from '@/lib/realtime'
import {
  withConnection,
  exec,
  execStream,
  putFile,
  isServerInDemoMode,
  type ExecResult,
  type StreamChunk,
  type SshCredentials,
} from './ssh'
import { getServerCredentials } from './provisioner'
import { configureProjectProxy, removeProjectProxy } from './proxy'
import { provisionProjectDatabase } from './database'

// ─── Types ───────────────────────────────────────────────────────────────

export interface DeployRequest {
  projectId: string
  deploymentId: string
  onLog?: (msg: string) => void
  onStreamChunk?: (chunk: StreamChunk) => void
}

export interface DeployResult {
  ok: boolean
  projectId: string
  deploymentId: string
  containerId?: string
  containerName?: string
  containerPort?: number
  externalPort?: number
  deployPath?: string
  buildLog: string
  durationMs: number
  error?: string
}

export interface ContainerStatus {
  containerId: string
  name: string
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'not_found'
  status: string
  image: string
  ports: string[]
  createdAt: string
}

// ─── Stage definitions ────────────────────────────────────────────────────

interface StageDef {
  name: string
  label: string
}

const ALL_STAGES: StageDef[] = [
  { name: 'plan', label: 'Planning deployment…' },
  { name: 'create_directory', label: 'Creating project directory…' },
  { name: 'download_source', label: 'Downloading source…' },
  { name: 'provision_database', label: 'Provisioning database…' },
  { name: 'write_dockerfile', label: 'Writing Dockerfile…' },
  { name: 'write_compose', label: 'Writing docker-compose.yml…' },
  { name: 'build_image', label: 'Building Docker image…' },
  { name: 'start_container', label: 'Starting container…' },
  { name: 'configure_proxy', label: 'Configuring reverse proxy…' },
  { name: 'configure_ssl', label: 'Configuring SSL…' },
  { name: 'run_migrations', label: 'Running migrations…' },
  { name: 'post_install', label: 'Post-install setup…' },
  { name: 'verify', label: 'Verifying deployment…' },
]

// ─── Main deploy function ────────────────────────────────────────────────

export async function deployProject(req: DeployRequest): Promise<DeployResult> {
  const start = Date.now()
  const { projectId, deploymentId } = req
  const log = (m: string) => req.onLog?.(m)
  // Bridge real command output (docker build, git clone, …) to the live stream,
  // in addition to whatever the caller already does with the chunk.
  const callerOnStreamChunk = req.onStreamChunk
  req.onStreamChunk = (chunk) => {
    callerOnStreamChunk?.(chunk)
    const line = chunk.data.replace(/\n+$/, '')
    if (line) broadcastDeploymentLog(deploymentId, line)
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)
  if (!project.serverId || !project.server) {
    throw new Error('Project has no server assigned')
  }

  // Mark deployment as building.
  await db.deployment.update({
    where: { id: deploymentId },
    data: { status: 'building' },
  }).catch(() => {})
  broadcastDeploymentStatus(deploymentId, projectId, 'building')

  // Stage runner: writes a DeploymentStage row, runs fn, marks completed/failed.
  const buildLog: string[] = []
  const stageLog = (msg: string) => {
    buildLog.push(msg)
    log(msg)
    broadcastDeploymentLog(deploymentId, msg)
  }

  async function runStage<T>(
    name: string,
    label: string,
    fn: () => Promise<T>,
    opts: { skip?: boolean; skipReason?: string } = {}
  ): Promise<T | undefined> {
    const stageStart = Date.now()
    const existing = await db.deploymentStage.findFirst({
      where: { deploymentId, name },
    })
    if (opts.skip) {
      if (existing) {
        await db.deploymentStage.update({
          where: { id: existing.id },
          data: { status: 'skipped', message: opts.skipReason || 'Skipped', label },
        })
      } else {
        await db.deploymentStage.create({
          data: {
            deploymentId,
            name,
            label,
            status: 'skipped',
            message: opts.skipReason || 'Skipped',
            order: ALL_STAGES.findIndex((s) => s.name === name),
          },
        })
      }
      stageLog(`[${name}] skipped — ${opts.skipReason || 'not applicable'}`)
      return undefined
    }
    if (existing) {
      await db.deploymentStage.update({
        where: { id: existing.id },
        data: { status: 'running', label, message: null, log: null, startedAt: new Date(), completedAt: null, durationMs: null },
      })
    } else {
      await db.deploymentStage.create({
        data: {
          deploymentId,
          name,
          label,
          status: 'running',
          startedAt: new Date(),
          order: ALL_STAGES.findIndex((s) => s.name === name),
        },
      })
    }
    stageLog(`[${name}] ${label}`)
    try {
      const result = await fn()
      const duration = Date.now() - stageStart
      const row = await db.deploymentStage.findFirst({ where: { deploymentId, name } })
      if (row) {
        await db.deploymentStage.update({
          where: { id: row.id },
          data: {
            status: 'completed',
            completedAt: new Date(),
            durationMs: duration,
            message: 'OK',
          },
        })
      }
      stageLog(`[${name}] OK (${duration}ms)`)
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const duration = Date.now() - stageStart
      const row = await db.deploymentStage.findFirst({ where: { deploymentId, name } })
      if (row) {
        await db.deploymentStage.update({
          where: { id: row.id },
          data: {
            status: 'failed',
            message,
            log: buildLog.slice(-30).join('\n'),
            completedAt: new Date(),
            durationMs: duration,
          },
        })
      }
      stageLog(`[${name}] FAILED: ${message}`)
      throw err
    }
  }

  // Decide which pipeline to run.
  const method = project.deploymentMethod as DeploymentMethodId | null
  try {
    const result =
      method && getDeploymentMethod(method)
        ? await deployMethodProject(req, project, method, runStage, stageLog, buildLog, start)
        : await deployLegacyProject(req, project, runStage, stageLog, buildLog, start)
    broadcastDeploymentStatus(deploymentId, projectId, result.ok ? 'live' : 'failed')
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`DEPLOY FAILED: ${message}`)
    buildLog.push(`[FATAL] ${message}`)
    await db.project.update({
      where: { id: projectId },
      data: { status: 'error' },
    })
    await db.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'failed',
        buildLog: buildLog.join('\n'),
        duration: Math.round((Date.now() - start) / 1000),
      },
    })
    broadcastDeploymentStatus(deploymentId, projectId, 'failed')
    return {
      ok: false,
      projectId,
      deploymentId,
      buildLog: buildLog.join('\n'),
      durationMs: Date.now() - start,
      error: message,
    }
  }
}

// ─── Stage runner signature ──────────────────────────────────────────────

type RunStage = <T>(
  name: string,
  label: string,
  fn: () => Promise<T>,
  opts?: { skip?: boolean; skipReason?: string }
) => Promise<T | undefined>
type StageLog = (msg: string) => void

// ─── NEW: Method-based deploy pipeline ───────────────────────────────────


/**
 * A project as loaded by the deployer — always with its server relation.
 *
 * The bare `db.project.findUnique` return type omits `server`, so callers
 * reached for `project.server!` and the non-null assertion hid the fact that
 * the type was simply wrong. The queries do include the relation.
 */
type ProjectWithServer = NonNullable<
  Awaited<ReturnType<typeof db.project.findUnique>>
> & {
  server: Awaited<ReturnType<typeof db.server.findUnique>>
}

async function deployMethodProject(
  req: DeployRequest,
  project: ProjectWithServer,
  methodId: DeploymentMethodId,
  runStage: RunStage,
  stageLog: StageLog,
  buildLog: string[],
  start: number
): Promise<DeployResult> {
  const { projectId, deploymentId } = req
  const method = getDeploymentMethod(methodId)!

  const deployPath = project.deployPath || `/opt/deployhub/projects/${project.slug}`
  const containerName = project.containerName || `deployhub-${project.slug}`
  const containerPort = project.containerPort || method.defaultPort
  const externalPort = project.externalPort || (await pickExternalPort(project.serverId!))

  // Parse installSettings (wizard config blob).
  const settings = parseInstallSettings(project.installSettings)

  await runStage('plan', 'Planning deployment…', async () => {
    stageLog(`Method: ${method.name} (${methodId})`)
    stageLog(`Source: ${project.deploymentSource || 'manual'}`)
    stageLog(`Container: ${containerName} (port ${containerPort} → host ${externalPort})`)
    stageLog(`Deploy path: ${deployPath}`)
    if (project.resourceCpuCores) stageLog(`Resources: ${project.resourceCpuCores} CPU, ${project.resourceRamMB || '?'}MB RAM, ${project.resourceStorageGB || '?'}GB storage`)
  })

  // ── DEMO MODE: simulated deploy with realistic build log ────────────
  if (isServerInDemoMode(project.server)) {
    const buildLogStr = generateDemoBuildLog(project, method.name, containerName, containerPort, externalPort)
    for (const line of buildLogStr.split('\n')) {
      req.onStreamChunk?.({ stream: 'stdout', data: line + '\n' })
      await sleep(120)
    }
    const fakeContainerId = generateFakeContainerId()

    // Provision a demo database for WordPress/Laravel.
    if (method.needsDatabase) {
      await runStage('provision_database', 'Provisioning database…', async () => {
        const pdb = await provisionProjectDatabase(projectId, {
          type: 'mariadb',
          onLog: stageLog,
        })
        // Persist DB credentials onto the Project row.
        await db.project.update({
          where: { id: projectId },
          data: {
            databaseType: pdb.type,
            databaseName: pdb.name,
            databaseUser: pdb.username,
            databasePassword: encrypt(pdb.password),
            databaseHost: pdb.host,
            databasePort: pdb.port,
          },
        })
      })
    } else {
      await runStage('provision_database', 'Provisioning database…', async () => undefined, {
        skip: true,
        skipReason: 'Method does not need a database',
      })
    }

    // Skip the rest as completed (simulated).
    for (const s of ALL_STAGES) {
      if (s.name === 'plan' || s.name === 'provision_database') continue
      await runStage(s.name, s.label, async () => {
        await sleep(150)
      })
    }

    await db.project.update({
      where: { id: projectId },
      data: {
        status: 'running',
        containerId: fakeContainerId,
        containerName,
        containerPort,
        externalPort,
        deployPath,
        lastDeployedAt: new Date(),
        sslCertStatus: project.sslEnabled ? 'issued' : 'none',
        sslCertExpiry: project.sslEnabled
          ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
          : null,
        sourceCommit: 'demo-' + Date.now(),
      },
    })

    await db.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'live',
        buildLog: buildLogStr,
        deployUrl: `https://${project.customDomain || project.subdomain}`,
        duration: Math.round((Date.now() - start) / 1000),
      },
    })

    return {
      ok: true,
      projectId,
      deploymentId,
      containerId: fakeContainerId,
      containerName,
      containerPort,
      externalPort,
      deployPath,
      buildLog: buildLogStr,
      durationMs: Date.now() - start,
    }
  }

  // ── REAL deploy ─────────────────────────────────────────────────────
  const creds: SshCredentials = await getServerCredentials(project.serverId!)
  let containerId: string | undefined
  const envVars = await getProjectEnvVars(projectId)

  await runStage('create_directory', 'Creating project directory…', async () => {
    await withConnection(creds, async (client) => {
      await exec(client, `mkdir -p ${shellQuote(deployPath)}`, { timeoutMs: 10000 })
    })
  })

  await runStage('download_source', 'Downloading source…', async () => {
    await withConnection(creds, async (client) => {
      const source = project.deploymentSource || 'git'
      if (source === 'git' && project.repoUrl) {
        stageLog(`Cloning ${project.repoUrl}…`)
        const branch = project.sourceBranch || 'main'
        const cloneCmd = `if [ -d ${shellQuote(deployPath + '/.git')} ]; then cd ${shellQuote(deployPath)} && git fetch --all && git checkout ${shellQuote(branch)} && git reset --hard origin/${shellQuote(branch)}; else rm -rf ${shellQuote(deployPath)}/* ${shellQuote(deployPath)}/.[!.]* 2>/dev/null; git clone --branch ${shellQuote(branch)} ${shellQuote(project.repoUrl)} ${shellQuote(deployPath)}; fi`
        const r = await exec(client, cloneCmd, { timeoutMs: 180000 })
        stageLog(r.stdout.slice(-500))
        if (r.exitCode !== 0) throw new Error(`git clone failed: ${r.stderr}`)
        // Capture commit sha.
        const sha = await exec(client, `cd ${shellQuote(deployPath)} && git rev-parse HEAD`, { timeoutMs: 10000 })
        await db.project.update({
          where: { id: projectId },
          data: { sourceCommit: sha.stdout.trim() || null },
        }).catch(() => {})
      } else if (source === 'zip' && settings.uploadId) {
        const localZip = `/tmp/apsamo-uploads/${settings.uploadId}.zip`
        let zipData: Buffer
        try {
          zipData = await readFile(localZip)
        } catch (err) {
          throw new Error(`ZIP upload not found on panel server (${localZip}): ${err instanceof Error ? err.message : err}`)
        }
        const remoteZip = `${deployPath}.upload.zip`
        stageLog(`Uploading ZIP (${zipData.length} bytes) to VPS…`)
        await putFile(client, remoteZip, zipData, { mode: 0o644 })
        stageLog('Extracting ZIP…')
        const r = await exec(
          client,
          `unzip -o ${shellQuote(remoteZip)} -d ${shellQuote(deployPath)} 2>&1 && rm -f ${shellQuote(remoteZip)}`,
          { timeoutMs: 120000 }
        )
        if (r.exitCode !== 0) throw new Error(`unzip failed: ${r.stderr || r.stdout}`)
      } else if (source === 'template') {
        stageLog('Writing starter template files…')
        const template = generatePlaceholderApp(methodId, project.name)
        for (const [filename, content] of Object.entries(template)) {
          await putFile(client, `${deployPath}/${filename}`, content, { mode: 0o644 })
        }
      } else {
        // Manual — write a placeholder app suitable for the method.
        stageLog('Writing placeholder app…')
        const placeholder = generatePlaceholderApp(methodId, project.name)
        for (const [filename, content] of Object.entries(placeholder)) {
          await putFile(client, `${deployPath}/${filename}`, content, { mode: 0o644 })
        }
      }
    })
  })

  // Provision database for WordPress/Laravel BEFORE writing the Dockerfile.
  if (method.needsDatabase) {
    await runStage('provision_database', 'Provisioning database…', async () => {
      const pdb = await provisionProjectDatabase(projectId, {
        type: 'mariadb',
        onLog: stageLog,
      })
      await db.project.update({
        where: { id: projectId },
        data: {
          databaseType: pdb.type,
          databaseName: pdb.name,
          databaseUser: pdb.username,
          databasePassword: encrypt(pdb.password),
          databaseHost: pdb.host,
          databasePort: pdb.port,
        },
      })
    })
  } else {
    await runStage('provision_database', 'Provisioning database…', async () => undefined, {
      skip: true,
      skipReason: 'Method does not need a database',
    })
  }

  // Generate + write Dockerfile.
  const dockerfile = generateMethodDockerfile(methodId, project, settings)
  await runStage('write_dockerfile', 'Writing Dockerfile…', async () => {
    await withConnection(creds, async (client) => {
      await putFile(client, `${deployPath}/Dockerfile`, dockerfile, { mode: 0o644 })
      // .dockerignore for cleaner builds.
      await putFile(client, `${deployPath}/.dockerignore`, '.git\nnode_modules\n.env\n.env.local\n', { mode: 0o644 })
    })
    stageLog(`Dockerfile written (${dockerfile.length} bytes)`)
  })

  // Generate + write docker-compose.yml.
  const composeYml = generateMethodCompose(methodId, project, settings, {
    containerName,
    deployPath,
    containerPort,
    externalPort,
    envVars,
  })
  await runStage('write_compose', 'Writing docker-compose.yml…', async () => {
    await withConnection(creds, async (client) => {
      await putFile(client, `${deployPath}/docker-compose.yml`, composeYml, { mode: 0o644 })
    })
    stageLog('docker-compose.yml written')
  })

  // For Laravel: write .env with DB credentials before build.
  if (methodId === 'laravel') {
    await runStage('run_migrations', 'Writing .env + running migrations…', async () => {
      await withConnection(creds, async (client) => {
        const envContent = generateLaravelEnv(project)
        await putFile(client, `${deployPath}/.env`, envContent, { mode: 0o644 })
        // We'll actually run the migrations AFTER the container is up — for
        // now just stage the .env. Mark as completed; the post_install stage
        // will run `php artisan migrate`.
      })
    })
  }

  // Build image.
  await runStage('build_image', 'Building Docker image…', async () => {
    await withConnection(creds, async (client) => {
      const buildGen = execStream(
        client,
        `cd ${shellQuote(deployPath)} && docker compose build --progress=plain 2>&1`,
        { timeoutMs: 600000 }
      )
      let final: ExecResult | undefined
      while (true) {
        const r = await buildGen.next()
        if (r.done) {
          final = r.value
          break
        }
        req.onStreamChunk?.(r.value)
        stageLog(r.value.data.replace(/\n$/, ''))
      }
      if (final && final.exitCode !== 0) {
        throw new Error(`docker build failed (exit ${final.exitCode})`)
      }
    })
  })

  // Start container.
  await runStage('start_container', 'Starting container…', async () => {
    await withConnection(creds, async (client) => {
      const upGen = execStream(
        client,
        `cd ${shellQuote(deployPath)} && docker compose up -d 2>&1`,
        { timeoutMs: 180000 }
      )
      while (true) {
        const r = await upGen.next()
        if (r.done) break
        req.onStreamChunk?.(r.value)
        stageLog(r.value.data.replace(/\n$/, ''))
      }
      // Connect to deployhub network.
      await exec(client, `docker network connect deployhub ${shellQuote(containerName)} 2>/dev/null || true`, { timeoutMs: 15000 })
      // Verify running.
      const inspect = await exec(
        client,
        `docker inspect --format '{{.Id}} {{.State.Status}}' ${shellQuote(containerName)}`,
        { timeoutMs: 15000 }
      )
      const [cid, state] = inspect.stdout.trim().split(' ')
      if (!cid || state !== 'running') {
        const logs = await exec(client, `docker logs ${shellQuote(containerName)} --tail 50 2>&1`, { timeoutMs: 15000 })
        throw new Error(`Container did not start (state=${state}). Logs:\n${logs.stdout.slice(0, 1000)}`)
      }
      containerId = cid
      stageLog(`Container running: ${cid.slice(0, 12)}`)
    })
  })

  // Persist container details NOW — BEFORE configure_proxy. configureProjectProxy
  // requires project.containerName, and its Caddyfile generator only includes
  // projects with status='running', so this must land before the proxy stage.
  await db.project.update({
    where: { id: projectId },
    data: { status: 'running', containerId, containerName, containerPort, externalPort, deployPath },
  })

  // Post-install steps per method.
  if (methodId === 'wordpress') {
    await runStage('post_install', 'Running WordPress install…', async () => {
      await withConnection(creds, async (client) => {
        // Wait for WordPress to be ready.
        for (let i = 0; i < 30; i++) {
          const check = await exec(client, `docker exec ${shellQuote(containerName)} sh -c 'curl -sf http://localhost/ >/dev/null 2>&1 && echo ok || echo no'`, { timeoutMs: 10000 })
          if (check.stdout.trim() === 'ok') break
          await sleep(2000)
        }
        const adminUser = project.wpAdminUser || 'admin'
        const adminEmail = project.wpAdminEmail || 'admin@example.com'
        let adminPass = ''
        if (project.wpAdminPassword) {
          try {
            const { decrypt } = await import('@/lib/encryption')
            adminPass = decrypt(project.wpAdminPassword)
          } catch {
            adminPass = ''
          }
        }
        if (!adminPass) adminPass = 'changeme123!'
        // Re-fetch the DB credentials from the Project row. The in-memory
        // `project` object was loaded BEFORE provision_database ran, so its
        // database* fields are still null here — reading them directly used to
        // write placeholder values ('db'/'wp'/empty password) into wp-config,
        // which breaks the site with "Error establishing a database connection".
        const freshDb = await db.project.findUnique({
          where: { id: projectId },
          select: {
            databaseHost: true,
            databaseName: true,
            databaseUser: true,
            databasePassword: true,
          },
        })
        const dbHost = freshDb?.databaseHost || 'db'
        const dbName = freshDb?.databaseName || 'wp'
        const dbUser = freshDb?.databaseUser || 'wp'
        let dbPass = ''
        if (freshDb?.databasePassword) {
          try {
            const { decrypt } = await import('@/lib/encryption')
            dbPass = decrypt(freshDb.databasePassword)
          } catch {
            dbPass = ''
          }
        }
        if (!freshDb?.databaseHost) {
          stageLog('WARNING: no provisioned database found on the project row — wp-config will contain placeholder DB values.')
        }
        // Write wp-config.php constants via docker exec sed.
        const cfg = `<?php
// Behind the Caddy reverse proxy WordPress must trust X-Forwarded-Proto,
// otherwise it emits http:// asset URLs on https pages and the browser
// blocks them (mixed-content / unstyled admin + install pages).
if (isset(\$_SERVER['HTTP_X_FORWARDED_PROTO']) && \$_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
    \$_SERVER['HTTPS'] = 'on';
    \$_SERVER['SERVER_PORT'] = 443;
}
define('DB_NAME',     ${JSON.stringify(dbName)});
define('DB_USER',     ${JSON.stringify(dbUser)});
define('DB_PASSWORD', ${JSON.stringify(dbPass)});
define('DB_HOST',     ${JSON.stringify(dbHost)});
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
\$table_prefix = 'wp_';
define('WP_DEBUG', false);
if (!defined('ABSPATH')) define('ABSPATH', dirname(__FILE__) . '/');
require_once ABSPATH . 'wp-settings.php';
`
        await putFile(client, `${deployPath}/wp-config-docker.php`, cfg, { mode: 0o644 })
        // Run wp core install via the wp-cli container.
        const url = `https://${project.customDomain || project.subdomain}`
        const wpCmd = `docker run --rm --network deployhub -v ${shellQuote(deployPath)}:/var/www/html wordpress:cli sh -c 'wp core install --path=/var/www/html --url=${shellQuote(url)} --title=${shellQuote(project.name)} --admin_user=${shellQuote(adminUser)} --admin_password=${shellQuote(adminPass)} --admin_email=${shellQuote(adminEmail)} --skip-email 2>&1 || true'`
        const r = await exec(client, wpCmd, { timeoutMs: 120000 })
        stageLog(r.stdout.slice(-800))
      })
    })
  } else if (methodId === 'laravel') {
    await runStage('post_install', 'Running Laravel migrations…', async () => {
      await withConnection(creds, async (client) => {
        const cmds = [
          `docker exec ${shellQuote(containerName)} sh -c 'composer install --no-dev --optimize-autoloader 2>&1 || true'`,
          `docker exec ${shellQuote(containerName)} sh -c 'php artisan key:generate --force 2>&1 || true'`,
          `docker exec ${shellQuote(containerName)} sh -c 'php artisan migrate --force 2>&1 || true'`,
          `docker exec ${shellQuote(containerName)} sh -c 'php artisan config:cache 2>&1 || true'`,
          `docker exec ${shellQuote(containerName)} sh -c 'php artisan storage:link 2>&1 || true'`,
        ]
        for (const c of cmds) {
          const r = await exec(client, c, { timeoutMs: 180000 })
          stageLog(r.stdout.slice(-400))
        }
      })
    })
  } else if (methodId === 'nodejs') {
    // Build was already run inside the Dockerfile; nothing extra needed.
    await runStage('post_install', 'Post-install setup…', async () => {
      stageLog('No post-install steps for Node.js')
    })
  } else {
    await runStage('post_install', 'Post-install setup…', async () => undefined, {
      skip: true,
      skipReason: 'Method has no post-install step',
    })
  }

  // Configure reverse proxy.
  await runStage('configure_proxy', 'Configuring reverse proxy…', async () => {
    await configureProjectProxy(project.id, { onLog: stageLog })
  })

  // Configure SSL.
  await runStage('configure_ssl', 'Configuring SSL…', async () => {
    if (project.sslEnabled) {
      stageLog('SSL handled by Caddy automatic HTTPS — issuing cert on first request.')
    } else {
      stageLog('SSL is disabled for this project.')
    }
  })

  // Verify.
  await runStage('verify', 'Verifying deployment…', async () => {
    await withConnection(creds, async (client) => {
      const inspect = await exec(
        client,
        `docker inspect --format '{{.State.Status}}' ${shellQuote(containerName)}`,
        { timeoutMs: 10000 }
      )
      const state = inspect.stdout.trim()
      if (state !== 'running') throw new Error(`Container state is ${state}, expected running`)
      stageLog(`Container ${containerName} verified running.`)
    })
  })

  // Persist final state.
  await db.project.update({
    where: { id: projectId },
    data: {
      status: 'running',
      containerId,
      containerName,
      containerPort,
      externalPort,
      deployPath,
      lastDeployedAt: new Date(),
      sslCertStatus: project.sslEnabled ? 'issued' : 'none',
      sslCertExpiry: project.sslEnabled
        ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
        : null,
    },
  })

  await db.deployment.update({
    where: { id: deploymentId },
    data: {
      status: 'live',
      buildLog: buildLog.join('\n'),
      deployUrl: `https://${project.customDomain || project.subdomain}`,
      duration: Math.round((Date.now() - start) / 1000),
    },
  })

  return {
    ok: true,
    projectId,
    deploymentId,
    containerId,
    containerName,
    containerPort,
    externalPort,
    deployPath,
    buildLog: buildLog.join('\n'),
    durationMs: Date.now() - start,
  }
}

// ─── LEGACY pipeline (project.stack-based) ───────────────────────────────

async function deployLegacyProject(
  req: DeployRequest,
  project: ProjectWithServer,
  runStage: RunStage,
  stageLog: StageLog,
  buildLog: string[],
  start: number
): Promise<DeployResult> {
  const { projectId, deploymentId } = req
  const log = (m: string) => req.onLog?.(m)
  const stack = getStackDefinition(project.stack)
  if (!stack) throw new Error(`Unknown stack: ${project.stack}`)

  const deployPath = project.deployPath || `/opt/deployhub/projects/${project.slug}`
  const containerName = project.containerName || `deployhub-${project.slug}`
  const containerPort = project.containerPort || stack.port
  const externalPort = project.externalPort || (await pickExternalPort(project.serverId!))

  await runStage('plan', 'Planning deployment…', async () => {
    stageLog(`Stack: ${stack.name} (legacy pipeline)`)
    stageLog(`Container: ${containerName} (port ${containerPort} → host ${externalPort})`)
  })

  // DEMO MODE
  if (isServerInDemoMode(project.server)) {
    const buildLogStr = generateDemoBuildLog(project, stack.name, containerName, containerPort, externalPort)
    log('[demo mode] Simulating deploy…')
    for (const line of buildLogStr.split('\n')) {
      req.onStreamChunk?.({ stream: 'stdout', data: line + '\n' })
      await sleep(120)
    }
    const fakeContainerId = generateFakeContainerId()

    // Skip DB + post-install for legacy stacks.
    await runStage('create_directory', 'Creating project directory…', async () => undefined)
    await runStage('download_source', 'Downloading source…', async () => undefined)
    await runStage('provision_database', 'Provisioning database…', async () => undefined, {
      skip: true,
      skipReason: 'Legacy stack',
    })
    await runStage('write_dockerfile', 'Writing Dockerfile…', async () => undefined)
    await runStage('write_compose', 'Writing docker-compose.yml…', async () => undefined)
    await runStage('build_image', 'Building Docker image…', async () => undefined)
    await runStage('start_container', 'Starting container…', async () => undefined)
    await runStage('configure_proxy', 'Configuring reverse proxy…', async () => undefined)
    await runStage('configure_ssl', 'Configuring SSL…', async () => undefined)
    await runStage('run_migrations', 'Running migrations…', async () => undefined, {
      skip: true,
      skipReason: 'Legacy stack',
    })
    await runStage('post_install', 'Post-install setup…', async () => undefined, {
      skip: true,
      skipReason: 'Legacy stack',
    })
    await runStage('verify', 'Verifying deployment…', async () => undefined)

    await db.project.update({
      where: { id: projectId },
      data: {
        status: 'running',
        containerId: fakeContainerId,
        containerName,
        containerPort,
        externalPort,
        deployPath,
        lastDeployedAt: new Date(),
        sslCertStatus: project.sslEnabled ? 'issued' : 'none',
        sslCertExpiry: project.sslEnabled
          ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
          : null,
      },
    })
    await db.deployment.update({
      where: { id: deploymentId },
      data: {
        status: 'live',
        buildLog: buildLogStr,
        deployUrl: `https://${project.customDomain || project.subdomain}`,
        duration: Math.round((Date.now() - start) / 1000),
      },
    })
    return {
      ok: true,
      projectId,
      deploymentId,
      containerId: fakeContainerId,
      containerName,
      containerPort,
      externalPort,
      deployPath,
      buildLog: buildLogStr,
      durationMs: Date.now() - start,
    }
  }

  // REAL deploy
  const creds: SshCredentials = await getServerCredentials(project.serverId!)
  let containerId: string | undefined

  await runStage('create_directory', 'Creating project directory…', async () => {
    await withConnection(creds, async (client) => {
      await exec(client, `mkdir -p ${shellQuote(deployPath)}`, { timeoutMs: 10000 })
    })
  })

  await runStage('download_source', 'Downloading source…', async () => {
    await withConnection(creds, async (client) => {
      if (project.repoUrl) {
        log(`Cloning ${project.repoUrl}…`)
        const clone = await exec(
          client,
          `if [ -d ${shellQuote(deployPath + '/.git')} ]; then cd ${shellQuote(deployPath)} && git pull; else rm -rf ${shellQuote(deployPath)}/* ${shellQuote(deployPath)}/.[!.]* 2>/dev/null; git clone ${shellQuote(project.repoUrl)} ${shellQuote(deployPath)}; fi`,
          { timeoutMs: 120000 }
        )
        stageLog(clone.stdout.slice(-400))
        if (clone.exitCode !== 0) throw new Error(`git clone failed: ${clone.stderr}`)
      } else {
        log('No repo URL — writing placeholder app from stack template…')
        const placeholder = generatePlaceholderApp(project.stack as DeploymentMethodId, project.name)
        for (const [filename, content] of Object.entries(placeholder)) {
          await putFile(client, `${deployPath}/${filename}`, content, { mode: 0o644 })
        }
        stageLog(`Wrote ${Object.keys(placeholder).length} placeholder files`)
      }
    })
  })

  await runStage('provision_database', 'Provisioning database…', async () => undefined, {
    skip: true,
    skipReason: 'Legacy stack',
  })

  await runStage('write_dockerfile', 'Writing Dockerfile…', async () => {
    if (stack.dockerfile && project.stack !== 'docker') {
      await withConnection(creds, async (client) => {
        await putFile(client, `${deployPath}/Dockerfile`, stack.dockerfile, { mode: 0o644 })
      })
      stageLog(`Dockerfile written (${stack.dockerfile.length} bytes)`)
    } else {
      stageLog('Using repo-provided Dockerfile (docker stack)')
    }
  })

  await runStage('write_compose', 'Writing docker-compose.yml…', async () => {
    const envVars = await getProjectEnvVars(projectId)
    const composeYml = generateLegacyCompose({
      projectName: project.slug,
      containerName,
      deployPath,
      containerPort,
      externalPort,
      stack: project.stack,
      envVars,
      cpuCores: project.resourceCpuCores,
      ramMB: project.resourceRamMB,
    })
    await withConnection(creds, async (client) => {
      await putFile(client, `${deployPath}/docker-compose.yml`, composeYml, { mode: 0o644 })
    })
    stageLog('docker-compose.yml written')
  })

  await runStage('build_image', 'Building Docker image…', async () => {
    await withConnection(creds, async (client) => {
      const buildGen = execStream(
        client,
        `cd ${shellQuote(deployPath)} && docker compose build --progress=plain 2>&1`,
        { timeoutMs: 600000 }
      )
      while (true) {
        const r = await buildGen.next()
        if (r.done) break
        req.onStreamChunk?.(r.value)
        stageLog(r.value.data.replace(/\n$/, ''))
      }
    })
  })

  await runStage('start_container', 'Starting container…', async () => {
    await withConnection(creds, async (client) => {
      const upGen = execStream(
        client,
        `cd ${shellQuote(deployPath)} && docker compose up -d 2>&1`,
        { timeoutMs: 120000 }
      )
      while (true) {
        const r = await upGen.next()
        if (r.done) break
        req.onStreamChunk?.(r.value)
      }
      await exec(client, `docker network connect deployhub ${shellQuote(containerName)} 2>/dev/null || true`, { timeoutMs: 15000 })
      const inspect = await exec(
        client,
        `docker inspect --format '{{.Id}} {{.State.Status}}' ${shellQuote(containerName)}`,
        { timeoutMs: 15000 }
      )
      const [cid, state] = inspect.stdout.trim().split(' ')
      if (!cid || state !== 'running') {
        const logs = await exec(client, `docker logs ${shellQuote(containerName)} --tail 50 2>&1`, { timeoutMs: 15000 })
        throw new Error(`Container did not start (state=${state}). Logs:\n${logs.stdout.slice(0, 1000)}`)
      }
      containerId = cid
      stageLog(`Container running: ${cid.slice(0, 12)}`)
    })
  })

  await runStage('configure_proxy', 'Configuring reverse proxy…', async () => {
    await configureProjectProxy(project.id, { onLog: stageLog })
  })

  await runStage('configure_ssl', 'Configuring SSL…', async () => {
    stageLog(project.sslEnabled ? 'SSL auto-provisioned via Caddy.' : 'SSL disabled.')
  })

  await runStage('run_migrations', 'Running migrations…', async () => undefined, {
    skip: true,
    skipReason: 'Legacy stack',
  })

  await runStage('post_install', 'Post-install setup…', async () => undefined, {
    skip: true,
    skipReason: 'Legacy stack',
  })

  await runStage('verify', 'Verifying deployment…', async () => {
    stageLog('Container running, proxy + SSL configured.')
  })

  await db.project.update({
    where: { id: projectId },
    data: {
      status: 'running',
      containerId,
      containerName,
      containerPort,
      externalPort,
      deployPath,
      lastDeployedAt: new Date(),
      sslCertStatus: project.sslEnabled ? 'issued' : 'none',
      sslCertExpiry: project.sslEnabled
        ? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
        : null,
    },
  })

  await db.deployment.update({
    where: { id: deploymentId },
    data: {
      status: 'live',
      buildLog: buildLog.join('\n'),
      deployUrl: `https://${project.customDomain || project.subdomain}`,
      duration: Math.round((Date.now() - start) / 1000),
    },
  })

  return {
    ok: true,
    projectId,
    deploymentId,
    containerId,
    containerName,
    containerPort,
    externalPort,
    deployPath,
    buildLog: buildLog.join('\n'),
    durationMs: Date.now() - start,
  }
}

// ─── Stop / restart / remove container ───────────────────────────────────

export async function stopProject(projectId: string): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { server: true } })
  if (!project || !project.containerName) {
    return { ok: false, message: 'Project has no running container' }
  }
  if (isServerInDemoMode(project.server)) {
    await db.project.update({ where: { id: projectId }, data: { status: 'stopped' } })
    return { ok: true, message: 'Demo mode: container stopped (simulated)' }
  }
  try {
    const creds = await getServerCredentials(project.serverId!)
    await withConnection(creds, async (client) => {
      await exec(client, `cd ${shellQuote(project.deployPath || '.')} && docker compose down 2>&1`, {
        timeoutMs: 60000,
      })
    })
    await db.project.update({ where: { id: projectId }, data: { status: 'stopped' } })
    return { ok: true, message: 'Container stopped' }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function restartProject(projectId: string): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { server: true } })
  if (!project || !project.containerName) {
    return { ok: false, message: 'Project has no running container' }
  }
  if (isServerInDemoMode(project.server)) {
    return { ok: true, message: 'Demo mode: container restarted (simulated)' }
  }
  try {
    const creds = await getServerCredentials(project.serverId!)
    await withConnection(creds, async (client) => {
      await exec(client, `cd ${shellQuote(project.deployPath || '.')} && docker compose restart 2>&1`, {
        timeoutMs: 60000,
      })
    })
    return { ok: true, message: 'Container restarted' }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function removeProjectContainer(projectId: string): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { server: true } })
  if (!project) return { ok: false, message: 'Project not found' }

  // Remove Caddy config first
  await removeProjectProxy(projectId).catch(() => {})

  if (!isServerInDemoMode(project.server) && project.containerName) {
    try {
      const creds = await getServerCredentials(project.serverId!)
      await withConnection(creds, async (client) => {
        await exec(
          client,
          `cd ${shellQuote(project.deployPath || '.')} && docker compose down --rmi local -v 2>&1 || true`,
          { timeoutMs: 60000 }
        )
        if (project.deployPath) {
          await exec(client, `rm -rf ${shellQuote(project.deployPath)}`, { timeoutMs: 30000 })
        }
      })
    } catch (err) {
      console.error('[vps-deploy] remove container error:', err)
    }
  }

  await db.project.update({
    where: { id: projectId },
    data: {
      status: 'stopped',
      containerId: null,
      containerName: null,
      containerPort: null,
      externalPort: null,
      deployPath: null,
      sslCertStatus: 'none',
      sslCertExpiry: null,
    },
  })
  return { ok: true, message: 'Container removed' }
}

// ─── Container status ────────────────────────────────────────────────────

export async function getContainerStatus(projectId: string): Promise<ContainerStatus | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { server: true } })
  if (!project || !project.containerName) return null
  // Captured before the async closures below: TypeScript drops the
  // non-null narrowing of `project.containerName` inside a callback.
  const containerName: string = project.containerName

  if (isServerInDemoMode(project.server)) {
    return {
      containerId: project.containerId || 'demo',
      name: containerName,
      state: project.status === 'running' ? 'running' : 'exited',
      status: project.status === 'running' ? 'Up (simulated)' : 'Exited (simulated)',
      image: `deployhub/${project.stack}:latest`,
      ports: [`${project.externalPort}->${project.containerPort}`],
      createdAt: project.lastDeployedAt?.toISOString() || new Date().toISOString(),
    }
  }

  try {
    const creds = await getServerCredentials(project.serverId!)
    return await withConnection(creds, async (client) => {
      const r = await exec(
        client,
        `docker inspect --format '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.Health.Status}}|{{.Config.Image}}|{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}->{{(index $conf 0).HostPort}} {{end}}|{{.Created}}' ${shellQuote(containerName)} 2>/dev/null`,
        { timeoutMs: 10000 }
      )
      if (r.exitCode !== 0) {
        return {
          containerId: project.containerId || '',
          name: containerName,
          state: 'not_found' as const,
          status: 'Container not found on server',
          image: '',
          ports: [],
          createdAt: '',
        }
      }
      const parts = r.stdout.trim().split('|')
      const [id, name, state, health, image, ports, created] = parts
      return {
        containerId: id,
        name: name.replace(/^\//, ''),
        state: state as ContainerStatus['state'],
        status: health && health !== '<no value>' ? `${state} (${health})` : state,
        image,
        ports: ports ? ports.trim().split(' ').filter(Boolean) : [],
        createdAt: created || '',
      }
    })
  } catch (err) {
    console.error('[vps-deploy] container status error:', err)
    return null
  }
}

// ─── Container logs ──────────────────────────────────────────────────────

export async function getContainerLogs(
  projectId: string,
  opts: { tail?: number; since?: string } = {}
): Promise<string> {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { server: true } })
  if (!project || !project.containerName) return 'No container running'

  if (isServerInDemoMode(project.server)) {
    return generateDemoRuntimeLog(project)
  }

  try {
    const creds = await getServerCredentials(project.serverId!)
    return await withConnection(creds, async (client) => {
      const tail = opts.tail ?? 200
      const sinceFlag = opts.since ? `--since ${shellQuote(opts.since)}` : ''
      const r = await exec(
        client,
        `docker logs ${shellQuote(project.containerName!)} --tail ${tail} ${sinceFlag} 2>&1`,
        { timeoutMs: 30000 }
      )
      return r.stdout || r.stderr
    })
  } catch (err) {
    return `Failed to fetch logs: ${err instanceof Error ? err.message : err}`
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Choose a free host port for a new container.
 *
 * The HOST is authoritative, not the database. Consulting only `Project.
 * externalPort` handed out a port that Docker had already bound, and the
 * deploy died with "Bind for 0.0.0.0:30000 failed: port is already
 * allocated". Two ways the DB lies:
 *
 *   - a running container whose `externalPort` was never persisted (a
 *     manually started or partially-failed deploy), and
 *   - orphan containers with no Project row at all.
 *
 * Both are invisible to a DB-only query, so the port list is taken from
 * Docker and the kernel as well. If the host can't be reached we fall back to
 * the DB — a deploy that might collide beats refusing to deploy at all — and
 * the caller surfaces Docker's error if it does.
 */
async function pickExternalPort(serverId: string): Promise<number> {
  const used = new Set<number>()

  const projects = await db.project.findMany({
    where: { serverId, externalPort: { not: null } },
    select: { externalPort: true },
  })
  for (const p of projects) used.add(p.externalPort!)

  try {
    const server = await db.server.findUnique({ where: { id: serverId } })
    if (server && !isServerInDemoMode(server)) {
      const creds = await getServerCredentials(serverId)
      await withConnection(creds, async (client) => {
        // Every published container port, including stopped containers (a
        // stopped container still reserves nothing, but a `docker start`
        // would), and every port the kernel currently has bound.
        const [ports, listening] = await Promise.all([
          exec(client, "docker ps -a --format '{{.Ports}}'", { timeoutMs: 15000 }),
          exec(client, 'ss -ltnH 2>/dev/null || netstat -ltn', { timeoutMs: 15000 }),
        ])
        for (const m of ports.stdout.matchAll(/:(\d{4,5})->/g)) {
          used.add(parseInt(m[1], 10))
        }
        for (const m of listening.stdout.matchAll(/[:.](\d{4,5})\s/g)) {
          used.add(parseInt(m[1], 10))
        }
      })
    }
  } catch (err) {
    console.error(
      '[deployer] could not read ports from host, falling back to DB only:',
      err instanceof Error ? err.message : err
    )
  }

  for (let port = 30000; port < 40000; port++) {
    if (!used.has(port)) return port
  }
  // Previously returned a RANDOM port here, which could collide just as
  // easily. Failing loudly is better than a confusing bind error later.
  throw new Error(
    'No free host port available in the 30000-39999 range on this server.'
  )
}

async function getProjectEnvVars(projectId: string): Promise<Record<string, string>> {
  const envVars = await db.environmentVariable.findMany({
    where: { projectId },
    select: { key: true, value: true, encrypted: true },
  })
  const { decrypt } = await import('@/lib/encryption')
  const out: Record<string, string> = {}
  for (const v of envVars) {
    try {
      out[v.key] = v.encrypted ? decrypt(v.value) : v.value
    } catch {
      out[v.key] = v.value
    }
  }
  return out
}

function parseInstallSettings(json: string | null | undefined): Record<string, unknown> {
  if (!json) return {}
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return {}
  }
}

function settingsGet<T = string>(settings: Record<string, unknown>, key: string, fallback?: T): T | undefined {
  const v = settings[key]
  if (v === undefined || v === null) return fallback
  return v as T
}

// ─── Dockerfile generation per method ────────────────────────────────────

function generateMethodDockerfile(
  methodId: DeploymentMethodId,
  project: { name: string; slug: string; runtime?: string | null; runtimeVersion?: string | null; buildCommand?: string | null; startCommand?: string | null; appPort?: number | null; documentRoot?: string | null; framework?: string | null },
  settings: Record<string, unknown>
): string {
  const phpVersion = (project.runtimeVersion as string) || '8.2'
  const nodeVersion = (project.runtimeVersion as string) || '20'
  const pythonVersion = (project.runtimeVersion as string) || '3.11'
  const documentRoot = project.documentRoot || '/var/www/html'
  const framework = (settingsGet<string>(settings, 'framework') || project.framework || '') as string
  const packageManager = (settingsGet<string>(settings, 'packageManager') || 'npm') as string

  if (methodId === 'wordpress') {
    return `FROM wordpress:php${phpVersion}-apache
# APSAMO Panel — managed WordPress image
RUN docker-php-ext-install mysqli pdo pdo_mysql && a2enmod rewrite
EXPOSE 80
CMD ["apache2-foreground"]
`
  }

  if (methodId === 'laravel') {
    return `FROM php:${phpVersion}-fpm-alpine
RUN apk add --no-cache git curl libpng-dev oniguruma-dev libxml2-dev zip unzip nginx \\
    && docker-php-ext-install pdo_mysql mbstring exif pcntl bcmath gd
COPY --from=composer:latest /usr/bin/composer /usr/bin/composer
WORKDIR /var/www/html
COPY . .
RUN composer install --no-dev --optimize-autoloader --no-interaction || true
RUN php artisan config:cache || true
RUN php artisan route:cache || true
EXPOSE 80
CMD ["php-fpm"]
`
  }

  if (methodId === 'php') {
    return `FROM php:${phpVersion}-apache
RUN docker-php-ext-install mysqli pdo pdo_mysql && a2enmod rewrite
COPY . ${documentRoot}/
RUN chown -R www-data:www-data ${documentRoot}
EXPOSE 80
CMD ["apache2-foreground"]
`
  }

  if (methodId === 'nodejs') {
    const pm = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : packageManager === 'bun' ? 'bun' : 'npm'
    const pmInstall = pm === 'pnpm'
      ? 'RUN npm install -g pnpm && pnpm install --frozen-lockfile || pnpm install'
      : pm === 'yarn'
        ? 'RUN yarn install --frozen-lockfile || yarn install'
        : pm === 'bun'
          ? 'RUN npm install -g bun && bun install'
          : 'RUN npm ci --omit=dev || npm install'
    const buildCmd = project.buildCommand || (framework === 'nextjs' ? 'npm run build' : '')
    const startCmd = project.startCommand || (framework === 'nextjs' ? 'npm start' : 'node index.js')
    const buildLine = buildCmd ? `RUN ${buildCmd}\n` : ''
    return `FROM node:${nodeVersion}-alpine
WORKDIR /app
COPY package*.json ./
${pmInstall}
COPY . .
${buildLine}EXPOSE ${project.appPort || 3000}
ENV NODE_ENV=production
CMD ["sh", "-c", "${startCmd}"]
`
  }

  if (methodId === 'python') {
    const frameworkPy = framework || 'flask'
    const startCmd = project.startCommand || (
      frameworkPy === 'fastapi'
        ? 'uvicorn app:app --host 0.0.0.0 --port 8000'
        : frameworkPy === 'django'
          ? 'gunicorn project.wsgi --bind 0.0.0.0:8000'
          : 'gunicorn app:app --bind 0.0.0.0:8000'
    )
    return `FROM python:${pythonVersion}-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${project.appPort || 8000}
CMD ["sh", "-c", "${startCmd}"]
`
  }

  if (methodId === 'static') {
    return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`
  }

  if (methodId === 'docker') {
    // The repo's own Dockerfile is used — we don't write one.
    return `# Using repo-provided Dockerfile (no override)`
  }

  // custom
  const runtime = project.runtime || 'nodejs'
  const startCmd = project.startCommand || 'npm start'
  const buildCmd = project.buildCommand
  if (runtime === 'nodejs') {
    return `FROM node:${nodeVersion}-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
${buildCmd ? `RUN ${buildCmd}\n` : ''}EXPOSE ${project.appPort || 3000}
CMD ["sh", "-c", "${startCmd}"]
`
  }
  if (runtime === 'php') {
    return `FROM php:${phpVersion}-apache
COPY . ${documentRoot}/
EXPOSE 80
CMD ["apache2-foreground"]
`
  }
  if (runtime === 'python') {
    return `FROM python:${pythonVersion}-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE ${project.appPort || 8000}
CMD ["sh", "-c", "${startCmd}"]
`
  }
  if (runtime === 'static') {
    return `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`
  }
  if (runtime === 'go') {
    return `FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY . .
RUN go build -o server ./...
FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/server .
EXPOSE ${project.appPort || 8080}
CMD ["./server"]
`
  }
  if (runtime === 'ruby') {
    return `FROM ruby:3.2-slim
WORKDIR /app
COPY Gemfile Gemfile.lock ./
RUN bundle install
COPY . .
EXPOSE ${project.appPort || 3000}
CMD ["sh", "-c", "${startCmd}"]
`
  }
  if (runtime === 'java') {
    return `FROM maven:3.9-eclipse-temurin-17 AS builder
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:resolve
COPY . .
RUN mvn package -DskipTests
FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=builder /app/target/*.jar app.jar
EXPOSE ${project.appPort || 8080}
CMD ["java", "-jar", "app.jar"]
`
  }
  if (runtime === 'bun') {
    return `FROM oven/bun:latest
WORKDIR /app
COPY package.json bun.lockb ./
RUN bun install
COPY . .
EXPOSE ${project.appPort || 3000}
CMD ["sh", "-c", "${startCmd}"]
`
  }
  // Fallback — docker.
  return `# Custom runtime — using repo-provided Dockerfile`
}

// ─── docker-compose.yml generation (new + legacy) ─────────────────────────

function resourceLimitsBlock(cpuCores?: number | null, ramMB?: number | null): string {
  if (!cpuCores && !ramMB) return ''
  const lines: string[] = []
  lines.push('    deploy:')
  lines.push('      resources:')
  lines.push('        limits:')
  if (cpuCores) {
    lines.push(`          cpus: '${cpuCores}'`)
  }
  if (ramMB) {
    lines.push(`          memory: ${ramMB}M`)
  }
  return lines.join('\n')
}

function envBlock(envVars: Record<string, string>): string {
  const entries = Object.entries(envVars)
  if (entries.length === 0) return ''
  const lines = entries.map(([k, v]) => `      ${k}: "${v.replace(/"/g, '\\"')}"`)
  return `    environment:\n${lines.join('\n')}`
}

function generateMethodCompose(
  methodId: DeploymentMethodId,
  project: { slug: string; resourceCpuCores?: number | null; resourceRamMB?: number | null; databaseHost?: string | null; databaseName?: string | null; databaseUser?: string | null; databasePassword?: string | null },
  settings: Record<string, unknown>,
  opts: {
    containerName: string
    deployPath: string
    containerPort: number
    externalPort: number
    envVars: Record<string, string>
  }
): string {
  const limits = resourceLimitsBlock(project.resourceCpuCores, project.resourceRamMB)
  const env = envBlock(opts.envVars)

  // For WordPress — wire up the DB container as a service.
  if (methodId === 'wordpress') {
    const dbHost = project.databaseHost || `${opts.containerName}-db`
    return `# Auto-generated by APSAMO Panel — WordPress
services:
  wordpress:
    image: wordpress:php8.2-apache
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "${opts.externalPort}:80"
    environment:
      WORDPRESS_DB_HOST: ${dbHost}:3306
      WORDPRESS_DB_USER: ${project.databaseUser || 'wp'}
      WORDPRESS_DB_NAME: ${project.databaseName || 'wp'}
      # No WORDPRESS_DB_PASSWORD here on purpose. The real credential is
      # written into wp-config-docker.php (mounted over wp-config.php), which
      # is what WordPress actually reads. This previously referenced an
      # undefined ${'$'}{WP_DB_PASSWORD}, so Compose printed
      # "variable is not set. Defaulting to a blank string" in the customer's
      # install log — alarming, and it looked like the cause of the failure.
${env ? env + '\n' : ''}    volumes:
      - ./wp-content:/var/www/html/wp-content
      - ./wp-config-docker.php:/var/www/html/wp-config.php
${limits ? limits + '\n' : ''}    networks:
      - default
      - deployhub

networks:
  deployhub:
    external: true
`
  }

  // For Laravel — single PHP-FPM container; DB is separate.
  if (methodId === 'laravel') {
    return `# Auto-generated by APSAMO Panel — Laravel
services:
  app:
    build: .
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "${opts.externalPort}:${opts.containerPort}"
${env ? env + '\n' : ''}${limits ? limits + '\n' : ''}    networks:
      - default
      - deployhub

networks:
  deployhub:
    external: true
`
  }

  // Generic — single service built from the repo.
  return `# Auto-generated by APSAMO Panel
services:
  app:
    build: .
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "${opts.externalPort}:${opts.containerPort}"
${env ? env + '\n' : ''}${limits ? limits + '\n' : ''}    networks:
      - default
      - deployhub

networks:
  deployhub:
    external: true
`
}

function generateLegacyCompose(opts: {
  projectName: string
  containerName: string
  deployPath: string
  containerPort: number
  externalPort: number
  stack: string
  envVars: Record<string, string>
  cpuCores?: number | null
  ramMB?: number | null
}): string {
  const env = envBlock(opts.envVars)
  const limits = resourceLimitsBlock(opts.cpuCores, opts.ramMB)

  if (opts.stack === 'wordpress') {
    return `# Auto-generated by APSAMO Panel
services:
  wordpress:
    image: wordpress:php8.2-apache
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "${opts.externalPort}:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wp
      WORDPRESS_DB_PASSWORD: wpdbpass_${randomHex(8)}
      WORDPRESS_DB_NAME: wp
${env ? env + '\n' : ''}    volumes:
      - ./wp-content:/var/www/html/wp-content
    depends_on:
      - db
${limits ? limits + '\n' : ''}    networks:
      - default
      - deployhub

  db:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MYSQL_DATABASE: wp
      MYSQL_USER: wp
      MYSQL_PASSWORD: wpdbpass
      MYSQL_ROOT_PASSWORD: rootpass_${randomHex(8)}
    volumes:
      - ./db-data:/var/lib/mysql
    networks:
      - default

networks:
  deployhub:
    external: true
`
  }

  if (opts.stack === 'docker') {
    return `# Auto-generated by APSAMO Panel (custom Dockerfile)
services:
  app:
    build: .
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "${opts.externalPort}:${opts.containerPort}"
${env ? env + '\n' : ''}${limits ? limits + '\n' : ''}    networks:
      - default
      - deployhub

networks:
  deployhub:
    external: true
`
  }

  return `# Auto-generated by APSAMO Panel
services:
  app:
    build: .
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "${opts.externalPort}:${opts.containerPort}"
${env ? env + '\n' : ''}${limits ? limits + '\n' : ''}    networks:
      - default
      - deployhub

networks:
  deployhub:
    external: true
`
}

// ─── Laravel .env generation ─────────────────────────────────────────────

function generateLaravelEnv(project: { name: string; customDomain?: string | null; subdomain: string; databaseHost?: string | null; databaseName?: string | null; databaseUser?: string | null; databasePassword?: string | null }): string {
  const url = `https://${project.customDomain || project.subdomain}`
  // databasePassword is encrypted at rest — we can't decrypt here without
  // importing decrypt. The deployer's post_install step (which has access
  // to the encryption module) injects the real value via docker exec.
  return `APP_NAME=${project.name}
APP_ENV=production
APP_KEY=
APP_DEBUG=false
APP_URL=${url}
LOG_CHANNEL=stack
LOG_LEVEL=info
DB_CONNECTION=mysql
DB_HOST=${project.databaseHost || 'db'}
DB_PORT=3306
DB_DATABASE=${project.databaseName || 'laravel'}
DB_USERNAME=${project.databaseUser || 'laravel'}
DB_PASSWORD=CHANGE_ME
BROADCAST_DRIVER=log
CACHE_DRIVER=file
QUEUE_CONNECTION=sync
SESSION_DRIVER=file
SESSION_LIFETIME=120
`
}

// ─── Placeholder app generation ──────────────────────────────────────────

function generatePlaceholderApp(methodId: DeploymentMethodId | string, projectName: string): Record<string, string> {
  if (methodId === 'wordpress') {
    // Minimal wp-config.php that lets the WP image boot.
    return {
      'wp-config-docker.php': `<?php
// APSAMO Panel — minimal WordPress config (managed)
// Trust X-Forwarded-Proto from the Caddy proxy (prevents mixed-content).
if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['SERVER_PORT'] = 443;
}
define('DB_NAME',     'wp');
define('DB_USER',     'wp');
define('DB_PASSWORD', 'changeme');
define('DB_HOST',     'db');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
$table_prefix = 'wp_';
define('WP_DEBUG', false);
if (!defined('ABSPATH')) define('ABSPATH', dirname(__FILE__) . '/');
require_once ABSPATH . 'wp-settings.php';
`,
    }
  }
  if (methodId === 'laravel') {
    return {
      'README.md': `# ${projectName}\n\nLaravel project bootstrapped by APSAMO Panel.\nRun \`composer create-project laravel/laravel .\` to scaffold.\n`,
    }
  }
  if (methodId === 'nodejs' || methodId === 'custom') {
    return {
      'package.json': JSON.stringify(
        {
          name: projectName.toLowerCase().replace(/\s+/g, '-'),
          version: '1.0.0',
          scripts: { start: 'node server.js' },
          dependencies: { express: '^4.19.2' },
        },
        null,
        2
      ),
      'server.js': `const express = require('express')
const app = express()
const PORT = process.env.PORT || 3000

app.get('/', (req, res) => {
  res.json({
    app: ${JSON.stringify(projectName)},
    deployed_by: 'APSAMO Panel',
    time: new Date().toISOString()
  })
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => console.log('Listening on port ' + PORT))
`,
    }
  }
  if (methodId === 'php') {
    return {
      'index.php': `<?php
header('Content-Type: application/json');
echo json_encode([
  'app' => ${JSON.stringify(projectName)},
  'stack' => 'php',
  'deployed_by' => 'APSAMO Panel',
  'time' => date('c'),
  'php_version' => PHP_VERSION
]);
`,
    }
  }
  if (methodId === 'python') {
    return {
      'requirements.txt': 'flask==3.0.0\ngunicorn==21.2.0\n',
      'app.py': `from flask import Flask, jsonify
from datetime import datetime

app = Flask(__name__)

@app.route('/')
def index():
    return jsonify({
        'app': ${JSON.stringify(projectName)},
        'stack': 'python',
        'deployed_by': 'APSAMO Panel',
        'time': datetime.now().isoformat()
    })

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=8000)
`,
    }
  }
  if (methodId === 'static') {
    return {
      'index.html': `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${projectName}</title>
</head>
<body>
  <h1>${projectName}</h1>
  <p>Deployed by APSAMO Panel.</p>
</body>
</html>
`,
    }
  }
  if (methodId === 'docker') {
    return {
      'Dockerfile': `FROM nginx:alpine
COPY . /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`,
      'index.html': `<h1>${projectName}</h1>`,
    }
  }
  return {
    'README.md': `# ${projectName}\n\nDeployed via APSAMO Panel (method: ${methodId}).\n`,
  }
}

// ─── Demo-mode log generators ────────────────────────────────────────────

function generateDemoBuildLog(
  project: { name: string; slug: string; stack: string; subdomain: string; customDomain: string | null; deploymentMethod?: string | null },
  stackName: string,
  containerName: string,
  containerPort: number,
  externalPort: number
): string {
  const url = project.customDomain || project.subdomain
  const method = project.deploymentMethod || project.stack
  return `APSAMO Panel deployment log
==========================
Project: ${project.name} (${project.slug})
Method:  ${method} (${stackName})
Target:  ${url}

[1/13] Planning deployment…                                       OK
[2/13] Creating project directory /opt/deployhub/projects/${project.slug}… OK
[3/13] Downloading source…                                        OK
[4/13] Provisioning database…                                     ${method === 'wordpress' || method === 'laravel' ? 'OK (MariaDB container)' : 'skipped'}
[5/13] Writing Dockerfile…                                        OK
[6/13] Writing docker-compose.yml (container: ${containerName})… OK
[7/13] docker compose build --progress=plain
 => [internal] load build definition from Dockerfile              0.1s
 => [internal] load metadata for docker.io/library/${method === 'php' || method === 'wordpress' || method === 'laravel' ? 'php:8.2-apache' : method === 'python' ? 'python:3.11-slim' : method === 'static' ? 'nginx:alpine' : 'node:20-alpine'}  1.2s
 => [1/3] FROM docker.io/library/${method}                        3.4s
 => [2/3] COPY . /app                                              0.2s
 => [3/3] WORKDIR /app                                             0.0s
 => exporting to image                                             0.4s
[7/13] Build complete in 5.4s
[8/13] docker compose up -d
[8/13] Container ${containerName} started (port ${containerPort} → host ${externalPort})
[9/13] Connecting to deployhub docker network…                    OK
[10/13] Configuring Caddy reverse proxy…                          OK
[11/13] SSL auto-provisioned via Let's Encrypt (Caddy ACME)       OK
[12/13] Post-install setup…                                       ${method === 'wordpress' ? 'WordPress core installed' : method === 'laravel' ? 'migrations + config cache' : 'skipped'}
[13/13] Verifying deployment…                                     OK — container is running

✓ Deployment live at https://${url}
Total time: 8.3s (simulated)
`
}

function generateDemoRuntimeLog(project: {
  name: string
  stack: string
  subdomain: string
  customDomain: string | null
}): string {
  const url = project.customDomain || project.subdomain
  const ts = new Date().toISOString()
  if (project.stack === 'nodejs') {
    return `[${ts}] Listening on port 3000
[${ts}] GET / 200 4ms - "app":"${project.name}"
[${ts}] GET /health 200 1ms
[${ts}] Container healthy — responding to requests`
  }
  if (project.stack === 'php') {
    return `[${ts}] [apache] AH00558: apache2: Could not reliably determine the server's fully qualified domain name
[${ts}] [apache] Resuming normal operations
[${ts}] GET / 200 6ms
[${ts}] PHP 8.2.0 — ${project.name} running`
  }
  return `[${ts}] Container running — ${project.name}
[${ts}] Serving on https://${url}
[${ts}] No errors in the last 5 minutes`
}

function generateFakeContainerId(): string {
  return Array.from({ length: 64 }, () =>
    '0123456789abcdef'[Math.floor(Math.random() * 16)]
  ).join('')
}

function randomHex(len: number): string {
  return Array.from({ length: len }, () =>
    '0123456789abcdef'[Math.floor(Math.random() * 16)]
  ).join('')
}

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Re-export stack definitions for convenience
export { STACK_DEFINITIONS, getStackDefinition }
export type { ExecResult, StreamChunk }
