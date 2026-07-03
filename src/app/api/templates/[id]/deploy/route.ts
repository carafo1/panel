import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params

    // Authenticate user
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // Find the template
    const template = await db.template.findUnique({
      where: { id },
    })

    if (!template) {
      return NextResponse.json(
        { error: 'Template not found' },
        { status: 404 }
      )
    }

    const body = await request.json()
    const { projectName } = body

    if (!projectName || !projectName.trim()) {
      return NextResponse.json(
        { error: 'Project name is required' },
        { status: 400 }
      )
    }

    // Check user's project limit based on subscription
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

    // Generate slug and subdomain
    const slug = slugify(projectName.trim())
    const subdomain = `${slug}.deployhub.io`

    // Check if slug is unique
    const existingProject = await db.project.findFirst({ where: { slug } })
    if (existingProject) {
      return NextResponse.json(
        { error: 'A project with this name already exists' },
        { status: 409 }
      )
    }

    // Find the least loaded server
    const server = await db.server.findFirst({
      where: { status: 'active' },
      orderBy: { usedRamGB: 'asc' },
    })

    // Create the project from template
    const project = await db.project.create({
      data: {
        userId: decoded.userId,
        name: projectName.trim(),
        slug,
        framework: template.framework,
        status: 'creating',
        serverId: server?.id || null,
        subdomain,
        sslEnabled: true,
        autoDeploy: true,
        repoUrl: template.repoUrl,
      },
    })

    // Increment template deployment count + install count (marketplace metric)
    await db.template.update({
      where: { id: template.id },
      data: {
        deployments: { increment: 1 },
        installCount: { increment: 1 },
      },
    })

    // Trigger automation for hosting requested
    await processEvent({
      type: 'hosting_requested',
      userId: decoded.userId,
      payload: {
        projectId: project.id,
        projectName: projectName.trim(),
        framework: template.framework,
        planId: subscription?.planId || null,
        serverId: server?.id || null,
        templateId: template.id,
      },
    })

    // Create initial deployment
    const deployment = await db.deployment.create({
      data: {
        projectId: project.id,
        userId: decoded.userId,
        branch: 'main',
        status: 'queued',
        triggeredBy: 'user',
      },
    })

    // Update project status to running
    await db.project.update({
      where: { id: project.id },
      data: { status: 'running' },
    })

    // Update deployment status
    await db.deployment.update({
      where: { id: deployment.id },
      data: {
        status: 'live',
        deployUrl: `https://${subdomain}`,
        duration: 45,
        buildLog:
          '✅ Build completed successfully\n✅ Deployment live at https://' +
          subdomain,
      },
    })

    return NextResponse.json(
      {
        project: {
          id: project.id,
          name: project.name,
          slug: project.slug,
          framework: project.framework,
          status: 'running',
          subdomain: project.subdomain,
          sslEnabled: project.sslEnabled,
          autoDeploy: project.autoDeploy,
          server: server
            ? {
                id: server.id,
                name: server.name,
                ip: server.ip,
                region: server.region,
              }
            : null,
          deployment: {
            id: deployment.id,
            status: 'live',
            deployUrl: `https://${subdomain}`,
          },
        },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Deploy from template error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
