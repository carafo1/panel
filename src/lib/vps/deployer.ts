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
import { isValidEnvKey, yamlQuoted, safeRuntimeVersion, safeDocumentRoot } from '@/lib/safe-values'
import { getDeploymentMethod, type DeploymentMethodId } from '@/lib/deployment-methods'
import { encrypt, decrypt } from '@/lib/encryption'
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

/**
 * Put a personal access token on an https git remote.
 *
 * ssh remotes authenticate with keys, so they are left alone. The token is
 * never logged: `redactToken` scrubs it from anything echoed back from the VPS.
 */
export function authedGitUrl(
  url: string,
  token: string,
  provider?: string | null
): string {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return url
    u.username =
      provider === 'gitlab'
        ? 'oauth2'
        : provider === 'bitbucket'
          ? 'x-token-auth'
          : 'x-access-token'
    u.password = token
    return u.toString()
  } catch {
    return url
  }
}

function redactToken(s: string, token?: string | null): string {
  return token ? s.split(token).join('***') : s
}

/**
 * Git's own message for "private repo, no credentials" is
 * "could not read Username for 'https://github.com': No such device or
 * address", which tells a customer nothing. GitHub also returns 404 rather
 * than 403 for private repos, so "not found" genuinely can mean "no access".
 */
function gitAccessError(repoUrl: string, branch: string, stderr: string): string {
  if (
    /could not read Username|Authentication failed|Invalid username or password|terminal prompts disabled/i.test(
      stderr
    )
  ) {
    return (
      `Could not sign in to ${repoUrl}. If the repository is private, enter a ` +
      `personal access token in the Git step of the wizard — GitHub returns ` +
      `"not found" for private repositories you are not authenticated for.`
    )
  }
  if (/not found|does not exist|Could not find remote branch/i.test(stderr)) {
    return (
      `${repoUrl} could not be read on branch "${branch}". Check the URL and ` +
      `the branch name, and add an access token if the repository is private.`
    )
  }
  return `git clone failed: ${stderr}`
}

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
  // The name we ASK for. A project that brings its own compose file names its
  // own services, so the name we actually GET is resolved after `compose up`
  // and everything downstream uses that instead.
  let containerName = project.containerName || `deployhub-${project.slug}`
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
  const envVars = withRuntimePort(
    await getProjectEnvVars(projectId),
    containerPort
  )

  await runStage('create_directory', 'Creating project directory…', async () => {
    await withConnection(creds, async (client) => {
      await exec(client, `mkdir -p ${shellQuote(deployPath)}`, { timeoutMs: 10000 })
    })
  })

  await runStage('download_source', 'Downloading source…', async () => {
    await withConnection(creds, async (client) => {
      const source = project.deploymentSource || 'git'
      if (source === 'imported') {
        // The migration runner already placed the customer's real site here.
        // Every other branch below either replaces the directory contents or
        // writes a placeholder app, so re-running the source stage on an
        // imported project would delete the site it is meant to be building.
        stageLog('Files were placed by a site import — keeping them as-is.')
        return
      }
      if (source === 'git' && project.repoUrl) {
        stageLog(`Cloning ${project.repoUrl}…`)
        const branch = project.sourceBranch || 'main'
        // Decrypt the token the wizard collected, if there is one.
        let gitToken: string | null = null
        const tokenEnc = settingsGet<string>(settings, 'gitTokenEnc')
        if (tokenEnc) {
          try {
            gitToken = decrypt(tokenEnc)
          } catch (err) {
            stageLog('Stored git token could not be decrypted — cloning anonymously.')
          }
        }
        const cloneUrl = gitToken
          ? authedGitUrl(project.repoUrl, gitToken, project.sourceProvider)
          : project.repoUrl
        if (gitToken) stageLog('Using the stored access token for this repository.')
        // GIT_TERMINAL_PROMPT=0: without it git blocks trying to prompt for a
        // username on a private repo and only dies at the 180s timeout.
        const cloneCmd = `if [ -d ${shellQuote(deployPath + '/.git')} ]; then cd ${shellQuote(deployPath)} && GIT_TERMINAL_PROMPT=0 git fetch --all && git checkout ${shellQuote(branch)} && git reset --hard origin/${shellQuote(branch)}; else rm -rf ${shellQuote(deployPath)}/* ${shellQuote(deployPath)}/.[!.]* 2>/dev/null; GIT_TERMINAL_PROMPT=0 git clone --branch ${shellQuote(branch)} ${shellQuote(cloneUrl)} ${shellQuote(deployPath)}; fi`
        const r = await exec(client, cloneCmd, { timeoutMs: 180000 })
        stageLog(redactToken(r.stdout.slice(-500), gitToken))
        if (r.exitCode !== 0) {
          throw new Error(
            gitAccessError(
              project.repoUrl,
              branch,
              redactToken(r.stderr || '', gitToken)
            )
          )
        }
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
  //
  // The `docker` method means "this project builds itself" — its whole point
  // is the Dockerfile and compose file the customer wrote. Those were being
  // overwritten unconditionally: generateMethodDockerfile returns only a
  // comment for this method, so the customer's build instructions were
  // replaced with a file containing no FROM, and `docker build` then failed
  // with a syntax error on a Dockerfile they never wrote.
  const usesOwnBuildFiles = methodId === 'docker'
  // Set when we deferred to a compose file the project supplied, which means
  // the running container's name is theirs to choose, not ours to assume.
  let usingProvidedCompose = false
  const dockerfile = generateMethodDockerfile(methodId, project, settings, envVars)
  await runStage('write_dockerfile', 'Writing Dockerfile…', async () => {
    await withConnection(creds, async (client) => {
      const theirs = usesOwnBuildFiles
        ? await exec(
            client,
            `test -f ${shellQuote(deployPath + '/Dockerfile')} && echo yes || echo no`,
            { timeoutMs: 15000 }
          )
        : null
      if (theirs?.stdout.trim() === 'yes') {
        stageLog('Using the Dockerfile from your project (not overwriting it).')
      } else {
        if (usesOwnBuildFiles) {
          throw new Error(
            'This project is set to build from its own Dockerfile, but no Dockerfile was found at the project root.'
          )
        }
        await putFile(client, `${deployPath}/Dockerfile`, dockerfile, { mode: 0o644 })
        stageLog(`Dockerfile written (${dockerfile.length} bytes)`)
      }
      // .dockerignore is additive and safe to refresh either way — but don't
      // clobber one the customer supplied.
      const ignore = await exec(
        client,
        `test -f ${shellQuote(deployPath + '/.dockerignore')} && echo yes || echo no`,
        { timeoutMs: 15000 }
      )
      if (ignore.stdout.trim() !== 'yes') {
        await putFile(client, `${deployPath}/.dockerignore`, '.git\nnode_modules\n.env\n.env.local\n', { mode: 0o644 })
      }
    })
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
      if (usesOwnBuildFiles) {
        // compose.yaml is the modern spelling; both are honoured by
        // `docker compose`, and either one means the customer has defined
        // their own services — including ones we know nothing about.
        const existing = await exec(
          client,
          `for f in docker-compose.yml docker-compose.yaml compose.yml compose.yaml; do ` +
            `[ -f ${shellQuote(deployPath)}/$f ] && echo $f && break; done`,
          { timeoutMs: 15000 }
        )
        const found = existing.stdout.trim()
        if (found) {
          usingProvidedCompose = true
          stageLog(`Using ${found} from your project (not overwriting it).`)
          return
        }
      }
      await putFile(client, `${deployPath}/docker-compose.yml`, composeYml, { mode: 0o644 })
      stageLog('docker-compose.yml written')
    })
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
        // BUILDX_NO_DEFAULT_ATTESTATIONS: buildx writes an SBOM/provenance
        // attestation manifest by default. Nothing in this platform reads it.
        //
        // The timeout was 600s. A real customer build measured 660s for the
        // image step alone, so this was already past the limit and a slightly
        // larger app would have been killed mid-build with a confusing error.
        `cd ${shellQuote(deployPath)} && BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build --progress=plain 2>&1`,
        { timeoutMs: 1800000 }
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
      // A project-supplied compose file names its own containers, so the name
      // we assumed does not exist. Ask compose which container it actually
      // started rather than inspecting a name nothing answers to — otherwise
      // the deploy succeeds and then fails its own verification.
      if (usingProvidedCompose) {
        const ids = await exec(
          client,
          `cd ${shellQuote(deployPath)} && (docker compose ps -q 2>/dev/null || docker-compose ps -q 2>/dev/null) | head -1`,
          { timeoutMs: 30000 }
        )
        const firstId = ids.stdout.trim().split('\n')[0]?.trim()
        if (firstId) {
          const nameOut = await exec(
            client,
            `docker inspect --format '{{.Name}}' ${shellQuote(firstId)} 2>/dev/null || true`,
            { timeoutMs: 15000 }
          )
          const realName = nameOut.stdout.trim().replace(/^\//, '')
          if (realName && realName !== containerName) {
            stageLog(`Your compose file started "${realName}" — tracking that container.`)
            containerName = realName
          }
        } else {
          throw new Error(
            'Your compose file did not start any containers. Check that it defines at least one service.'
          )
        }
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

  // Only Laravel has work here, and it does it before the build (writing
  // .env, above). Every other method never called this stage at all, so the
  // row pre-created by /api/hosting/create stayed "pending" and the finished
  // deployment showed a step that looked stuck. The legacy path has always
  // marked it skipped; the method path never did.
  if (methodId !== 'laravel') {
    await runStage('run_migrations', 'Running migrations…', async () => undefined, {
      skip: true,
      skipReason: `No migration step for ${methodId}`,
    })
  }

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
          `if [ -d ${shellQuote(deployPath + '/.git')} ]; then cd ${shellQuote(deployPath)} && GIT_TERMINAL_PROMPT=0 git pull; else rm -rf ${shellQuote(deployPath)}/* ${shellQuote(deployPath)}/.[!.]* 2>/dev/null; GIT_TERMINAL_PROMPT=0 git clone ${shellQuote(project.repoUrl)} ${shellQuote(deployPath)}; fi`,
          { timeoutMs: 120000 }
        )
        stageLog(clone.stdout.slice(-400))
        if (clone.exitCode !== 0) {
          throw new Error(
            gitAccessError(project.repoUrl, project.sourceBranch || 'main', clone.stderr || '')
          )
        }
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
    const envVars = withRuntimePort(
      await getProjectEnvVars(projectId),
      containerPort
    )
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
        // BUILDX_NO_DEFAULT_ATTESTATIONS: buildx writes an SBOM/provenance
        // attestation manifest by default. Nothing in this platform reads it.
        //
        // The timeout was 600s. A real customer build measured 660s for the
        // image step alone, so this was already past the limit and a slightly
        // larger app would have been killed mid-build with a confusing error.
        `cd ${shellQuote(deployPath)} && BUILDX_NO_DEFAULT_ATTESTATIONS=1 docker compose build --progress=plain 2>&1`,
        { timeoutMs: 1800000 }
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

  // The container name is derived, NOT trusted from the row.
  //
  // This used to be gated on `project.containerName`, so a project whose
  // containerName was never persisted (a partially-failed deploy, or one
  // started outside the normal path) skipped teardown entirely — and the
  // function still returned {ok: true, message: 'Container removed'}. The
  // container kept running, holding its host port forever. Three such orphans
  // had accumulated on production, and two of them held the exact ports that
  // later broke a WordPress install with "port is already allocated".
  const containerName = project.containerName || `deployhub-${project.slug}`
  let removalVerified = false

  if (!isServerInDemoMode(project.server) && project.serverId) {
    try {
      const creds = await getServerCredentials(project.serverId)
      await withConnection(creds, async (client) => {
        // Preferred: compose down, which also removes networks and volumes.
        if (project.deployPath) {
          await exec(
            client,
            `cd ${shellQuote(project.deployPath)} && docker compose down --rmi local -v 2>&1 || true`,
            { timeoutMs: 60000 }
          )
        }
        // Belt and braces: compose only removes what its file declares, and
        // the deploy path may be gone. Force-remove by name too.
        await exec(client, `docker rm -f ${shellQuote(containerName)} 2>&1 || true`, {
          timeoutMs: 30000,
        })
        // Any sibling containers from the same compose project (e.g. the
        // WordPress DB) share the name prefix.
        await exec(
          client,
          `docker ps -aq --filter name=^${shellQuote(containerName)} | xargs -r docker rm -f 2>&1 || true`,
          { timeoutMs: 30000 }
        )
        if (project.deployPath) {
          await exec(client, `rm -rf ${shellQuote(project.deployPath)}`, { timeoutMs: 30000 })
        }
        // Confirm rather than assume — this function previously reported
        // success without checking anything.
        const check = await exec(
          client,
          `docker ps -aq --filter name=^${shellQuote(containerName)}$ | wc -l`,
          { timeoutMs: 15000 }
        )
        removalVerified = check.stdout.trim() === '0'
      })
    } catch (err) {
      console.error('[vps-deploy] remove container error:', err)
    }
  } else {
    // Demo mode / no server: nothing to tear down.
    removalVerified = true
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
  return removalVerified
    ? { ok: true, message: 'Container removed' }
    : {
        ok: false,
        message: `Project record cleaned up, but container ${containerName} could not be confirmed removed on the server — check for an orphan holding its port.`,
      }
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
export async function pickExternalPortForServer(serverId: string): Promise<number> {
  return pickExternalPort(serverId)
}

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

/**
 * Hand the application the port the panel is proxying to.
 *
 * Nearly every runtime takes it from the environment -- `process.env.PORT` in
 * Node, `os.environ["PORT"]` in Python -- and falls back to its own default
 * when it is missing. The panel asked the customer for an App Port, published
 * the container on it and pointed Caddy at it, but never passed it to the app.
 * So an app whose own default differed listened somewhere else and every
 * request came back 502. Reproduced with heroku/node-js-getting-started, which
 * is `process.env.PORT || 5006`: container published on 3000, app on 5006.
 *
 * A PORT the customer set explicitly wins -- they know their app better.
 */
function withRuntimePort(
  envVars: Record<string, string>,
  containerPort: number
): Record<string, string> {
  if (envVars.PORT !== undefined && envVars.PORT !== '') return envVars
  return { ...envVars, PORT: String(containerPort) }
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
  project: { name: string; slug: string; runtime?: string | null; runtimeVersion?: string | null; buildCommand?: string | null; startCommand?: string | null; appPort?: number | null; documentRoot?: string | null; framework?: string | null; resourceRamMB?: number | null },
  settings: Record<string, unknown>,
  envVars: Record<string, string> = {}
): string {
  // These are interpolated into FROM / COPY / RUN lines below. Unchecked,
  // a newline in any of them appends arbitrary build instructions.
  const phpVersion = safeRuntimeVersion(project.runtimeVersion, '8.2')
  const phpIni = phpIniBlock(project.resourceRamMB)
  const nodeVersion = safeRuntimeVersion(project.runtimeVersion, '20')
  const pythonVersion = safeRuntimeVersion(project.runtimeVersion, '3.11')
  const documentRoot = safeDocumentRoot(project.documentRoot, '/var/www/html')
  const framework = (settingsGet<string>(settings, 'framework') || project.framework || '') as string
  const packageManager = (settingsGet<string>(settings, 'packageManager') || 'npm') as string

  if (methodId === 'wordpress') {
    return `FROM wordpress:php${phpVersion}-apache
# APSAMO Panel — managed WordPress image
RUN docker-php-ext-install mysqli pdo pdo_mysql && a2enmod rewrite
${phpIni}
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
${phpIni}
EXPOSE 80
CMD ["php-fpm"]
`
  }

  if (methodId === 'php') {
    return `FROM php:${phpVersion}-apache
RUN docker-php-ext-install mysqli pdo pdo_mysql && a2enmod rewrite
${phpIni}
COPY . ${documentRoot}/
RUN chown -R www-data:www-data ${documentRoot}
EXPOSE 80
CMD ["apache2-foreground"]
`
  }

  if (methodId === 'nodejs') {
    const pm = packageManager === 'pnpm' ? 'pnpm' : packageManager === 'yarn' ? 'yarn' : packageManager === 'bun' ? 'bun' : 'npm'
    // devDependencies are BUILD dependencies. next, tsc, tailwind, vite and
    // every postcss plugin live there by convention, and the build runs in
    // this image a few lines below.
    //
    // This was `npm ci --omit=dev || npm install`. With a package-lock.json
    // present `npm ci` succeeds, so the fallback never ran and the image had
    // production dependencies only. A Next.js + Tailwind app then died at
    //
    //     Error: Cannot find module '@tailwindcss/postcss'
    //
    // npm was the odd one out here -- the yarn, pnpm and bun branches all
    // install dev dependencies already, so this also makes them consistent.
    //
    // Deliberately not pruning afterwards: `npm prune --omit=dev` would shrink
    // the runtime image, but plenty of projects list `next` (or their whole
    // server) under devDependencies, and pruning would then break `npm start`.
    // A larger image beats a site that does not run.
    const pmInstall = pm === 'pnpm'
      ? 'RUN npm install -g pnpm && pnpm install --frozen-lockfile || pnpm install'
      : pm === 'yarn'
        ? 'RUN yarn install --frozen-lockfile || yarn install'
        : pm === 'bun'
          ? 'RUN npm install -g bun && bun install'
          // A BuildKit cache mount keeps npm's download cache between builds,
          // so the packages are not re-fetched for every deploy and every new
          // project on this server. --no-audit/--no-fund drop two network
          // round trips that produce nothing but console output; the install
          // log showed "added 1061 packages, and audited 1062 packages in 2m".
          : 'RUN --mount=type=cache,target=/root/.npm,sharing=locked npm ci --no-audit --no-fund --prefer-offline || npm install --no-audit --no-fund'
    const buildCmd = project.buildCommand || (framework === 'nextjs' ? 'npm run build' : '')
    const startCmd = project.startCommand || (framework === 'nextjs' ? 'npm start' : 'node index.js')
    // .next/cache is Next's incremental compilation cache. Mounting it means
    // a redeploy reuses the previous compile instead of starting cold. The
    // mount is not part of the image, so this also keeps the cache out of the
    // exported layers.
    const buildLine = buildCmd
      ? `RUN --mount=type=cache,target=/app/.next/cache,sharing=locked ${buildCmd}\n`
      : ''
    // Prisma's client is a stub until `prisma generate` writes the real types
    // from schema.prisma. Its postinstall hook would normally do that, but the
    // install above runs before `COPY . .`, so the schema is not in the image
    // yet and nothing regenerates afterwards. Every Prisma project therefore
    // failed type checking with, e.g.
    //
    //     Module '"@prisma/client"' has no exported member 'UserRole'
    //
    // Guarded on the schema existing, so non-Prisma projects are unaffected.
    // This is the fix Prisma's own Docker documentation gives.
    const prismaLine =
      'RUN if [ -f prisma/schema.prisma ] || [ -f schema.prisma ]; then npx prisma generate; fi\n'
    // ARG receives the value from compose; ENV puts it in the environment the
    // build command actually reads. Both are needed.
    const publicArgs = buildTimeEnv(envVars)
      .map(([k]) => `ARG ${k}\nENV ${k}=$${k}\n`)
      .join('')
    return `FROM node:${nodeVersion}-alpine
WORKDIR /app
COPY package*.json ./
${pmInstall}
COPY . .
${prismaLine}${publicArgs}${buildLine}EXPOSE ${project.appPort || 3000}
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

/**
 * php.ini directives scaled to the plan's RAM allowance.
 *
 * Only the PHP *version* was ever applied — it picked the base image and
 * nothing else. Every site therefore ran on PHP's stock defaults
 * (memory_limit 128M, upload_max_filesize 2M), so a customer on a 6 GB
 * Enterprise plan got the same 2 MB upload ceiling as one on Starter, and the
 * "PHP settings" row on the comparison table described nothing.
 *
 * memory_limit is a per-request cap, not the container total: giving a request
 * the whole container invites the OOM killer to take the whole site down
 * instead of failing one request. A quarter of container RAM, clamped to a
 * sane 128M–512M, is the usual shape.
 */
function phpIniBlock(ramMB?: number | null): string {
  const ram = ramMB && ramMB > 0 ? ramMB : 512
  const memoryLimit = Math.min(512, Math.max(128, Math.round(ram / 4)))
  // Uploads are bounded by the request memory, and post_max_size must exceed
  // upload_max_filesize or the upload fails with an empty $_FILES.
  const uploadMB = Math.min(256, Math.max(8, Math.round(memoryLimit / 2)))
  const postMB = uploadMB + 8

  // Deliberately a single physical line. Multi-line RUN blocks need shell
  // continuations, and those backslashes are hostile to escape correctly
  // through a TS template literal into a generated Dockerfile.
  const ini = '/usr/local/etc/php/conf.d/zz-apsamo.ini'
  const directives = [
    `memory_limit = ${memoryLimit}M`,
    `upload_max_filesize = ${uploadMB}M`,
    `post_max_size = ${postMB}M`,
    'max_execution_time = 120',
    'max_input_time = 120',
    'max_input_vars = 3000',
    'expose_php = Off',
    // ── OPcache ──────────────────────────────────────────────────────
    // The single largest PHP win available and it was simply off: without
    // it every request re-parses and re-compiles every .php file it touches,
    // which on WordPress is hundreds of files per page load.
    //
    // The php:*-apache and wordpress images ship the extension compiled in
    // but disabled, so enabling it costs nothing but this directive.
    'opcache.enable = 1',
    'opcache.enable_cli = 0',
    // Sized to the request budget: the cache is shared across workers, so this
    // is a one-off cost, not per-request.
    `opcache.memory_consumption = ${Math.min(192, Math.max(64, Math.round(memoryLimit / 4)))}`,
    'opcache.interned_strings_buffer = 16',
    // WordPress plus a plugin set comfortably exceeds the 10k default.
    'opcache.max_accelerated_files = 20000',
    // Re-stat files every 60s rather than on every request. Deployments
    // replace the container, so a stale cache cannot outlive a release.
    'opcache.validate_timestamps = 1',
    'opcache.revalidate_freq = 60',
    // Comments are needed at runtime by annotation-driven frameworks
    // (Doctrine, some Laravel packages); stripping them breaks them.
    'opcache.save_comments = 1',
    // ── Realpath cache ───────────────────────────────────────────────
    // PHP stats a lot of paths; the 16k default is small for WordPress trees.
    'realpath_cache_size = 4096K',
    'realpath_cache_ttl = 600',
  ]
  const writes = directives
    .map((d, i) => `echo '${d}' ${i === 0 ? '>' : '>>'} ${ini}`)
    .join(' && ')
  return `RUN ${writes}`
}

/**
 * Container healthcheck.
 *
 * Measured on the live host: 2 of 28 running containers had one. Docker's
 * `restart: unless-stopped` only reacts to a process that EXITS — it cannot see
 * a container that is still running but wedged (a deadlocked PHP-FPM pool, a
 * database refusing connections, an app stuck on a lost upstream). Those stay
 * "Up" forever and serve errors.
 *
 * Deliberately uses the container's own port over 127.0.0.1 rather than curl:
 * the alpine and php base images do not all ship curl or wget, and a
 * healthcheck that fails because its own tool is missing is worse than none —
 * it marks a healthy container unhealthy and invites a restart loop.
 */
function healthcheckBlock(containerPort: number): string {
  // The old probe was `sh -c '<' /dev/null > /dev/tcp/127.0.0.1/PORT`, with a
  // comment calling it a "bare-Bourne TCP probe: no external binary required".
  // /dev/tcp is not Bourne -- it is a bash feature, and CMD-SHELL runs
  // /bin/sh, which is dash on Debian and busybox ash on Alpine. Neither has
  // it. The probe failed in every image the panel builds:
  //
  //     /bin/sh: 1: cannot create /dev/tcp/127.0.0.1/80: Directory nonexistent
  //
  // So every container sat permanently unhealthy, and restartUnhealthyContainers
  // duly restarted each one every time it had been up 10 minutes. Every
  // customer site was being bounced roughly every 15 minutes, indefinitely.
  //
  // No single tool is present in every image (checked across the live
  // containers: the WordPress image has curl but not wget or nc; nginx:alpine
  // has all three; the MariaDB images have none of them but do have bash).
  // At least one of these always resolves, so try them in order.
  //
  // An open port is the signal, not a 2xx -- `curl` is deliberately used
  // without -f so that a site answering 403 or 500 still counts as up. It is
  // running; marking it unhealthy is what gets it restarted.
  const p = containerPort
  const probe = [
    `nc -z 127.0.0.1 ${p}`,
    `curl -s -o /dev/null http://127.0.0.1:${p}/`,
    `wget -q -O /dev/null http://127.0.0.1:${p}/`,
    `bash -c '</dev/tcp/127.0.0.1/${p}'`,
  ].join(' || ')
  return [
    '    healthcheck:',
    `      test: ["CMD-SHELL", "${probe} || exit 1"]`,
    '      interval: 30s',
    '      timeout: 5s',
    // Generous: a cold PHP or Node boot can exceed a minute on a busy host,
    // and restarting mid-boot would never let it finish.
    '      start_period: 60s',
    '      retries: 3',
  ].join('\n')
}

/**
 * Per-container resource caps.
 *
 * All three live in `deploy.resources.limits`. A sibling `pids_limit` key is
 * not merely redundant -- Compose refuses the entire project with "can't set
 * distinct values on 'pids_limit' and 'deploy.resources.limits.pids'", so a
 * file carrying both never deploys at all.
 *
 * Always emits a block. The process cap is fork-bomb protection and must not
 * depend on whether a plan happens to have its RAM column filled in.
 */
function resourceLimitsBlock(
  cpuCores?: number | null,
  ramMB?: number | null,
  host?: { cpuCores?: number | null; ramGB?: number | null } | null
): string {
  // Clamp to the host. A ceiling above physical RAM is not a ceiling: the
  // container can never reach it, so the kernel OOM-kills something else on
  // the box instead of the site that overran.
  const hostRamMB = host?.ramGB ? host.ramGB * 1024 : null
  if (ramMB && hostRamMB) {
    // At most half the machine for one customer site — the same box runs the
    // panel, the worker, Caddy, Mailcow and the tenant databases.
    ramMB = Math.min(ramMB, Math.floor(hostRamMB / 2))
  }
  if (cpuCores && host?.cpuCores) {
    cpuCores = Math.min(cpuCores, host.cpuCores)
  }

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
  lines.push('          pids: 512')
  return lines.join('\n')
}

/**
 * The indented `KEY: "value"` pairs only, with no `environment:` header.
 *
 * Templates that already declare their own environment mapping (WordPress
 * needs one for the DB connection) must append to it. Emitting a second
 * `environment:` key on the same service is a duplicate mapping key, which
 * makes the whole file unparseable.
 */
/**
 * The subset of env vars that must be present while the image is BUILT.
 *
 * Next.js (and Vite, and CRA) inline `NEXT_PUBLIC_*` into the client bundle at
 * build time. Supplying them only to the running container is too late: the
 * bundle already shipped with the literal name where the value should be, so
 * every one of them is undefined in the browser.
 *
 * Deliberately NEXT_PUBLIC_ only. Build args are recorded in the image's
 * history, so anything passed this way is readable by anyone who can pull the
 * image. NEXT_PUBLIC_ is the prefix whose whole meaning is "this ships to the
 * browser anyway"; JWT_SECRET and DATABASE_URL stay runtime-only.
 */
function buildTimeEnv(envVars: Record<string, string>): Array<[string, string]> {
  return Object.entries(envVars).filter(
    ([k]) => isValidEnvKey(k) && k.startsWith('NEXT_PUBLIC_')
  )
}

function envEntries(envVars: Record<string, string>): string {
  return Object.entries(envVars)
    .filter(([k]) => {
      if (isValidEnvKey(k)) return true
      // A row that predates the API-side check, or one written by some future
      // path that forgets it. Dropping the variable breaks one app; emitting it
      // hands the host to whoever named it. See lib/safe-values.
      console.error(
        `[deployer] refusing to emit environment variable with unsafe name: ${JSON.stringify(k)}`
      )
      return false
    })
    .map(([k, v]) => `      ${k}: ${yamlQuoted(v)}`)
    .join('\n')
}

function envBlock(envVars: Record<string, string>): string {
  const entries = envEntries(envVars)
  if (!entries) return ''
  return `    environment:\n${entries}`
}

function generateMethodCompose(
  methodId: DeploymentMethodId,
  project: {
    slug: string
    resourceCpuCores?: number | null
    resourceRamMB?: number | null
    databaseHost?: string | null
    databaseName?: string | null
    databaseUser?: string | null
    databasePassword?: string | null
    /** Capacity of the machine this lands on — limits are clamped to it. */
    server?: { cpuCores?: number | null; ramGB?: number | null } | null
  },
  settings: Record<string, unknown>,
  opts: {
    containerName: string
    deployPath: string
    containerPort: number
    externalPort: number
    envVars: Record<string, string>
  }
): string {
  const limits = resourceLimitsBlock(
    project.resourceCpuCores,
    project.resourceRamMB,
    project.server
  )
  const health = healthcheckBlock(opts.containerPort)
  const env = envBlock(opts.envVars)
  // `build: .` is the short form and takes no args, so expand it when there is
  // something to pass.
  const buildArgs = buildTimeEnv(opts.envVars)
  const buildBlock = buildArgs.length
    ? `build:\n      context: .\n      args:\n` +
      buildArgs.map(([k, v]) => `        ${k}: ${yamlQuoted(v)}`).join('\n')
    : 'build: .'

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
      - "127.0.0.1:${opts.externalPort}:80"
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
${envEntries(opts.envVars) ? envEntries(opts.envVars) + '\n' : ''}    volumes:
      - ./wp-content:/var/www/html/wp-content
      - ./wp-config-docker.php:/var/www/html/wp-config.php
${limits ? limits + '\n' : ''}${health ? health + '\n' : ''}    networks:
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
    ${buildBlock}
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${opts.externalPort}:${opts.containerPort}"
${env ? env + '\n' : ''}${limits ? limits + '\n' : ''}${health ? health + '\n' : ''}    networks:
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
    ${buildBlock}
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${opts.externalPort}:${opts.containerPort}"
${env ? env + '\n' : ''}${limits ? limits + '\n' : ''}${health ? health + '\n' : ''}    networks:
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
  const health = healthcheckBlock(opts.containerPort)

  if (opts.stack === 'wordpress') {
    return `# Auto-generated by APSAMO Panel
services:
  wordpress:
    image: wordpress:php8.2-apache
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "127.0.0.1:${opts.externalPort}:80"
    environment:
      WORDPRESS_DB_HOST: db
      WORDPRESS_DB_USER: wp
      WORDPRESS_DB_PASSWORD: wpdbpass_${randomHex(8)}
      WORDPRESS_DB_NAME: wp
${env ? env + '\n' : ''}    volumes:
      - ./wp-content:/var/www/html/wp-content
    depends_on:
      - db
${limits ? limits + '\n' : ''}${health ? health + '\n' : ''}    networks:
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
      - "127.0.0.1:${opts.externalPort}:${opts.containerPort}"
${env ? env + '\n' : ''}${limits ? limits + '\n' : ''}${health ? health + '\n' : ''}    networks:
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
      - "127.0.0.1:${opts.externalPort}:${opts.containerPort}"
${env ? env + '\n' : ''}${limits ? limits + '\n' : ''}${health ? health + '\n' : ''}    networks:
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
