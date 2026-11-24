import { NextResponse } from 'next/server'
import { withRateLimit } from '@/lib/rate-limit'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { encrypt } from '@/lib/encryption'
import { logAudit } from '@/lib/audit'
import { deployProject } from '@/lib/vps'
import { validateGitUrl } from '@/lib/vps/deploy-safety'
import { isAdmin } from '@/lib/security'
import { getDeploymentMethod, type DeploymentMethodId } from '@/lib/deployment-methods'
import { BRAND_DOMAIN } from '@/lib/brand-config'
import { emitWebhookEvent } from '@/lib/webhook-delivery'
import {
  isValidHostname,
  isReservedHostname,
  findConflict,
  generateVerificationToken,
  getServerIps,
  VERIFY_PREFIX,
} from '@/lib/custom-domains'

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

async function postHandler(request: Request) {
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
  domainType?: 'subdomain' | 'existing' | 'new' | 'external'
  domain?: string
  /**
   * How this project deploys.
   *
   * 'auto'   — build and go live as soon as it is created, and on later
   *            triggers. This is the default and the previous behaviour.
   * 'manual' — create the project and stop. Nothing is built until the owner
   *            presses Deploy, which is what you want when the code is not
   *            ready, the DNS has not propagated, or you are staging a
   *            release for a specific moment.
   */
  deployMode?: 'auto' | 'manual'
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
  // SECURITY: the URL is handed to `git clone` as root on the VPS. A local
  // path such as /opt/deployhub/projects/<another site>, or a file:// URL,
  // would clone another tenant's code. Same rule as PATCH /api/hosting/[id].
  if (body.gitUrl !== undefined && body.gitUrl !== null && body.gitUrl !== '') {
    const git = validateGitUrl(body.gitUrl)
    if (!git.ok) {
      return NextResponse.json({ error: git.error }, { status: 400 })
    }
    body.gitUrl = git.url
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
  // SECURITY/BILLING: without an active plan the limit check below was skipped
  // entirely, so any newly registered account could create unlimited websites
  // for free (and every website is a foothold on the shared host). Staff can
  // still create sites (e.g. for customers or testing).
  if (!subscription && !isAdmin(decoded.role)) {
    return NextResponse.json(
      { error: 'An active hosting plan is required to create a website.' },
      { status: 402 }
    )
  }
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
  // Set instead of customDomain when the domain is registered elsewhere: it
  // is attached as a pending WebsiteDomain and only serves once verified.
  let externalDomain: string | null = null

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
    if (!isValidHostname(requestedDomain)) {
      return NextResponse.json(
        { error: `"${requestedDomain}" is not a valid domain name.` },
        { status: 400 }
      )
    }
    if (isReservedHostname(requestedDomain, BRAND_DOMAIN)) {
      return NextResponse.json(
        { error: `${requestedDomain} belongs to the platform and cannot be used. Use your own domain.` },
        { status: 400 }
      )
    }
    // Platform-wide, so a customer cannot claim a hostname already serving
    // another tenant here.
    const clash = await findConflict(requestedDomain)
    if (clash.conflict) {
      return NextResponse.json(
        { error: `${requestedDomain} is already in use on this platform.` },
        { status: 409 }
      )
    }

    if (domainType === 'existing') {
      const owned = await db.domain.findFirst({
        where: { userId: decoded.userId, name: requestedDomain },
      })
      if (!owned) {
        return NextResponse.json(
          { error: `Domain ${requestedDomain} not found in your account. Choose "Use a domain registered elsewhere" if it is with another registrar.` },
          { status: 400 }
        )
      }
    }

    subdomain = `${slug}.${BRAND_DOMAIN}` // always also assigned a subdomain

    // SECURITY: `customDomain` is what the Caddy generator emits, so it is
    // only set for a domain we already know the customer controls (one
    // registered through this platform). An EXTERNAL domain is recorded as a
    // pending WebsiteDomain instead — the site goes live on its subdomain
    // immediately, and the domain is attached automatically by the domain
    // sweep once DNS proves ownership. Writing it here would serve a hostname
    // nobody has proven they own.
    if (domainType === 'existing') {
      customDomain = requestedDomain
    } else {
      externalDomain = requestedDomain
    }
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

  // Default to auto so existing callers (and the payment path) behave exactly
  // as before; only an explicit 'manual' holds the build back.
  const autoDeploy = body.deployMode !== 'manual'

  // ── Create the Project row ────────────────────────────────────────
  const project = await db.project.create({
    data: {
      userId: decoded.userId,
      name: name.trim(),
      slug,
      framework,
      stack: method.stack,
      // A manual project has been created but never built. 'stopped' is the
      // existing status for "not running", which the UI already renders with
      // a Deploy action — inventing a new one would leave every status badge
      // and filter in the panel not knowing about it.
      status: autoDeploy ? 'creating' : 'stopped',
      serverId: server.id,
      subdomain,
      customDomain,
      sslEnabled: true,
      autoDeploy,
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
  void emitWebhookEvent(decoded.userId, 'project.created', { project: { id: project.id, name: project.name, subdomain: project.subdomain } }, { projectId: project.id })

  // ── External domain: attach as PENDING ────────────────────────────
  // Hosting is provisioned immediately and serves on the subdomain. The
  // domain sweep connects this hostname (and Caddy issues its certificate)
  // as soon as the customer's DNS proves ownership — no transfer required,
  // and no manual "Verify" click needed.
  let pendingDomainSetup: {
    domain: string
    txtRecord: { type: string; name: string; value: string }
    aRecord: { type: string; name: string; value: string[] }
  } | null = null

  if (externalDomain) {
    try {
      const token = generateVerificationToken()
      await db.websiteDomain.create({
        data: {
          projectId: project.id,
          domain: externalDomain,
          isPrimary: true,
          sslEnabled: true,
          sslStatus: 'none',
          verified: false,
          verificationToken: token,
        },
      })
      pendingDomainSetup = {
        domain: externalDomain,
        txtRecord: {
          type: 'TXT',
          name: `${VERIFY_PREFIX}.${externalDomain}`,
          value: token,
        },
        aRecord: { type: 'A', name: externalDomain, value: await getServerIps() },
        // DELIBERATELY NO NAMESERVER OPTION.
        //
        // ns1/ns2.apsamo.com have A records but nothing authoritative listens
        // on port 53 — `dig @ns1.apsamo.com` returns "connection refused".
        // Telling a customer to delegate to them would stop their domain
        // resolving entirely: website, email, every subdomain. Offering NS
        // delegation requires actually running authoritative DNS (PowerDNS or
        // similar) plus glue records at the registrar.
      }
    } catch (err) {
      // Never fail the whole site creation over the domain attachment — the
      // customer can add it from the Domains tab afterwards.
      console.error('[hosting/create] external domain attach failed:', err)
    }
  }

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

  // ── Manual mode: the project exists, nothing is built ─────────────
  // Return before creating a Deployment. A queued deployment that nobody is
  // going to run would sit in the UI looking stuck, and would make the
  // project's "last deployment" read as pending forever.
  if (!autoDeploy) {
    return NextResponse.json(
      {
        success: true,
        deployMode: 'manual',
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
          status: project.status,
          subdomain: project.subdomain,
          customDomain: project.customDomain,
          autoDeploy: project.autoDeploy,
        },
        message:
          'Project created. Nothing has been built yet — press Deploy when you are ready to put it live.',
      },
      { status: 201 }
    )
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
        // Pending external domain, if one was supplied. The site is already
        // live on `subdomain`; this one connects automatically once DNS
        // proves ownership.
        pendingDomain: pendingDomainSetup,
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
  const { name, framework, planId, branch } = body
  let { repoUrl } = body
  if (!name || !framework) {
    return NextResponse.json(
      { error: 'Name and framework are required' },
      { status: 400 }
    )
  }
  // Same rule as the wizard path: only remote https:// / git@ repositories.
  if (repoUrl !== undefined && repoUrl !== null && repoUrl !== '') {
    const git = validateGitUrl(repoUrl)
    if (!git.ok) {
      return NextResponse.json({ error: git.error }, { status: 400 })
    }
    repoUrl = git.url
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

  // Same choice as the wizard path, so both entry points behave identically.
  const autoDeploy = (body as { deployMode?: string }).deployMode !== 'manual'

  const project = await db.project.create({
    data: {
      userId: decoded.userId,
      name,
      slug,
      framework,
      stack: 'nodejs',
      status: autoDeploy ? 'creating' : 'stopped',
      serverId: server.id,
      subdomain,
      sslEnabled: true,
      autoDeploy,
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
  void emitWebhookEvent(decoded.userId, 'project.created', { project: { id: project.id, name: project.name, subdomain: project.subdomain } }, { projectId: project.id })

  if (!autoDeploy) {
    return NextResponse.json(
      {
        success: true,
        deployMode: 'manual',
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
          status: project.status,
          subdomain: project.subdomain,
          autoDeploy: project.autoDeploy,
        },
        message:
          'Project created. Nothing has been built yet — press Deploy when you are ready to put it live.',
      },
      { status: 201 }
    )
  }

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

// Rate limited: see lib/rate-limit. 20 requests per 60s per IP.
export const POST = withRateLimit(postHandler, { limit: 20, windowMs: 60000 })
