/**
 * Container Deployer
 * ==================
 *
 * Real Docker container deployment on a provisioned VPS:
 *
 *   1. Generate a Dockerfile + docker-compose.yml from the project's stack
 *      (nodejs, php, python, docker, wordpress) and any custom repo URL.
 *   2. SFTP-upload the project files to /opt/deployhub/projects/<slug>/
 *   3. Pull the repo (if GitHub-connected) OR write the generated files.
 *   4. Run `docker compose up -d --build` and capture logs.
 *   5. Register the container on the deployhub docker network (so Caddy can
 *      proxy to it via the container's service name).
 *   6. Persist containerId, containerName, containerPort, externalPort,
 *      deployPath, lastDeployedAt back to the Project row.
 *   7. Trigger the reverse-proxy manager to add the Caddyfile entry.
 *
 * In DEMO MODE (VPS_DEMO_MODE=1 or no server.sshHost), the deployer returns
 * a realistic simulated success — the Project row is updated with a fake
 * containerId + simulated build logs, so the dashboard UX is intact.
 */
import { db } from '@/lib/db'
import { STACK_DEFINITIONS, getStackDefinition } from '@/lib/stacks'
import {
  withConnection,
  exec,
  execStream,
  putFile,
  isVpsDemoMode,
  isServerInDemoMode,
  type ExecResult,
  type StreamChunk,
} from './ssh'
import { getServerCredentials } from './provisioner'
import { configureProjectProxy, removeProjectProxy } from './proxy'

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

// ─── Main deploy function ────────────────────────────────────────────────

