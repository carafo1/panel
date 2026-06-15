import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { processEvent } from '@/lib/automation'

export async function POST(
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

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id } = await params

    const project = await db.project.findFirst({
      where: { id, userId: decoded.userId },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    if (project.status !== 'running') {
      return NextResponse.json(
        { error: 'Project must be running to deploy' },
        { status: 400 }
      )
    }

    // Create a new deployment
    const deployment = await db.deployment.create({
      data: {
        projectId: project.id,
        userId: decoded.userId,
        commit: `auto-${Date.now()}`,
        branch: 'main',
        status: 'building',
        triggeredBy: 'user',
      },
    })

    // Trigger deployment automation
    await processEvent({
      type: 'deployment_triggered',
      userId: decoded.userId,
      payload: {
        projectId: project.id,
        deploymentId: deployment.id,
        framework: project.framework,
      },
    })

    // Simulate deployment completing
    await db.deployment.update({
      where: { id: deployment.id },
      data: {
        status: 'live',
        deployUrl: `https://${project.subdomain}`,
        duration: Math.floor(Math.random() * 120) + 30,
        buildLog: `✅ Build started at ${new Date().toISOString()}\n✅ Installing dependencies...\n✅ Building ${project.framework} application...\n✅ Build completed successfully\n✅ Deployment is live at https://${project.subdomain}`,
      },
    })

    return NextResponse.json({
      deployment: {
        id: deployment.id,
        projectId: project.id,
        status: 'live',
        deployUrl: `https://${project.subdomain}`,
        triggeredBy: 'user',
        createdAt: deployment.createdAt,
      },
    })
  } catch (error) {
    console.error('Deploy error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
