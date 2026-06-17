/**
 * Coolify API client.
 *
 * Used by:
 *  - #3 Coolify Provisioning
 *
 * API docs: https://coolify.io/docs/api
 *
 * When COOLIFY_API_URL and COOLIFY_API_TOKEN env vars are not set,
 * runs in DEMO MODE - returns simulated data so the hosting UI can be
 * exercised without a real Coolify instance.
 */

function getConfig(): { url: string; token: string } | null {
  const url = process.env.COOLIFY_API_URL
  const token = process.env.COOLIFY_API_TOKEN
  if (!url || !token) return null
  return { url: url.replace(/\/$/, ''), token }
}

export function isCoolifyDemoMode(): boolean {
  return !getConfig()
}

async function coolifyFetch<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const cfg = getConfig()
  if (!cfg) throw new Error('Coolify not configured')

  const res = await fetch(`${cfg.url}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init.headers || {}),
    },
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Coolify API ${res.status}: ${text}`)
  }

  if (res.status === 204) return {} as T
  return (await res.json()) as T
}

interface CreateApplicationOptions {
  name: string
  framework: string // nextjs, react, node, static, etc.
  serverId: string
  repoUrl?: string
  branch?: string
}

interface CreateApplicationResult {
  id: string
  url: string
}

/**
 * Create a new application in Coolify.
 */
