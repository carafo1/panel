import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import { assertPublicUrl } from '@/lib/ssrf'
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
 * Per-project import endpoint.
 * ===========================
 *
 *   GET  /api/hosting/[id]/migrate   — this project's import history
 *   POST /api/hosting/[id]/migrate   — start importing a website into it
 *
 * The POST validates and returns immediately; the import itself runs in the
 * background and reports through `/api/migrations/[id]` plus the realtime
 * `migration:<id>` room. A 20-minute HTTP request would time out at every
 * proxy between the browser and here.
 */

export const runtime = 'nodejs'
export const maxDuration = 60

// ─── GET ─────────────────────────────────────────────────────────────────

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, slug: true },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const rows = await db.siteMigration.findMany({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      take: 25,
      include: {
        project: { select: { name: true, slug: true } },
        stages: { orderBy: { order: 'asc' } },
      },
    })

    return NextResponse.json({
      migrations: rows.map((r) => toMigrationView(r as never)),
      sources: IMPORT_SOURCES,
    })
  } catch (error) {
    console.error('List migrations error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ─── POST ────────────────────────────────────────────────────────────────

interface ImportPayload {
  sourceType: MigrationSourceType
  sourceMode?: MigrationSourceMode
  uploadId?: string
  sqlUploadId?: string
  url?: string
  gitUrl?: string
  gitBranch?: string
  gitToken?: string
  originalUrl?: string
  targetUrl?: string
  skipUrlRewrite?: boolean
  reuseDatabase?: boolean
  disableCachePlugins?: boolean
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const access = await requireProjectAccess(decoded, projectId, 'data')
    if (!access.ok) return access.response
    const project = await db.project.findUnique({
      where: { id: projectId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const body = (await request.json().catch(() => null)) as ImportPayload | null
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
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

    // One import at a time per project. Two concurrent runs would race on the
    // same directory and database and leave a site that is half of each.
    const inFlight = await db.siteMigration.findFirst({
      where: {
        projectId,
        status: { in: ['pending', 'detecting', 'running', 'verifying'] },
      },
      select: { id: true, status: true },
    })
    if (inFlight) {
      return NextResponse.json(
        {
          error: 'An import is already running for this website.',
          migrationId: inFlight.id,
        },
        { status: 409 }
      )
    }

    const mode: MigrationSourceMode =
      body.sourceMode && source.modes.includes(body.sourceMode)
        ? body.sourceMode
        : source.modes[0]

    // ── Resolve and validate the payload reference ──────────────────
    let sourceRef = ''
    let sizeBytes: number | undefined

    if (mode === 'upload') {
      if (!body.uploadId) {
        return NextResponse.json(
          { error: 'uploadId is required — upload the backup first.' },
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
        return NextResponse.json(
          { error: 'The upload has not finished yet.' },
          { status: 409 }
        )
      }
      sourceRef = upload.uploadId
      sizeBytes = upload.sizeBytes
    } else if (mode === 'url') {
      const remote = (body.url || '').trim()
      if (!remote) {
        return NextResponse.json({ error: 'url is required' }, { status: 400 })
      }
      // The server fetches this URL, so it must not be able to reach the
      // platform's own internal services or cloud metadata endpoints.
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
      if (!repo) {
        return NextResponse.json({ error: 'gitUrl is required' }, { status: 400 })
      }
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
        return NextResponse.json(
          { error: 'The database upload was not found.' },
          { status: 404 }
        )
      }
      sizeBytes = (sizeBytes ?? 0) + sqlUpload.sizeBytes
    }

    const targetUrl =
      body.targetUrl?.trim() ||
      `https://${project.customDomain || project.subdomain}`

    // ── Create + launch ──────────────────────────────────────────────
    const { migrationId } = await createMigration({
      projectId,
      // The person who started the import: their uploads are checked against
      // this id, and the completion notification goes to them.
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
      reuseDatabase: body.reuseDatabase === true,
      disableCachePlugins: body.disableCachePlugins !== false,
      sqlUploadId: body.sqlUploadId,
    })

    // Fire-and-forget. Failures are recorded on the migration row by the
    // runner itself, so the catch here only guards against the runner failing
    // before it can write anything.
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
      action: 'migration.start',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { migrationId, sourceType: source.id, sourceMode: mode, targetUrl },
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
        migration: created ? toMigrationView(created as never) : { id: migrationId },
        message: 'Import started',
      },
      { status: 202 }
    )
  } catch (error) {
    console.error('Start migration error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
