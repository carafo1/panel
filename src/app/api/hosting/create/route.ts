import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { encrypt } from '@/lib/encryption'
import { logAudit } from '@/lib/audit'
import { deployProject } from '@/lib/vps'
import { getDeploymentMethod, type DeploymentMethodId } from '@/lib/deployment-methods'
import { BRAND_DOMAIN } from '@/lib/brand-config'

/**
 * Create-Website Wizard API
 * =========================
 *
 * Accepts two payload shapes:
 *
 *   1. NEW wizard payload — `{ name, method, source, config, ... }` (see
 *      the JSDoc below for the full schema). Drives the new multi-step
 *      Create-Website-Wizard UI. Creates a Project with all the new
 *      deploymentMethod / runtime / buildCommand fields populated, then
 *      fires the new method-aware deployer.
 *
 *   2. LEGACY payload — `{ name, framework, planId, repoUrl, branch }`
 *      (no `method` field). Preserved for back-compat with any existing
 *      callers (e.g. the old quick-create dialog). Creates a Node.js
 *      project on the legacy stack pipeline.
 *
 * Both paths:
 *   - authenticate via `authenticateRequest`
 *   - check the user's plan project limit
 *   - assign a server (active, fewest projects, docker-preferred)
 *   - create a Deployment row + DeploymentStage rows
 *   - fire-and-forget `deployProject`
 */

// ─── Helpers ─────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

function randomSuffix(len = 6): string {
  return crypto.randomBytes(len).toString('hex').slice(0, len)
}

interface ParsedPlan {
  cpuCores: number
  ramMB: number
  storageGB: number
}

/**
 * Parse a Plan row's `cpu`, `ram`, `storage` strings (e.g. "1 vCPU", "1GB",
 * "10GB") into numeric values for storage on the Project row.
 */
function parsePlanResources(plan: {
  cpu: string
  ram: string
  storage: string
}): ParsedPlan {
  const num = (s: string, fallback = 1): number => {
    const m = s.match(/([\d.]+)/)
    return m ? parseFloat(m[1]) : fallback
  }
  return {
    cpuCores: num(plan.cpu, 1),
    ramMB: Math.round(num(plan.ram, 1024) * (plan.ram.toLowerCase().includes('gb') ? 1024 : 1)),
    storageGB: Math.round(num(plan.storage, 10)),
  }
}

