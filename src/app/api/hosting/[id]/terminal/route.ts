import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import {
  createTerminalSession,
  runTerminalCommand,
  closeTerminalSession,
  listTerminalSessions,
} from '@/lib/vps'

/**
 * Project Terminal Endpoint
 * =========================
 *
 *   GET    /api/hosting/[id]/terminal                       — list active sessions
 *   POST   /api/hosting/[id]/terminal                       — action dispatcher:
 *               { action: 'create' }                        — create a new session
 *               { action: 'run', sessionId, command }       — run a command
 *               { action: 'close', sessionId }              — close a session
 *   DELETE /api/hosting/[id]/terminal?sessionId=<id>        — close a session
 */

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
    const sessions = await listTerminalSessions(projectId)
    return NextResponse.json({
      sessions: sessions.map((s) => ({
        id: s.id,
        projectId: s.projectId,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        cwd: s.cwd,
        history: s.history,
      })),
    })
  } catch (error) {
    console.error('List terminal sessions error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
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

    const body = await request.json().catch(() => null)
    if (!body || typeof body.action !== 'string') {
      return NextResponse.json({ error: 'action is required' }, { status: 400 })
    }

    if (body.action === 'create') {
      const session = await createTerminalSession(projectId)
      return NextResponse.json(
        {
          sessionId: session.id,
          cwd: session.cwd,
        },
        { status: 201 }
      )
    }

    if (body.action === 'run') {
      if (typeof body.sessionId !== 'string' || typeof body.command !== 'string') {
        return NextResponse.json(
          { error: 'sessionId and command are required' },
          { status: 400 }
        )
      }
      try {
        const result = await runTerminalCommand(projectId, body.sessionId, body.command)
        return NextResponse.json(result)
      } catch (err) {
        const msg = 'Invalid request'
        return NextResponse.json({ error: msg }, { status: 400 })
      }
    }

    if (body.action === 'close') {
      if (typeof body.sessionId !== 'string') {
        return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
      }
      await closeTerminalSession(projectId, body.sessionId)
      return NextResponse.json({ message: 'Session closed' })
    }

    return NextResponse.json(
      { error: `Unknown action: ${body.action}` },
      { status: 400 }
    )
  } catch (error) {
    console.error('Terminal action error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
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
    const url = new URL(request.url)
    const sessionId = url.searchParams.get('sessionId')
    if (!sessionId) {
      // Also accept a JSON body for back-compat.
      const body = await request.json().catch(() => null)
      const sid = body?.sessionId
      if (typeof sid === 'string') {
        await closeTerminalSession(projectId, sid)
        return NextResponse.json({ message: 'Session closed' })
      }
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
    }
    await closeTerminalSession(projectId, sessionId)
    return NextResponse.json({ message: 'Session closed' })
  } catch (error) {
    console.error('Close terminal session error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
