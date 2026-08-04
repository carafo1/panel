import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { enforceLimit } from '@/lib/plan-limits'
import { logAudit } from '@/lib/audit'
import { assertPublicUrl } from '@/lib/ssrf'
import { BRAND_DOMAIN } from '@/lib/brand-config'
import {
  isValidHostname,
  isReservedHostname,
  findConflict,
  generateVerificationToken,
  getServerIps,
  VERIFY_PREFIX,
} from '@/lib/custom-domains'
import {
  createMigration,
  runMigration,
  getSourceDefinition,
  getUpload,
  IMPORT_SOURCES,
  type MigrationSourceMode,
  type MigrationSourceType,
} from '@/lib/migration'
import { toMigrationView } from '@/lib/migration/view'

/**
 * Create-and-import.
 * =================
 *
 *   POST /api/hosting/import
 *
 * Creates the destination website and starts importing into it in one call.
 * The wizard could do this as two requests, but a failure between them leaves
 * an empty project the customer did not ask for and has to clean up. Here, if
 * the import cannot be started, the project we just created is removed again.
 *
 * The site is always assigned a platform subdomain, so it is reachable the
 * moment the import finishes even when the customer's real domain still points
 * at their old host — which it will, since they have not cut over yet.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
}

interface ImportCreatePayload {
  name: string
  domainType?: 'subdomain' | 'existing' | 'external'
  domain?: string
  sourceType: MigrationSourceType
  sourceMode?: MigrationSourceMode
  uploadId?: string
  sqlUploadId?: string
  url?: string
  gitUrl?: string
  gitBranch?: string
  gitToken?: string
  originalUrl?: string
  skipUrlRewrite?: boolean
  disableCachePlugins?: boolean
}

export async function POST(request: Request) {
  let createdProjectId: string | null = null
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const body = (await request.json().catch(() => null)) as ImportCreatePayload | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const name = (body.name || '').trim()
    if (!name) {
      return NextResponse.json({ error: 'A website name is required' }, { status: 400 })
    }

    const source = getSourceDefinition(body.sourceType)
    if (!source) {
      return NextResponse.json(
        {
          error: `Unknown import source "${body.sourceType}". Supported: ${IMPORT_SOURCES.map((s) => s.id).join(', ')}`,
        },
        { status: 400 }
      )
    }

    const mode: MigrationSourceMode =
      body.sourceMode && source.modes.includes(body.sourceMode)
        ? body.sourceMode
        : source.modes[0]

    // ── Validate the payload BEFORE creating anything ────────────────
    let sourceRef = ''
    let sizeBytes: number | undefined

    if (mode === 'upload') {
      if (!body.uploadId) {
        return NextResponse.json(
          { error: 'Upload your backup before starting the import.' },
          { status: 400 }
        )
      }
      const upload = await getUpload(body.uploadId, decoded.userId)
      if (!upload) {
        return NextResponse.json(
          { error: 'That upload was not found. Please upload the backup again.' },
          { status: 404 }
        )
      }
      if (!upload.complete) {
        return NextResponse.json({ error: 'The upload has not finished yet.' }, { status: 409 })
      }
      sourceRef = upload.uploadId
      sizeBytes = upload.sizeBytes
    } else if (mode === 'url') {
      const remote = (body.url || '').trim()
      if (!remote) return NextResponse.json({ error: 'url is required' }, { status: 400 })
      try {
        await assertPublicUrl(remote)
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'That URL cannot be fetched.' },
          { status: 400 }
        )
      }
      sourceRef = remote
    } else {
      const repo = (body.gitUrl || '').trim()
      if (!repo) return NextResponse.json({ error: 'gitUrl is required' }, { status: 400 })
      if (!/^https?:\/\//i.test(repo)) {
        return NextResponse.json(
          { error: 'Use an HTTPS clone URL, e.g. https://github.com/user/repo.git' },
          { status: 400 }
        )
      }
      try {
        await assertPublicUrl(repo)
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'That repository cannot be reached.' },
          { status: 400 }
        )
      }
      sourceRef = repo
    }

    if (source.needsSeparateSql && !body.sqlUploadId) {
      return NextResponse.json(
        { error: 'This import type needs a separate .sql upload.' },
        { status: 400 }
      )
    }
    if (body.sqlUploadId) {
      const sqlUpload = await getUpload(body.sqlUploadId, decoded.userId)
      if (!sqlUpload) {
        return NextResponse.json({ error: 'The database upload was not found.' }, { status: 404 })
      }
      sizeBytes = (sizeBytes ?? 0) + sqlUpload.sizeBytes
    }

    // ── Plan limits ──────────────────────────────────────────────────
    // An imported site is still a site, so it uses the same helper as
    // /api/hosting/create. The hand-rolled check that stood here read
    // projects = 0 -- the catalogue's "unlimited" -- as "none allowed" and
    // refused every Enterprise import.
    const denied = await enforceLimit(decoded.userId, 'websites', { role: decoded.role })
    if (denied) return denied

    // ── Domain ───────────────────────────────────────────────────────
    const slug = `${slugify(name)}-${crypto.randomBytes(2).toString('hex')}`
    const subdomain = `${slug}.${BRAND_DOMAIN}`
    let customDomain: string | null = null
    let externalDomain: string | null = null

    const domainType = body.domainType || 'subdomain'
    if (domainType !== 'subdomain') {
      const requested = (body.domain || '').toLowerCase().trim()
      if (!requested) {
        return NextResponse.json(
          { error: 'A domain is required when not using a platform subdomain.' },
          { status: 400 }
        )
      }
      if (!isValidHostname(requested)) {
        return NextResponse.json(
          { error: `"${requested}" is not a valid domain name.` },
          { status: 400 }
        )
      }
      if (isReservedHostname(requested, BRAND_DOMAIN)) {
        return NextResponse.json(
          { error: `${requested} belongs to the platform and cannot be used.` },
          { status: 400 }
        )
      }
      const clash = await findConflict(requested)
      if (clash.conflict) {
        return NextResponse.json(
          { error: `${requested} is already in use on this platform.` },
          { status: 409 }
        )
      }
      if (domainType === 'existing') {
        const owned = await db.domain.findFirst({
          where: { userId: decoded.userId, name: requested },
        })
        if (!owned) {
          return NextResponse.json(
            {
              error: `${requested} is not in your account. Choose "registered elsewhere" if it is with another registrar.`,
            },
            { status: 400 }
          )
        }
        customDomain = requested
      } else {
        // SECURITY: an unverified external hostname is never written to
        // `customDomain`, because that is what the Caddy generator serves.
        // It is attached as a pending domain and connected once DNS proves
        // ownership.
        externalDomain = requested
      }
    }

    // ── Server assignment ────────────────────────────────────────────
    const candidates = await db.server.findMany({
      where: { status: 'active' },
      include: { _count: { select: { projects: true } } },
    })
    candidates.sort((a, b) => {
      if (a.dockerInstalled !== b.dockerInstalled) return a.dockerInstalled ? -1 : 1
      const pa = a._count?.projects ?? 0
      const pb = b._count?.projects ?? 0
      if (pa !== pb) return pa - pb
      return a.createdAt.getTime() - b.createdAt.getTime()
    })
    const server = candidates[0]
    if (!server) {
      return NextResponse.json(
        { error: 'No active servers are available. Add one in the admin panel first.' },
        { status: 400 }
      )
    }

    // ── Create the project shell ─────────────────────────────────────
    //
    // Framework and runtime are placeholders: detection replaces them during
    // the import once we know what the backup actually contains.
    const project = await db.project.create({
      data: {
        userId: decoded.userId,
        name,
        slug,
        framework: source.wordpress ? 'wordpress' : 'static',
        stack: source.wordpress ? 'wordpress' : 'static',
        status: 'creating',
        serverId: server.id,
        subdomain,
        customDomain,
        sslEnabled: true,
        autoDeploy: false,
        deploymentMethod: source.wordpress ? 'wordpress' : null,
        deploymentSource: 'imported',
        repoUrl: mode === 'git' ? sourceRef : null,
        sourceBranch: body.gitBranch || 'main',
        resourceCpuCores: 1,
        resourceRamMB: 1024,
        resourceStorageGB: 10,
      },
    })
    createdProjectId = project.id

    // ── Pending external domain ──────────────────────────────────────
    let pendingDomain: {
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
        pendingDomain = {
          domain: externalDomain,
          txtRecord: {
            type: 'TXT',
            name: `${VERIFY_PREFIX}.${externalDomain}`,
            value: token,
          },
          aRecord: { type: 'A', name: externalDomain, value: await getServerIps() },
        }
      } catch (err) {
        console.error('[hosting/import] external domain attach failed:', err)
      }
    }

    // ── Start the import ─────────────────────────────────────────────
    const targetUrl = `https://${customDomain || subdomain}`
    const { migrationId } = await createMigration({
      projectId: project.id,
      userId: decoded.userId,
      sourceType: source.id,
      sourceMode: mode,
      sourceRef,
      sizeBytes,
      gitBranch: body.gitBranch,
      gitToken: body.gitToken,
      originalUrl: body.originalUrl?.trim() || undefined,
      targetUrl,
      skipUrlRewrite: body.skipUrlRewrite === true,
      disableCachePlugins: body.disableCachePlugins !== false,
      sqlUploadId: body.sqlUploadId,
    })

    void runMigration({
      migrationId,
      gitToken: body.gitToken,
      onLog: (line) => console.log(`[migration ${migrationId.slice(0, 8)}] ${line}`),
    }).catch(async (err) => {
      console.error(`[migration ${migrationId}] runner crashed:`, err)
      await db.siteMigration
        .update({
          where: { id: migrationId },
          data: {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
            completedAt: new Date(),
          },
        })
        .catch(() => {})
    })

    await logAudit({
      userId: decoded.userId,
      action: 'project.import',
      resource: 'project',
      resourceId: project.id,
      req: request,
      metadata: {
        migrationId,
        sourceType: source.id,
        sourceMode: mode,
        domain: customDomain || subdomain,
        serverId: server.id,
      },
    })

    const created = await db.siteMigration.findUnique({
      where: { id: migrationId },
      include: {
        project: { select: { name: true, slug: true } },
        stages: { orderBy: { order: 'asc' } },
      },
    })

    return NextResponse.json(
      {
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
          subdomain,
          customDomain,
          pendingDomain,
          status: project.status,
          server: { id: server.id, name: server.name, region: server.region },
        },
        migration: created ? toMigrationView(created as never) : { id: migrationId },
        message: 'Website created — import started',
      },
      { status: 202 }
    )
  } catch (error) {
    console.error('Create-and-import error:', error)
    // Do not strand a half-created project the customer never sees a use for.
    if (createdProjectId) {
      await db.project.delete({ where: { id: createdProjectId } }).catch(() => {})
    }
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