// ─── POST ────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    // ── Detect legacy vs wizard payload ──────────────────────────────
    const isWizard = typeof body.method === 'string'

    if (!isWizard) {
      return await handleLegacyCreate(request, decoded, body)
    }
    return await handleWizardCreate(request, decoded, body)
  } catch (error) {
    console.error('Create hosting error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// ─── Wizard payload handler ──────────────────────────────────────────────

interface WizardPayload {
  name: string
  domainType?: 'subdomain' | 'existing' | 'new'
  domain?: string
  method: DeploymentMethodId
  source: 'git' | 'zip' | 'manual' | 'template'
  gitUrl?: string
  gitBranch?: string
  gitProvider?: 'github' | 'gitlab' | 'bitbucket' | 'custom'
  gitToken?: string
  uploadId?: string
  config?: {
    runtime?: string
    runtimeVersion?: string
    framework?: string
    packageManager?: string
    buildCommand?: string
    startCommand?: string
    appPort?: number
    documentRoot?: string
    useCompose?: 'auto' | 'compose' | 'dockerfile'
    wpAdminUser?: string
    wpAdminPassword?: string
    wpAdminEmail?: string
    envVars?: Array<{ key: string; value: string }>
  }
  planId?: string
}

async function handleWizardCreate(
  request: Request,
  decoded: { userId: string; email: string; role: string },
  body: WizardPayload
) {
  const { name, method: methodId, source } = body
  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json(
      { error: 'Project name is required' },
      { status: 400 }
    )
  }
  const method = getDeploymentMethod(methodId)
  if (!method) {
    return NextResponse.json(
      { error: `Unknown deployment method: ${methodId}` },
      { status: 400 }
    )
  }
  if (!source || !['git', 'zip', 'manual', 'template'].includes(source)) {
    return NextResponse.json(
      { error: 'Invalid source (must be git, zip, manual, or template)' },
      { status: 400 }
    )
  }
  if (source === 'git' && !body.gitUrl) {
    return NextResponse.json(
      { error: 'gitUrl is required when source is "git"' },
      { status: 400 }
    )
  }
  if (source === 'zip' && !body.uploadId) {
    return NextResponse.json(
      { error: 'uploadId is required when source is "zip"' },
      { status: 400 }
    )
  }

  // ── Plan limits ───────────────────────────────────────────────────
  const subscription = await db.subscription.findFirst({
    where: { userId: decoded.userId, status: 'active' },
    include: { plan: true },
  })
  if (subscription && subscription.plan) {
    const projectCount = await db.project.count({
      where: { userId: decoded.userId },
    })
    if (projectCount >= subscription.plan.projects) {
      return NextResponse.json(
        {
          error: `Project limit reached (${subscription.plan.projects} projects on ${subscription.plan.name} plan)`,
        },
        { status: 403 }
      )
    }
  }

  // ── Domain resolution ─────────────────────────────────────────────
  const slug = slugify(name) + '-' + randomSuffix(4)
  let subdomain: string
  let customDomain: string | null = null

  const domainType = body.domainType || 'subdomain'
  if (domainType === 'subdomain') {
    subdomain = `${slug}.${BRAND_DOMAIN}`
  } else {
    const requestedDomain = (body.domain || '').toLowerCase().trim()
    if (!requestedDomain) {
      return NextResponse.json(
        { error: 'Domain is required when domainType is "existing" or "new"' },
        { status: 400 }
      )
    }
    // For "existing" domains, verify the domain is registered to the user.
    // For "new" domains (user owns externally + will configure DNS), accept
    // the domain without an ownership check — DNS / SSL verification happens
    // later in the deploy pipeline.
    if (domainType === 'existing') {
      const owned = await db.domain.findFirst({
        where: { userId: decoded.userId, name: requestedDomain },
      })
      if (!owned) {
        return NextResponse.json(
          { error: `Domain ${requestedDomain} not found in your account. Choose "New Domain" if you want to use a domain registered elsewhere.` },
          { status: 400 }
        )
      }
    }
    subdomain = `${slug}.${BRAND_DOMAIN}` // always also assigned a subdomain
    customDomain = requestedDomain
  }

  // Check slug uniqueness.
  const existing = await db.project.findFirst({ where: { slug } })
  if (existing) {
    return NextResponse.json(
      { error: 'A project with this name already exists' },
      { status: 409 }
    )
  }

  // ── Server assignment ─────────────────────────────────────────────
  const serverCandidates = await db.server.findMany({
    where: { status: 'active' },
    include: { _count: { select: { projects: true } } },
  })
  serverCandidates.sort((a, b) => {
    if (a.dockerInstalled !== b.dockerInstalled) {
      return a.dockerInstalled ? -1 : 1
    }
    const pa = a._count?.projects ?? 0
    const pb = b._count?.projects ?? 0
    if (pa !== pb) return pa - pb
    return a.createdAt.getTime() - b.createdAt.getTime()
  })
  const server = serverCandidates[0] || null
  if (!server) {
    return NextResponse.json(
      { error: 'No active servers available. Add a server in admin panel first.' },
      { status: 400 }
    )
  }

  // ── Resource limits from the plan ─────────────────────────────────
  const planResources = subscription?.plan
    ? parsePlanResources(subscription.plan)
    : { cpuCores: 1, ramMB: 512, storageGB: 5 }

  // ── Resolve per-method config ─────────────────────────────────────
  const cfg = body.config || {}
  const framework = cfg.framework || method.id // sensible default
  const runtime = cfg.runtime || method.runtime
  const runtimeVersion = cfg.runtimeVersion || method.defaultRuntimeVersion
  const buildCommand = cfg.buildCommand ?? method.defaultBuildCommand ?? null
  const startCommand = cfg.startCommand ?? method.defaultStartCommand ?? null
  const appPort = cfg.appPort ?? method.defaultPort
  const documentRoot = cfg.documentRoot ?? null

  // WordPress admin — required when method=wordpress.
  let wpAdminUser: string | null = null
  let wpAdminEmail: string | null = null
  let wpAdminPasswordEncrypted: string | null = null
  if (methodId === 'wordpress') {
    wpAdminUser = cfg.wpAdminUser || 'admin'
    wpAdminEmail = cfg.wpAdminEmail || ''
    if (!wpAdminEmail) {
      return NextResponse.json(
        { error: 'wpAdminEmail is required for WordPress projects' },
        { status: 400 }
      )
    }
    const wpPass = cfg.wpAdminPassword || crypto.randomBytes(12).toString('base64')
    wpAdminPasswordEncrypted = encrypt(wpPass)
  }

  // Install settings — full wizard config persisted as JSON for re-deploys.
  const installSettings = JSON.stringify({
    method: methodId,
    source,
    gitUrl: body.gitUrl || null,
    gitBranch: body.gitBranch || 'main',
    gitProvider: body.gitProvider || null,
    uploadId: body.uploadId || null,
    config: cfg,
  })

  // ── Create the Project row ────────────────────────────────────────
  const project = await db.project.create({
    data: {
      userId: decoded.userId,
      name: name.trim(),
      slug,
      framework,
      stack: method.stack,
      status: 'creating',
      serverId: server.id,
      subdomain,
      customDomain,
      sslEnabled: true,
      autoDeploy: true,
      repoUrl: body.gitUrl || null,
      // New wizard fields
      deploymentMethod: methodId,
      deploymentSource: source,
      sourceProvider: body.gitProvider || null,
      sourceBranch: body.gitBranch || 'main',
      runtime,
      runtimeVersion,
      buildCommand,
      startCommand,
      appPort,
      documentRoot,
      wpAdminUser,
      wpAdminEmail,
      wpAdminPassword: wpAdminPasswordEncrypted,
      resourceCpuCores: planResources.cpuCores,
      resourceRamMB: planResources.ramMB,
      resourceStorageGB: planResources.storageGB,
      installSettings,
    },
  })

  // ── Persist env vars (encrypted) ──────────────────────────────────
  if (Array.isArray(cfg.envVars)) {
    for (const v of cfg.envVars) {
      if (v && typeof v.key === 'string' && v.key.trim() && typeof v.value === 'string') {
        await db.environmentVariable.create({
          data: {
            projectId: project.id,
            key: v.key.trim(),
            value: encrypt(v.value),
            encrypted: true,
          },
        }).catch(() => {})
      }
    }
  }

  // ── Create Deployment + planned stages ────────────────────────────
  const deployment = await db.deployment.create({
    data: {
      projectId: project.id,
      userId: decoded.userId,
      commit: `init-${Date.now()}`,
      branch: body.gitBranch || 'main',
      status: 'queued',
      triggeredBy: 'user',
      buildLog: `🚀 Provisioned project ${project.name} (${method.name})\nTriggering deployment on ${server.name}…`,
    },
  })

  // Pre-create the planned stages so the UI can render the progress skeleton
  // immediately (before the deployer even starts).
  const stageDefs = [
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
  for (let i = 0; i < stageDefs.length; i++) {
    await db.deploymentStage.create({
      data: {
        deploymentId: deployment.id,
        name: stageDefs[i].name,
        label: stageDefs[i].label,
        status: 'pending',
        order: i,
      },
    }).catch(() => {})
  }

  // ── Fire-and-forget deploy ────────────────────────────────────────
  void deployProject({
    projectId: project.id,
    deploymentId: deployment.id,
    onLog: (msg) =>
      console.log(`[hosting/create ${deployment.id.slice(0, 8)}] ${msg}`),
  }).catch(async (err) => {
    console.error(`[hosting/create ${deployment.id}] Deploy failed:`, err)
    const errMsg = err instanceof Error ? err.message : String(err)
    try {
      await db.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'failed',
          buildLog: `❌ Deploy threw: ${errMsg}`,
          duration: 0,
        },
      })
      await db.project.update({
        where: { id: project.id },
        data: { status: 'error' },
      })
    } catch (persistErr) {
      console.error(`[hosting/create ${deployment.id}] Failed to persist failure:`, persistErr)
    }
  })

  // ── Audit ─────────────────────────────────────────────────────────
  await logAudit({
    userId: decoded.userId,
    action: 'project.create',
    resource: 'project',
    resourceId: project.id,
    req: request,
    metadata: {
      name: project.name,
      method: methodId,
      source,
      domain: customDomain || subdomain,
      serverId: server.id,
    },
  })

  return NextResponse.json(
    {
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        method: methodId,
        framework,
        status: project.status,
        subdomain,
        customDomain,
        sslEnabled: project.sslEnabled,
        deploymentMethod: methodId,
        deploymentSource: source,
        runtime,
        runtimeVersion,
        appPort,
        buildCommand,
        startCommand,
        resourceCpuCores: planResources.cpuCores,
        resourceRamMB: planResources.ramMB,
        resourceStorageGB: planResources.storageGB,
        server: {
          id: server.id,
          name: server.name,
          ip: server.ip,
          region: server.region,
        },
      },
      deployment: {
        id: deployment.id,
        status: 'queued',
        stages: stageDefs.map((s, i) => ({
          name: s.name,
          label: s.label,
          status: 'pending',
          order: i,
        })),
      },
      message: 'Deployment started',
    },
    { status: 201 }
  )
}

