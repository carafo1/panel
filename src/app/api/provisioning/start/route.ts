/**
 * POST /api/provisioning/start
 * ===========================
 *
 * Starts a new automated provisioning job. The caller supplies a domain name
 * + desired stack, and the orchestration engine kicks off the full pipeline
 * (domain registration → DNS → hosting → email → verification) in the
 * background. Returns immediately with the new jobId so the client can poll
 * the status endpoint for progress.
 *
 * Auth: any authenticated user.
 *
 * Audit: action='provisioning.start', resource='provisioning'.
 */
import { NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { startProvisioning } from '@/lib/orchestration'

// Strict-ish domain regex — allows labels of 1-63 chars, dots between them,
// and a TLD of 2+ alpha chars. Rejects leading/trailing dots/hyphens.
const DOMAIN_REGEX =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i

const ALLOWED_STACKS = ['nodejs', 'php', 'python', 'docker', 'wordpress'] as const
type AllowedStack = (typeof ALLOWED_STACKS)[number]

function isAllowedStack(s: string): s is AllowedStack {
  return (ALLOWED_STACKS as readonly string[]).includes(s)
}

export async function POST(request: Request) {
  try {
    // ── Auth ───────────────────────────────────────────────────────
    const token = extractTokenFromHeader(
      request.headers.get('authorization') || ''
    )
    if (!token) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }
    const user = verifyToken(token)
    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // ── Parse body ─────────────────────────────────────────────────
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const domainName = typeof body.domainName === 'string' ? body.domainName.trim().toLowerCase() : ''
    const stack = typeof body.stack === 'string' ? body.stack.trim().toLowerCase() : ''
    const includeHosting =
      typeof body.includeHosting === 'boolean' ? body.includeHosting : true
    const includeEmail =
      typeof body.includeEmail === 'boolean' ? body.includeEmail : true
    const planId =
      typeof body.planId === 'string' && body.planId.trim()
        ? body.planId.trim()
        : undefined
    const serverId =
      typeof body.serverId === 'string' && body.serverId.trim()
        ? body.serverId.trim()
        : undefined

    // ── Validate ───────────────────────────────────────────────────
    if (!domainName) {
      return NextResponse.json(
        { error: 'domainName is required' },
        { status: 400 }
      )
    }
    if (!DOMAIN_REGEX.test(domainName)) {
      return NextResponse.json(
        { error: 'domainName must be a valid domain (e.g. example.com)' },
        { status: 400 }
      )
    }
    if (!stack) {
      return NextResponse.json(
        { error: 'stack is required' },
        { status: 400 }
      )
    }
    if (!isAllowedStack(stack)) {
      return NextResponse.json(
        {
          error: `stack must be one of: ${ALLOWED_STACKS.join(', ')}`,
        },
        { status: 400 }
      )
    }

    // ── Kick off provisioning ──────────────────────────────────────
    const result = await startProvisioning({
      userId: user.userId,
      domainName,
      stack,
      includeHosting,
      includeEmail,
      planId,
      serverId,
    })

    if (result.status === 'failed' || !result.jobId) {
      // The orchestration engine already logs to console; surface the error.
      return NextResponse.json(
        {
          error: result.error || 'Failed to start provisioning job',
        },
        { status: 500 }
      )
    }

    // ── Audit ──────────────────────────────────────────────────────
    await logAudit({
      userId: user.userId,
      action: 'provisioning.start',
      resource: 'provisioning',
      resourceId: result.jobId,
      req: request,
      metadata: {
        domainName,
        stack,
        includeHosting,
        includeEmail,
        planId,
        serverId,
      },
    })

    return NextResponse.json(
      {
        jobId: result.jobId,
        status: 'started',
        message:
          'Provisioning started. Check status endpoint for updates.',
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('[api/provisioning/start] error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