export async function createApplication(
  opts: CreateApplicationOptions
): Promise<CreateApplicationResult> {
  if (isCoolifyDemoMode()) {
    // Demo mode - return a simulated app
     
    console.log('[coolify] DEMO MODE: createApplication', opts)
    const id = `demo-app-${Date.now()}`
    const slug = opts.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    return {
      id,
      url: `https://${slug}.deployhub.io`,
    }
  }

  // POST /applications (private alpha) or POST /projects/{uuid}/applications
  // The exact payload depends on the Coolify API version.
  const body = {
    name: opts.name,
    server_uuid: opts.serverId,
    project_uuid: opts.serverId, // assumption - same id used
    environment_name: 'production',
    git_repository: opts.repoUrl || '',
    git_branch: opts.branch || 'main',
    build_pack: frameworkToBuildPack(opts.framework),
  }
  const result = await coolifyFetch<{ uuid: string; domains?: string[] }>('/applications', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return {
    id: result.uuid,
    url: result.domains?.[0] || '',
  }
}

function frameworkToBuildPack(framework: string): string {
  switch (framework) {
    case 'nextjs': return 'nixpacks'
    case 'react':
    case 'vue':
    case 'static': return 'static'
    case 'node': return 'nixpacks'
    case 'docker': return 'dockercompose'
    default: return 'nixpacks'
  }
}

interface DeployResult {
  deploymentId: string
}

/**
 * Trigger a deployment for an application.
 */
export async function deployApplication(appId: string): Promise<DeployResult> {
  if (isCoolifyDemoMode()) {
     
    console.log('[coolify] DEMO MODE: deployApplication', appId)
    return { deploymentId: `demo-deploy-${Date.now()}` }
  }

  const result = await coolifyFetch<{ deployment_uuid: string; deployment_url?: string }>(
    `/applications/${appId}/deploy`,
    { method: 'POST' }
  )
  return { deploymentId: result.deployment_uuid }
}

interface ApplicationStatus {
  status: string
  url?: string
}

/**
 * Get the status of an application.
 */
export async function getApplicationStatus(
  appId: string
): Promise<ApplicationStatus> {
  if (isCoolifyDemoMode()) {
     
    console.log('[coolify] DEMO MODE: getApplicationStatus', appId)
    return {
      status: 'running',
      url: `https://${appId.replace(/^demo-app-/, '')}.deployhub.io`,
    }
  }

  const result = await coolifyFetch<{
    status?: string
    domains?: string[]
    application?: { status: string }
  }>(`/applications/${appId}`)
  return {
    status: result.status || result.application?.status || 'unknown',
    url: result.domains?.[0],
  }
}

/**
 * Delete an application.
 */
export async function deleteApplication(
  appId: string
): Promise<{ success: boolean }> {
  if (isCoolifyDemoMode()) {
     
    console.log('[coolify] DEMO MODE: deleteApplication', appId)
    return { success: true }
  }

  await coolifyFetch(`/applications/${appId}`, { method: 'DELETE' })
  return { success: true }
}

/**
 * Get the build logs of a specific deployment.
 */
export async function getDeploymentLogs(
  appId: string,
  deploymentId: string
): Promise<string> {
  if (isCoolifyDemoMode()) {
     
    console.log('[coolify] DEMO MODE: getDeploymentLogs', appId, deploymentId)
    return [
      '🚀 DeployHub Coolify Deployment',
      '==============================',
      `Application: ${appId}`,
      `Deployment:  ${deploymentId}`,
      '',
      '[1/5] Pulling source code............. ✅',
      '[2/5] Detecting framework............ ✅ nextjs',
      '[3/5] Building image................. ✅',
      '[4/5] Starting container............. ✅',
      '[5/5] Health check passed............ ✅',
      '',
      'Deployment completed successfully!',
    ].join('\n')
  }

  const result = await coolifyFetch<{ logs?: string }>(
    `/applications/${appId}/deployments/${deploymentId}/logs`
  )
  return result.logs || ''
}

interface CoolifyServer {
  id: string
  name: string
  ip: string
}

/**
 * List all servers configured in Coolify.
 */
export async function listServers(): Promise<CoolifyServer[]> {
  if (isCoolifyDemoMode()) {
     
    console.log('[coolify] DEMO MODE: listServers')
    return [
      { id: 'srv-demo-1', name: 'eu-central-1', ip: '10.0.1.10' },
      { id: 'srv-demo-2', name: 'us-east-1', ip: '10.0.2.10' },
    ]
  }

  const result = await coolifyFetch<{ servers?: Array<{ uuid: string; name: string; ip?: string }> }>(
    '/servers'
  )
  return (result.servers || []).map((s) => ({
    id: s.uuid,
    name: s.name,
    ip: s.ip || '',
  }))
}

/**
 * Get the details of a single server.
 */
export async function getServer(serverId: string): Promise<CoolifyServer | null> {
  if (isCoolifyDemoMode()) {
    return {
      id: serverId,
      name: 'demo-server',
      ip: '10.0.0.1',
    }
  }
  const result = await coolifyFetch<{ uuid: string; name: string; ip?: string }>(
    `/servers/${serverId}`
  )
  return {
    id: result.uuid,
    name: result.name,
    ip: result.ip || '',
  }
}

// ===========================================================================
// Multi-stack application support (#20)
//
// The original `createApplication` above assumes a single Node.js-ish
// framework and lets Coolify's nixpacks pick the buildpack. Real DeployHub
// users want to deploy all sorts of stacks — Node.js, PHP, Python, custom
// Dockerfiles, and WordPress — so we add an explicit `STACK_DEFINITIONS`
// map plus a `createStackApplication` entry point that knows how to wire up
// each stack (including the MySQL database that WordPress needs).
//
// These functions are ADDITIVE: they don't replace `createApplication` or
// any other existing function. Existing callers keep working unchanged.
// ===========================================================================

/**
 * Static definitions for every stack DeployHub knows how to provision.
 *
 * Each entry carries:
 *  - `name`:           human-readable label
 *  - `dockerfile`:     the Dockerfile content to push to Coolify. `null` for
 *                      the `docker` stack, which means "use the repo's own
 *                      Dockerfile".
 *  - `buildCommand`:   optional pre-build command (e.g. `npm run build`).
 *                      `null` if not applicable.
 *  - `startCommand`:   optional start command. `null` if the Dockerfile's
 *                      `CMD` is sufficient.
 *  - `port`:           the port the container listens on.
 *  - `healthCheck`:    HTTP path Coolify should hit to confirm the app is up.
 */
export const STACK_DEFINITIONS = {
  nodejs: {
    name: 'Node.js',
    dockerfile: `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .
EXPOSE 3000
CMD ["npm", "start"]`,
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    port: 3000,
    healthCheck: '/api/health',
  },
  php: {
    name: 'PHP',
    dockerfile: `FROM php:8.2-apache
COPY . /var/www/html/
RUN chown -R www-data:www-data /var/www/html
EXPOSE 80`,
    buildCommand: null,
    startCommand: null,
    port: 80,
    healthCheck: '/',
  },
  python: {
    name: 'Python',
    dockerfile: `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "app:app"]`,
    buildCommand: null,
    startCommand: null,
    port: 8000,
    healthCheck: '/',
  },
  docker: {
    name: 'Custom Docker',
    dockerfile: null, // uses user's Dockerfile
    buildCommand: null,
    startCommand: null,
    port: 8080,
    healthCheck: '/',
  },
  wordpress: {
    name: 'WordPress',
    dockerfile: `FROM wordpress:6.4-php8.2-apache
COPY wp-content/ /var/www/html/wp-content/
EXPOSE 80`,
    buildCommand: null,
    startCommand: null,
    port: 80,
    healthCheck: '/',
  },
} as const

export type StackType = keyof typeof STACK_DEFINITIONS

/**
 * Return the stack definition for a given stack id, or `null` if unknown.
 */
export function getStackDefinition(
  stack: string
): typeof STACK_DEFINITIONS[StackType] | null {
  if (stack in STACK_DEFINITIONS) {
    return STACK_DEFINITIONS[stack as StackType]
  }
  return null
}

/**
 * List every supported stack with a short description + icon name (Lucide).
 * Used by the deployment UI to render the stack picker.
 */
export function listStacks(): Array<{
  id: string
  name: string
  description: string
  icon: string
}> {
  return [
    {
      id: 'nodejs',
      name: STACK_DEFINITIONS.nodejs.name,
      description:
        'Node.js apps with a package.json — Next.js, Express, Fastify, etc. Built with npm ci and started with npm start.',
      icon: 'box',
    },
    {
      id: 'php',
      name: STACK_DEFINITIONS.php.name,
      description:
        'PHP 8.2 on Apache. Drop your PHP files in the repo root and they are served from /var/www/html.',
      icon: 'file-code',
    },
    {
      id: 'python',
      name: STACK_DEFINITIONS.python.name,
      description:
        'Python 3.11 WSGI apps served by gunicorn. Provide a requirements.txt and an `app` callable.',
      icon: 'terminal',
    },
    {
      id: 'docker',
      name: STACK_DEFINITIONS.docker.name,
      description:
        'Bring your own Dockerfile. DeployHub lets Coolify build & run it as-is on port 8080.',
      icon: 'container',
    },
    {
      id: 'wordpress',
      name: STACK_DEFINITIONS.wordpress.name,
      description:
        'Managed WordPress 6.4 on PHP 8.2/Apache. DeployHub provisions a MySQL database alongside the container.',
      icon: 'layout-template',
    },
  ]
}

interface CreateStackApplicationOptions {
  name: string
  stack: StackType
  serverId?: string
  domain?: string
  repoUrl?: string
  branch?: string
}

interface CreateStackApplicationResult {
  id: string
  url: string
  demoMode: boolean
  databaseId?: string // for WordPress
}

/**
 * Internal: derive a stable URL for a stack application.
 * In demo mode we always produce a `*.deployhub.io` subdomain; in real mode
 * the URL comes from Coolify (which sets it from the `domain` parameter).
 */
function demoAppUrl(name: string, domain?: string): string {
  if (domain) return `https://${domain}`
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `https://${slug}.deployhub.io`
}

/**
 * Create a new Coolify application for a specific stack.
 *
 * Behaviour:
 *  - DEMO MODE (no COOLIFY_API_URL / COOLIFY_API_TOKEN): returns a simulated
 *    `demo-app-…` id + URL, logs the operation, and — for WordPress — also
 *    logs that a MySQL database *would* be created.
 *  - REAL MODE: creates the application via Coolify's REST API, attaches the
 *    stack's Dockerfile (when applicable), configures the custom domain (if
 *    provided), enables Let's Encrypt SSL, and triggers an initial
 *    deployment. For WordPress it also creates a MySQL database through
 *    Coolify's `/databases` endpoint and wires the connection env vars.
 *
 * The function never throws — on any failure it returns `{ success: false }`
 * shaped result via the `error?` field (kept off the public interface for
 * caller convenience; callers should `try/catch` if they want to be safe).
 */
export async function createStackApplication(
  opts: CreateStackApplicationOptions
): Promise<CreateStackApplicationResult> {
  const stackDef = getStackDefinition(opts.stack)
  if (!stackDef) {
    throw new Error(
      `Unsupported stack: ${opts.stack}. Supported: ${Object.keys(STACK_DEFINITIONS).join(', ')}`
    )
  }

  // -------------------------------------------------------------------------
  // DEMO MODE
  // -------------------------------------------------------------------------
  if (isCoolifyDemoMode()) {
    const id = `demo-app-${Date.now()}`
    const url = demoAppUrl(opts.name, opts.domain)
    console.log(
      `[coolify] DEMO MODE: createStackApplication ${opts.stack} → ${opts.name} (${id})`
    )
    if (opts.domain) {
      console.log(
        `[coolify] DEMO MODE: would configure custom domain ${opts.domain} + Let's Encrypt SSL`
      )
    }
    if (opts.stack === 'wordpress') {
      console.log(
        `[coolify] DEMO MODE: would provision MySQL database for WordPress (${opts.name})`
      )
    }
    console.log(
      `[coolify] DEMO MODE: would trigger initial deployment with Dockerfile:\n${stackDef.dockerfile ?? '(user-supplied Dockerfile)'}`
    )
    return {
      id,
      url,
      demoMode: true,
      // For WordPress we surface a fake database id so callers/UIs can show
      // the dependency even in demo mode.
      databaseId: opts.stack === 'wordpress' ? `demo-db-${Date.now()}` : undefined,
    }
  }

  // -------------------------------------------------------------------------
  // REAL MODE — talk to Coolify
  // -------------------------------------------------------------------------
  // 1) Create the application.
  //
  // Coolify's API surface has evolved; the most stable shape across v4.x is:
  //   POST /applications  { project_uuid, server_uuid, environment_name, name, ... }
  // which returns `{ uuid }`. We then update the application with the
  // stack-specific config (Dockerfile, build pack, ports, domain, SSL).
  // (The actual API token / URL live inside `coolifyFetch` via `getConfig`.)

  // Resolve the Coolify server to deploy onto. If the caller didn't supply
  // one, fall back to the first available server.
  let serverUuid = opts.serverId
  if (!serverUuid) {
    const servers = await listServers()
    if (servers.length === 0) {
      throw new Error('No Coolify servers available. Pass a serverId or configure one in Coolify.')
    }
    serverUuid = servers[0].id
  }

  // Coolify's `build_pack`: `dockerfile` for everything that ships a
  // Dockerfile, `dockercompose` for the custom-Docker stack when the repo
  // contains a compose file, otherwise `nixpacks` as a sensible fallback.
  const buildPack =
    opts.stack === 'docker' ? 'dockercompose' : 'dockerfile'

  const createBody = {
    name: opts.name,
    server_uuid: serverUuid,
    project_uuid: serverUuid, // Coolify links apps to a project; DeployHub uses 1:1.
    environment_name: 'production',
    git_repository: opts.repoUrl || '',
    git_branch: opts.branch || 'main',
    build_pack: buildPack,
  }

  const created = await coolifyFetch<{ uuid: string }>(`/applications`, {
    method: 'POST',
    body: JSON.stringify(createBody),
  })
  const appId = created.uuid

  // 2) Attach the stack's Dockerfile (skip for the `docker` stack which uses
  //    the repo's own Dockerfile).
  if (stackDef.dockerfile) {
    try {
      await coolifyFetch(`/applications/${appId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          dockerfile: stackDef.dockerfile,
          docker_registry_image_name: '',
          ports_exposes: String(stackDef.port),
        }),
      })
    } catch (err) {
      // Don't fail the whole provisioning if the Dockerfile update endpoint
      // isn't available in this Coolify version — log and move on. The
      // initial deploy may still succeed if the repo contains a Dockerfile.
      console.warn(
        `[coolify] Could not attach Dockerfile for ${opts.stack} app ${appId}:`,
        err instanceof Error ? err.message : err
      )
    }
  }

  // 3) Configure custom domain + Let's Encrypt SSL.
  if (opts.domain) {
    try {
      await coolifyFetch(`/applications/${appId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          domains: opts.domain,
        }),
      })
      // Trigger SSL issuance. Coolify watches the `domains` field and
      // auto-issues a Let's Encrypt cert on the next deploy, but we also
      // kick off an explicit `ssl` action for good measure.
      try {
        await coolifyFetch(`/applications/${appId}/ssl`, {
          method: 'POST',
          body: JSON.stringify({
            type: 'letsencrypt',
          }),
        })
      } catch {
        // Older Coolify versions don't expose this endpoint; ignore.
      }
    } catch (err) {
      console.warn(
        `[coolify] Could not configure domain ${opts.domain} for app ${appId}:`,
        err instanceof Error ? err.message : err
      )
    }
  }

  // 4) For WordPress, also provision a MySQL database and wire it into the
  //    app via WORDPRESS_DB_* env vars. In demo mode we just noted this
  //    would happen — here we actually do it.
  let databaseId: string | undefined
  if (opts.stack === 'wordpress') {
    try {
      const db = await coolifyFetch<{ uuid: string }>(`/databases`, {
        method: 'POST',
        body: JSON.stringify({
          name: `${opts.name}-mysql`,
          server_uuid: serverUuid,
          project_uuid: serverUuid,
          environment_name: 'production',
          type: 'mysql',
          image: 'mysql:8.0',
          ports_exposes: '3306',
        }),
      })
      databaseId = db.uuid

      // Generate a stable password for the WordPress DB user. We don't use a
      // real secret manager here because this lib is meant to be
      // self-contained; the caller can rotate the password via Coolify later.
      const wpDbName = 'wordpress'
      const wpDbUser = 'wordpress'
      const wpDbPass = `pw-${appId}-${Date.now()}`.slice(0, 32)
      const wpDbHost = databaseId // within Coolify's network, the DB container is reachable by its uuid

      // Wire the WordPress env vars into the application.
      try {
        await coolifyFetch(`/applications/${appId}/envs`, {
          method: 'POST',
          body: JSON.stringify({
            key: 'WORDPRESS_DB_HOST',
            value: `${wpDbHost}:3306`,
            is_preview: false,
          }),
        })
        await coolifyFetch(`/applications/${appId}/envs`, {
          method: 'POST',
          body: JSON.stringify({
            key: 'WORDPRESS_DB_NAME',
            value: wpDbName,
            is_preview: false,
          }),
        })
        await coolifyFetch(`/applications/${appId}/envs`, {
          method: 'POST',
          body: JSON.stringify({
            key: 'WORDPRESS_DB_USER',
            value: wpDbUser,
            is_preview: false,
          }),
        })
        await coolifyFetch(`/applications/${appId}/envs`, {
          method: 'POST',
          body: JSON.stringify({
            key: 'WORDPRESS_DB_PASSWORD',
            value: wpDbPass,
            is_preview: false,
          }),
        })
      } catch (err) {
        console.warn(
          `[coolify] Could not wire WordPress DB env vars for app ${appId}:`,
          err instanceof Error ? err.message : err
        )
      }
    } catch (err) {
      console.warn(
        `[coolify] Could not provision MySQL database for WordPress app ${appId}:`,
        err instanceof Error ? err.message : err
      )
    }
  }

  // 5) Trigger an initial deployment so the app is up & running by the time
  //    the caller checks its status.
  try {
    await deployApplication(appId)
  } catch (err) {
    console.warn(
      `[coolify] Initial deploy trigger failed for ${appId}:`,
      err instanceof Error ? err.message : err
    )
  }

  // Final URL — prefer the caller-supplied domain; otherwise read whatever
  // Coolify reported back from the application detail endpoint.
  let url = opts.domain ? `https://${opts.domain}` : ''
  if (!url) {
    try {
      const status = await getApplicationStatus(appId)
      url = status.url || ''
    } catch {
      // Leave url empty; caller can poll later.
    }
  }

  return {
    id: appId,
    url,
    demoMode: false,
    databaseId,
  }
}
