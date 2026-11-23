import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { logAudit } from '@/lib/audit'
import {
  createTerminalSession,
  runTerminalCommand,
  closeTerminalSession,
  listTerminalSessions,
  TerminalError,
  flagSensitiveCommand,
} from '@/lib/vps/terminal'

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
 *
 * Commands run only inside the project's own running container (see
 * lib/vps/terminal.ts); without one, create/run answer 409. Every command is
 * written to the audit log (truncated) before it runs.
 */

/** Longest command accepted, and the part of it kept in the audit log. */
const MAX_COMMAND_LENGTH = 10_000
const AUDIT_COMMAND_LENGTH = 500

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
      try {
        const session = await createTerminalSession(projectId)
        return NextResponse.json(
          {
            sessionId: session.id,
            cwd: session.cwd,
          },
          { status: 201 }
        )
      } catch (err) {
        if (err instanceof TerminalError) {
          return NextResponse.json({ error: err.message }, { status: err.status })
        }
        throw err
      }
    }

    if (body.action === 'run') {
      if (typeof body.sessionId !== 'string' || typeof body.command !== 'string') {
        return NextResponse.json(
          { error: 'sessionId and command are required' },
          { status: 400 }
        )
      }
      if (!body.command.trim()) {
        return NextResponse.json({ error: 'command is required' }, { status: 400 })
      }
      if (body.command.length > MAX_COMMAND_LENGTH) {
        return NextResponse.json(
          { error: `Command is too long (max ${MAX_COMMAND_LENGTH} characters)` },
          { status: 400 }
        )
      }
      // Audited before it runs, so a command that hangs is still on record.
      await logAudit({
        userId: decoded.userId,
        action: 'terminal.command',
        resource: 'project',
        resourceId: projectId,
        req: request,
        metadata: {
          sessionId: body.sessionId,
          command: body.command.slice(0, AUDIT_COMMAND_LENGTH),
          truncated: body.command.length > AUDIT_COMMAND_LENGTH,
          flag: flagSensitiveCommand(body.command),
          impersonatedBy: decoded.impersonatedBy,
        },
      })
      try {
        const result = await runTerminalCommand(projectId, body.sessionId, body.command)
        return NextResponse.json(result)
      } catch (err) {
        if (err instanceof TerminalError) {
          return NextResponse.json({ error: err.message }, { status: err.status })
        }
        console.error('Terminal command error:', err instanceof Error ? err.message : err)
        return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
      }
    }

    if (body.action === 'close') {
      if (typeof body.sessionId !== 'string') {
        return NextResponse.json({ error: 'sessionId is required' }, { status: 400 })
      }
      await closeTerminalSession(projectId, body.sessionId)
      return NextResponse.json({ message: 'Session closed' })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
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