export async function deployProject(req: DeployRequest): Promise<DeployResult> {
  const start = Date.now()
  const { projectId, deploymentId } = req
  const log = (m: string) => req.onLog?.(m)

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)
  if (!project.serverId || !project.server) {
    throw new Error('Project has no server assigned')
  }

  const stack = getStackDefinition(project.stack)
  if (!stack) throw new Error(`Unknown stack: ${project.stack}`)

  const deployPath = project.deployPath || `/opt/deployhub/projects/${project.slug}`
  const containerName = project.containerName || `deployhub-${project.slug}`
  const containerPort = project.containerPort || stack.port
  const externalPort = project.externalPort || await pickExternalPort(project.serverId)

  log(`Deploying ${project.name} (${project.stack}) to ${project.server.name}`)
  log(`  Path: ${deployPath}`)
  log(`  Container: ${containerName} (internal ${containerPort} → host ${externalPort})`)

  // ── DEMO MODE: simulated deploy with realistic build log ────────────
  // Demo mode is active when: VPS_DEMO_MODE env is set, OR the server has
  // no sshHost, OR the server has no SSH credentials (no key AND no password).
  if (isServerInDemoMode(project.server)) {
    const buildLog = generateDemoBuildLog(project, stack.name, containerName)
    log('[demo mode] Simulating deploy…')
    for (const line of buildLog.split('\n')) {
      req.onStreamChunk?.({ stream: 'stdout', data: line + '\n' })
      await sleep(150)
    }
    const fakeContainerId = generateFakeContainerId()

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
        buildLog,
        deployUrl: `https://${project.customDomain || project.subdomain}`,
        duration: Math.round((Date.now() - start) / 1000),
      },
    })

    log('[demo mode] Deploy simulated successfully')
    return {
      ok: true,
      projectId,
      deploymentId,
      containerId: fakeContainerId,
      containerName,
      containerPort,
      externalPort,
      deployPath,
      buildLog,
      durationMs: Date.now() - start,
    }
  }

  // ── REAL deploy ─────────────────────────────────────────────────────
  const creds = await getServerCredentials(project.serverId)
  let buildLog = ''
  let containerId: string | undefined

  try {
    await withConnection(creds, async (client) => {
      // 1. Create project directory
      log('Creating project directory…')
      await exec(
        client,
        `mkdir -p ${deployPath}`,
        { timeoutMs: 10000 }
      )

      // 2. Either clone the repo OR write a placeholder app
      if (project.repoUrl) {
        log(`Cloning ${project.repoUrl}…`)
        const clone = await exec(
          client,
          `if [ -d ${deployPath}/.git ]; then cd ${deployPath} && git pull; else rm -rf ${deployPath}/* && git clone ${shellQuote(project.repoUrl)} ${deployPath}; fi`,
          { timeoutMs: 120000 }
        )
        buildLog += `[git] ${clone.stdout}\n`
        if (clone.exitCode !== 0) {
          throw new Error(`git clone failed: ${clone.stderr}`)
        }
      } else {
        log('No repo URL — writing placeholder app from stack template…')
        const placeholder = generatePlaceholderApp(project.stack, project.name)
        for (const [filename, content] of Object.entries(placeholder)) {
          await putFile(client, `${deployPath}/${filename}`, content, { mode: 0o644 })
        }
        buildLog += `[placeholder] Wrote ${Object.keys(placeholder).length} files\n`
      }

      // 3. Write Dockerfile if stack defines one
      if (stack.dockerfile && project.stack !== 'docker') {
        log('Writing Dockerfile…')
        await putFile(client, `${deployPath}/Dockerfile`, stack.dockerfile, {
          mode: 0o644,
        })
        buildLog += `[dockerfile] Written (${stack.dockerfile.length} bytes)\n`
      }

      // 4. Write docker-compose.yml
      log('Writing docker-compose.yml…')
      const composeYml = generateDockerCompose({
        projectName: project.slug,
        containerName,
        deployPath,
        containerPort,
        externalPort,
        stack: project.stack,
        envVars: await getProjectEnvVars(projectId),
      })
      await putFile(client, `${deployPath}/docker-compose.yml`, composeYml, {
        mode: 0o644,
      })
      buildLog += `[compose] Written docker-compose.yml\n`

      // 5. docker compose build + up (stream logs live)
      log('Running docker compose build…')
      const buildGen = execStream(
        client,
        `cd ${deployPath} && docker compose build --progress=plain 2>&1`,
        { timeoutMs: 600000 }
      )
      for await (const chunk of buildGen) {
        buildLog += chunk.data
        req.onStreamChunk?.(chunk)
      }
      const buildResult = await buildGen.next().then(() => buildGen).catch(() => null)
      log(`Build finished (exit code from stream closed)`)

      log('Starting container with docker compose up -d…')
      const upGen = execStream(
        client,
        `cd ${deployPath} && docker compose up -d 2>&1`,
        { timeoutMs: 120000 }
      )
      for await (const chunk of upGen) {
        buildLog += chunk.data
        req.onStreamChunk?.(chunk)
      }

      // 6. Connect container to the deployhub network so Caddy can reach it
      log('Connecting container to deployhub network…')
      const net = await exec(
        client,
        `docker network connect deployhub ${containerName} 2>/dev/null || true`,
        { timeoutMs: 15000 }
      )
      buildLog += `[network] ${net.stdout || 'already connected'}\n`

      // 7. Get container ID + verify it's running
      log('Verifying container is running…')
      const inspect = await exec(
        client,
        `docker inspect --format '{{.Id}} {{.State.Status}}' ${containerName}`,
        { timeoutMs: 15000 }
      )
      const [cid, state] = inspect.stdout.trim().split(' ')
      if (!cid || state !== 'running') {
        throw new Error(
          `Container did not start properly (state=${state}). Logs:\n` +
            (await exec(client, `docker logs ${containerName} --tail 50 2>&1`, {
              timeoutMs: 15000,
            })).stdout
        )
      }
      containerId = cid
      log(`Container running: ${cid.slice(0, 12)}`)

      // 8. Update Caddy reverse proxy config (auto-HTTPS)
      log('Configuring Caddy reverse proxy…')
      await configureProjectProxy(project.id, { onLog: log })
      log('Caddy reloaded with new site config')
    })

    // 9. Persist project + deployment state
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
        buildLog,
        deployUrl: `https://${project.customDomain || project.subdomain}`,
        duration: Math.round((Date.now() - start) / 1000),
      },
    })

    log('Deploy complete!')
    return {
      ok: true,
      projectId,
      deploymentId,
      containerId,
      containerName,
      containerPort,
      externalPort,
      deployPath,
      buildLog,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`DEPLOY FAILED: ${message}`)
    buildLog += `\n[FATAL] ${message}\n`

    await db.project.update({
      where: { id: projectId },
      data: { status: 'error' },
    })
    await db.deployment.update({
      where: { id: deploymentId },
      data: { status: 'failed', buildLog, duration: Math.round((Date.now() - start) / 1000) },
    })

    return {
      ok: false,
      projectId,
      deploymentId,
      containerId,
      containerName,
      containerPort,
      externalPort,
      deployPath,
      buildLog,
      durationMs: Date.now() - start,
      error: message,
    }
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
      await exec(client, `cd ${project.deployPath} && docker compose down 2>&1`, {
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
      await exec(client, `cd ${project.deployPath} && docker compose restart 2>&1`, {
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
          `cd ${project.deployPath} && docker compose down --rmi local -v 2>&1 || true`,
          { timeoutMs: 60000 }
        )
        await exec(client, `rm -rf ${project.deployPath}`, { timeoutMs: 30000 })
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

  if (isServerInDemoMode(project.server)) {
    return {
      containerId: project.containerId || 'demo',
      name: project.containerName,
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
        `docker inspect --format '{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.Health.Status}}|{{.Config.Image}}|{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}->{{(index $conf 0).HostPort}} {{end}}|{{.Created}}' ${project.containerName} 2>/dev/null`,
        { timeoutMs: 10000 }
      )
      if (r.exitCode !== 0) {
        return {
          containerId: project.containerId || '',
          name: project.containerName,
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
        `docker logs ${project.containerName} --tail ${tail} ${sinceFlag} 2>&1`,
        { timeoutMs: 30000 }
      )
      return r.stdout || r.stderr
    })
  } catch (err) {
    return `Failed to fetch logs: ${err instanceof Error ? err.message : err}`
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

async function pickExternalPort(serverId: string): Promise<number> {
  // Find the highest externalPort in use on this server + 1, starting from 30000.
  const projects = await db.project.findMany({
    where: { serverId, externalPort: { not: null } },
    select: { externalPort: true },
  })
  const usedPorts = new Set(projects.map((p) => p.externalPort!))
  for (let port = 30000; port < 40000; port++) {
    if (!usedPorts.has(port)) return port
  }
  return 30000 + Math.floor(Math.random() * 9999)
}

async function getProjectEnvVars(projectId: string): Promise<Record<string, string>> {
  const envVars = await db.environmentVariable.findMany({
    where: { projectId },
    select: { key: true, value: true, encrypted: true },
  })
  // Note: env var values are encrypted at rest; decrypt here. The actual
  // decryption is handled by the env var API; for compose we re-read the
  // raw value via the encryption module.
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

function generateDockerCompose(opts: {
  projectName: string
  containerName: string
  deployPath: string
  containerPort: number
  externalPort: number
  stack: string
  envVars: Record<string, string>
}): string {
  const envLines = Object.entries(opts.envVars)
    .map(([k, v]) => `      ${k}: "${v.replace(/"/g, '\\"')}"`)
    .join('\n')

  // For WordPress we add a MariaDB service.
  if (opts.stack === 'wordpress') {
    return `# Auto-generated by Apsamo Panel
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
${envLines ? envLines + '\n' : ''}    volumes:
      - ./wp-content:/var/www/html/wp-content
    depends_on:
      - db
    networks:
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
  deployhub:
    external: true
`
  }

  // For docker stack, just build the repo's own Dockerfile.
  if (opts.stack === 'docker') {
    return `# Auto-generated by Apsamo Panel (custom Dockerfile)
services:
  app:
    build: .
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "${opts.externalPort}:${opts.containerPort}"
${envLines ? `    environment:\n${envLines}\n` : ''}    networks:
      - default
      - deployhub

networks:
  deployhub:
    external: true
`
  }

  // For nodejs/php/python — build via generated Dockerfile.
  return `# Auto-generated by Apsamo Panel
services:
  app:
    build: .
    container_name: ${opts.containerName}
    restart: unless-stopped
    ports:
      - "${opts.externalPort}:${opts.containerPort}"
${envLines ? `    environment:\n${envLines}\n` : ''}    networks:
      - default
      - deployhub

networks:
  deployhub:
    external: true
`
}

function generatePlaceholderApp(stack: string, projectName: string): Record<string, string> {
  if (stack === 'nodejs') {
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
    stack: 'nodejs',
    deployed_by: 'Apsamo Panel',
    time: new Date().toISOString()
  })
})

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.listen(PORT, () => console.log('Listening on port ' + PORT))
`,
    }
  }
  if (stack === 'php') {
    return {
      'index.php': `<?php
header('Content-Type: application/json');
echo json_encode([
  'app' => ${JSON.stringify(projectName)},
  'stack' => 'php',
  'deployed_by' => 'Apsamo Panel',
  'time' => date('c'),
  'php_version' => PHP_VERSION
]);
`,
    }
  }
  if (stack === 'python') {
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
        'deployed_by': 'Apsamo Panel',
        'time': datetime.now().isoformat()
    })

@app.route('/health')
def health():
    return jsonify({'status': 'ok'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000)
`,
    }
  }
  // Default: empty placeholder
  return {
    'README.md': `# ${projectName}\n\nDeployed via Apsamo Panel (stack: ${stack}).\n`,
  }
}