// ─── Legacy payload handler (back-compat) ────────────────────────────────

interface LegacyPayload {
  name: string
  framework: string
  planId?: string
  repoUrl?: string
  branch?: string
}

async function handleLegacyCreate(
  request: Request,
  decoded: { userId: string; email: string; role: string },
  body: LegacyPayload
) {
  const { name, framework, planId, repoUrl, branch } = body
  if (!name || !framework) {
    return NextResponse.json(
      { error: 'Name and framework are required' },
      { status: 400 }
    )
  }

  const subscription = await db.subscription.findFirst({
    where: { userId: decoded.userId, status: 'active' },
    include: { plan: true },
  })
  if (subscription && subscription.plan) {
    const projectCount = await db.project.count({
      where: { userId: decoded.userId },
    })
    if (projectCount >= subscription.plan.projects) {
      return NextResponse.json(
        { error: `Project limit reached (${subscription.plan.projects} projects on ${subscription.plan.name} plan)` },
        { status: 403 }
      )
    }
  }

  const slug = slugify(name)
  const subdomain = `${slug}.${BRAND_DOMAIN}`

  const existing = await db.project.findFirst({ where: { slug } })
  if (existing) {
    return NextResponse.json(
      { error: 'A project with this name already exists' },
      { status: 409 }
    )
  }

  const serverCandidates = await db.server.findMany({
    where: { status: 'active' },
    include: { _count: { select: { projects: true } } },
  })
  serverCandidates.sort((a, b) => {
    if (a.dockerInstalled !== b.dockerInstalled) {
      return a.dockerInstalled ? -1 : 1
    }
    const pa = a._count?.projects ?? 0
    const pb = b._count?.projects ?? 0
    if (pa !== pb) return pa - pb
    return a.createdAt.getTime() - b.createdAt.getTime()
  })
  const server = serverCandidates[0] || null
  if (!server) {
    return NextResponse.json(
      { error: 'No active servers available. Add a server in admin panel first.' },
      { status: 400 }
    )
  }

  const project = await db.project.create({
    data: {
      userId: decoded.userId,
      name,
      slug,
      framework,
      stack: 'nodejs',
      status: 'creating',
      serverId: server.id,
      subdomain,
      sslEnabled: true,
      autoDeploy: true,
      repoUrl: repoUrl || null,
      sourceBranch: branch || 'main',
      // Tag as a legacy project (no method) so the deployer falls back to
      // the stack-based pipeline.
      deploymentMethod: null,
      deploymentSource: repoUrl ? 'git' : 'manual',
      runtime: 'nodejs',
      runtimeVersion: '20',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      appPort: 3000,
    },
  })

  const deployment = await db.deployment.create({
    data: {
      projectId: project.id,
      userId: decoded.userId,
      commit: `init-${Date.now()}`,
      branch: branch || 'main',
      status: 'queued',
      triggeredBy: 'user',
      buildLog: `🚀 Provisioned project ${project.name}\nTriggering deployment on ${server.name}…`,
    },
  })

  // Pre-create planned stages for the legacy pipeline too.
  const stageDefs = [
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
  for (let i = 0; i < stageDefs.length; i++) {
    await db.deploymentStage.create({
      data: {
        deploymentId: deployment.id,
        name: stageDefs[i].name,
        label: stageDefs[i].label,
        status: 'pending',
        order: i,
      },
    }).catch(() => {})
  }

  void deployProject({
    projectId: project.id,
    deploymentId: deployment.id,
    onLog: (msg) =>
      console.log(`[hosting/create ${deployment.id.slice(0, 8)}] ${msg}`),
  }).catch(async (err) => {
    console.error(`[hosting/create ${deployment.id}] Deploy failed:`, err)
    const errMsg = err instanceof Error ? err.message : String(err)
    try {
      await db.deployment.update({
        where: { id: deployment.id },
        data: {
          status: 'failed',
          buildLog: `❌ Deploy threw: ${errMsg}`,
          duration: 0,
        },
      })
      await db.project.update({
        where: { id: project.id },
        data: { status: 'error' },
      })
    } catch (persistErr) {
      console.error(`[hosting/create ${deployment.id}] Failed to persist failure:`, persistErr)
    }
  })

  await logAudit({
    userId: decoded.userId,
    action: 'project.create',
    resource: 'project',
    resourceId: project.id,
    req: request,
    metadata: {
      name: project.name,
      framework: project.framework,
      subdomain,
      serverId: server.id,
      legacy: true,
    },
  })

  return NextResponse.json(
    {
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        framework: project.framework,
        status: project.status,
        subdomain: project.subdomain,
        sslEnabled: project.sslEnabled,
        autoDeploy: project.autoDeploy,
        server: {
          id: server.id,
          name: server.name,
          ip: server.ip,
          region: server.region,
        },
      },
      deployment: {
        id: deployment.id,
        status: 'queued',
        deployUrl: `https://${subdomain}`,
      },
      message: 'Project created — deployment started',
    },
    { status: 201 }
  )
}
