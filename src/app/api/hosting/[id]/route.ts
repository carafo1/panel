import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { purgeProject } from '@/lib/project-teardown'
import { isAdmin } from '@/lib/security'
import { requireProjectAccess } from '@/lib/project-access'
import { emitWebhookEvent } from '@/lib/webhook-delivery'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const userIsAdmin = isAdmin(decoded.role)

    const { id } = await params

    // Owner, platform admin, or a member of the team the project is shared
    // with (any team role can view). See lib/project-access.
    const access = await requireProjectAccess(decoded, id, 'view')
    if (!access.ok) return access.response

    const project = await db.project.findFirst({
      // Admins may open any project; everyone else only their own. This route
      // already tailors its response for admins (the server IP and the other
      // `userIsAdmin` branches below), but the query never let one through, so
      // an admin looking at a customer's project got "Project not found" and
      // that admin-only code could never run. The sibling routes under
      // /hosting/[id]/* have always had this bypass — this one was the outlier.
      //
      // Read only: PATCH and DELETE below stay owner-scoped on purpose, so
      // support can inspect a project without being able to change or destroy
      // it by accident. Admin mutation belongs under /api/admin/*.
      where: { id },
      include: {
        server: true,
        deployments: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
        domains: {
          include: { dnsRecords: true },
        },
        githubIntegration: true,
        websiteDatabases: true,
        websiteBackups: true,
        websiteDomains: true,
      },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Get last deployment for project card
    const lastDeployment = project.deployments.length > 0
      ? {
          id: project.deployments[0].id,
          status: project.deployments[0].status,
          createdAt: project.deployments[0].createdAt.toISOString(),
          deployUrl: project.deployments[0].deployUrl,
        }
      : null

    return NextResponse.json({
      project: {
        id: project.id,
        name: project.name,
        slug: project.slug,
        description: project.description,
        framework: project.framework,
        stack: project.stack,
        status: project.status,
        subdomain: project.subdomain,
        customDomain: project.customDomain,
        repoUrl: project.repoUrl,
        autoDeploy: project.autoDeploy,
        sslEnabled: project.sslEnabled,
        // SECURITY: hide Docker container internals + deploy path from non-admin
        // customers. These fields aid attackers if a customer account is compromised.
        ...(userIsAdmin
          ? {
              containerId: project.containerId,
              containerName: project.containerName,
              containerPort: project.containerPort,
              externalPort: project.externalPort,
              deployPath: project.deployPath,
            }
          : {}),
        sslCertStatus: project.sslCertStatus,
        sslCertExpiry: project.sslCertExpiry?.toISOString() ?? null,
        lastDeployedAt: project.lastDeployedAt?.toISOString() ?? null,
        // ── NEW: Wizard fields ───────────────────────────────────────────
        deploymentMethod: project.deploymentMethod,
        deploymentSource: project.deploymentSource,
        sourceProvider: project.sourceProvider,
        sourceBranch: project.sourceBranch,
        sourceCommit: project.sourceCommit,
        runtime: project.runtime,
        runtimeVersion: project.runtimeVersion,
        buildCommand: project.buildCommand,
        startCommand: project.startCommand,
        appPort: project.appPort,
        documentRoot: project.documentRoot,
        wpAdminUser: project.wpAdminUser,
        wpAdminEmail: project.wpAdminEmail,
        // wpAdminPassword is intentionally NOT exposed here.
        databaseType: project.databaseType,
        databaseName: project.databaseName,
        // SECURITY: hide DB connection details from non-admin customers —
        // they retrieve these via the dedicated /databases?reveal=true endpoint
        ...(userIsAdmin
          ? {
              databaseUser: project.databaseUser,
              databaseHost: project.databaseHost,
              databasePort: project.databasePort,
            }
          : {}),
        resourceCpuCores: project.resourceCpuCores,
        resourceRamMB: project.resourceRamMB,
        resourceStorageGB: project.resourceStorageGB,
        installSettings: project.installSettings
          ? (() => {
              try {
                return JSON.parse(project.installSettings)
              } catch {
                return null
              }
            })()
          : null,
        // ── NEW: Related-row counts (for sidebar / dashboard badges) ─────
        websiteDomains: project.websiteDomains.map((d) => ({
          id: d.id,
          domain: d.domain,
          isPrimary: d.isPrimary,
          sslEnabled: d.sslEnabled,
          sslStatus: d.sslStatus,
          verified: d.verified,
          createdAt: d.createdAt.toISOString(),
        })),
        websiteDatabases: project.websiteDatabases.map((d) => ({
          id: d.id,
          name: d.name,
          type: d.type,
          host: d.host,
          port: d.port,
          username: d.username,
          isPrimary: d.isPrimary,
          externalRef: d.externalRef,
          createdAt: d.createdAt.toISOString(),
        })),
        websiteBackupsCount: project.websiteBackups.length,
        websiteDatabasesCount: project.websiteDatabases.length,
        websiteDomainsCount: project.websiteDomains.length,
        lastDeployment,
        server: project.server ? {
          id: project.server.id,
          name: project.server.name,
          // SECURITY: hide server IP from non-admin customers
          ...(userIsAdmin ? { ip: project.server.ip } : {}),
          region: project.server.region,
          status: project.server.status,
          cpuCores: project.server.cpuCores,
          ramGB: project.server.ramGB,
          storageGB: project.server.storageGB,
        } : null,
        deployments: project.deployments.map((d) => ({
          id: d.id,
          commit: d.commit,
          branch: d.branch,
          status: d.status,
          deployUrl: d.deployUrl,
          duration: d.duration,
          triggeredBy: d.triggeredBy,
          createdAt: d.createdAt.toISOString(),
          updatedAt: d.updatedAt.toISOString(),
        })),
        domains: project.domains.map((dom) => ({
          id: dom.id,
          name: dom.name,
          status: dom.status,
          dnsRecords: dom.dnsRecords.map((r) => ({
            id: r.id,
            type: r.type,
            name: r.name,
            value: r.value,
            ttl: r.ttl,
          })),
        })),
        githubIntegration: project.githubIntegration ? {
          id: project.githubIntegration.id,
          userId: project.githubIntegration.userId,
          projectId: project.githubIntegration.projectId,
          githubId: project.githubIntegration.githubId,
          username: project.githubIntegration.username,
          repoFullName: project.githubIntegration.repoFullName,
          repoUrl: project.githubIntegration.repoUrl,
          branch: project.githubIntegration.branch,
          autoDeploy: project.githubIntegration.autoDeploy,
          webhookId: project.githubIntegration.webhookId,
          // True when the integration was created via real GitHub OAuth
          // (i.e. the stored token is not a demo/simulated value).
          oauthConnected:
            !!project.githubIntegration.accessToken &&
            !project.githubIntegration.accessToken.startsWith('ghp_demo_') &&
            !project.githubIntegration.accessToken.startsWith('ghp_sim_'),
          createdAt: project.githubIntegration.createdAt.toISOString(),
        } : null,
        createdAt: project.createdAt.toISOString(),
        updatedAt: project.updatedAt.toISOString(),
        teamId: project.teamId,
        // What the caller may do, so the UI can hide controls that would
        // only answer 403. The server still enforces every one of them.
        access: {
          role: access.role,
          canDeploy: access.can('deploy'),
          canConfigure: access.can('configure'),
          canAccessData: access.can('data'),
          isOwner: access.role === 'owner',
        },
      },
    })
  } catch (error) {
    console.error('Get project error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'A JSON body is required' }, { status: 400 })
    }
    const { autoDeploy, sslEnabled, repoUrl, customDomain } = body as Record<
      string,
      unknown
    >

    // SECURITY: `customDomain` is the column the Caddy generator emits, and
    // generateCaddyBlock interpolates it raw into the site address. Accepting
    // it here skipped every guard POST /domains applies — hostname shape,
    // reserved platform names, cross-tenant conflicts and, most importantly,
    // proof of ownership. A value containing a newline and a brace injected
    // arbitrary directives into the shared Caddyfile.
    //
    // Rather than duplicate four checks that would drift, refuse it here and
    // send the caller to the endpoint built for it.
    if (customDomain !== undefined) {
      return NextResponse.json(
        {
          error:
            'Set a custom domain through POST /api/hosting/' +
            id +
            '/domains, which verifies you control it first.',
        },
        { status: 400 }
      )
    }

    const access = await requireProjectAccess(decoded, id, 'configure')
    if (!access.ok) return access.response
    // Platform admins may inspect a project here but not change it (see GET);
    // admin mutation belongs under /api/admin/*.
    if (access.role === 'platform_admin') {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const project = await db.project.findUnique({ where: { id } })
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const updateData: Record<string, unknown> = {}
    if (typeof autoDeploy === 'boolean') updateData.autoDeploy = autoDeploy
    if (typeof sslEnabled === 'boolean') updateData.sslEnabled = sslEnabled
    if (typeof repoUrl === 'string') {
      const trimmed = repoUrl.trim()
      // Handed to git and echoed back to the browser. Anything that is not an
      // http(s) or scp-style git remote has no business being stored.
      if (
        trimmed &&
        !/^https?:\/\/[^\s]+$/i.test(trimmed) &&
        !/^git@[^\s:]+:[^\s]+$/i.test(trimmed)
      ) {
        return NextResponse.json(
          { error: 'repoUrl must be an https:// or git@host:path repository URL' },
          { status: 400 }
        )
      }
      updateData.repoUrl = trimmed || null
    }

    await db.project.update({
      where: { id },
      data: updateData,
    })

    // Audit project update
    await logAudit({
      userId: decoded.userId,
      action: 'project.update',
      resource: 'project',
      resourceId: id,
      req: request,
      metadata: {
        name: project.name,
        changes: updateData,
      },
    })

    return NextResponse.json({
      message: 'Settings updated successfully',
    })
  } catch (error) {
    console.error('Update project error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params

    // Only the project owner may delete it — not team members of any role,
    // and not platform admins through this route.
    const access = await requireProjectAccess(decoded, id, 'view')
    if (!access.ok) return access.response
    if (access.role !== 'owner') {
      return NextResponse.json(
        { error: 'Only the project owner can delete this project.' },
        { status: access.role === 'platform_admin' ? 404 : 403 }
      )
    }
    const project = await db.project.findUnique({ where: { id } })
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // ── Permanently delete the project ───────────────────────────────
    // Tears down the VPS deployment (container, proxy entry, deploy path,
    // databases, backups), then removes the Project row and its children.
    // Server-side cleanup is best-effort and never blocks the row deletion —
    // anything that could not be removed comes back in `warnings`.
    const { warnings } = await purgeProject(id)
    void emitWebhookEvent(decoded.userId, 'project.deleted', {
      project: { id, name: project.name, subdomain: project.subdomain },
    })

    // Audit the delete. This AuditLog row is not FK'd to the Project, so it
    // survives the deletion and is the durable record of what was removed.
    await logAudit({
      userId: decoded.userId,
      action: 'project.delete',
      resource: 'project',
      resourceId: id,
      req: request,
      metadata: {
        name: project.name,
        framework: project.framework,
        subdomain: project.subdomain,
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    })

    return NextResponse.json({
      success: true,
      message:
        warnings.length > 0
          ? 'Project deleted — some server-side cleanup could not be confirmed'
          : 'Project deleted — container removed from VPS',
      warnings,
      project: {
        id: project.id,
        name: project.name,
      },
    })
  } catch (error) {
    console.error('Delete project error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