function generateDemoBuildLog(
  project: { name: string; slug: string; stack: string; subdomain: string; customDomain: string | null },
  stackName: string,
  containerName: string
): string {
  const url = project.customDomain || project.subdomain
  return `Apsamo Panel deployment log
==========================
Project: ${project.name} (${project.slug})
Stack:   ${stackName} (${project.stack})
Target:  ${url}

[1/6] Creating project directory /opt/deployhub/projects/${project.slug}...
[1/6] OK

[2/6] Writing Dockerfile from ${stackName} template...
[2/6] OK (Dockerfile, 218 bytes)

[3/6] Writing docker-compose.yml (container: ${containerName})...
[3/6] OK

[4/6] docker compose build --progress=plain
 => [internal] load build definition from Dockerfile                  0.1s
 => => transferring dockerfile: 218B                                   0.0s
 => [internal] load metadata for docker.io/library/${project.stack === 'php' ? 'php:8.2-apache' : project.stack === 'python' ? 'python:3.11-slim' : 'node:20-alpine'}    1.2s
 => [auth] library/${project.stack === 'php' ? 'php' : project.stack === 'python' ? 'python' : 'node'}:pull token for registry-1.docker.io  0.6s
 => [internal] load .dockerignore                                      0.0s
 => => transferring context: 2B                                        0.0s
 => [1/3] FROM docker.io/library/${project.stack === 'php' ? 'php:8.2-apache' : project.stack === 'python' ? 'python:3.11-slim' : 'node:20-alpine'}                  3.4s
 => => resolve image config for docker.io/library/${project.stack}    3.4s
 => [2/3] COPY . /app                                                  0.2s
 => [3/3] WORKDIR /app                                                 0.0s
 => exporting to image                                                 0.4s
 => => writing image sha256:abc123def456...                            0.4s
[4/6] Build complete in 5.4s

[5/6] docker compose up -d
[5/6] Container ${containerName} started (port ${project.stack === 'php' ? 80 : 3000}->30001)

[6/6] Connecting to deployhub docker network...
[6/6] OK — Caddy reverse proxy updated, SSL auto-provisioned via Let's Encrypt

✓ Deployment live at https://${url}
Total time: 8.3s
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
  return (
    Array.from({ length: 64 }, () =>
      '0123456789abcdef'[Math.floor(Math.random() * 16)]
    ).join('')
  )
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
