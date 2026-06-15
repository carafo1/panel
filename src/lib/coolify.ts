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
