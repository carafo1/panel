import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  isGithubDemoMode,
  exchangeCodeForToken,
  getUserProfile,
} from '@/lib/github'
import jwt from 'jsonwebtoken'
import { requireSecret, sanitizeError } from '@/lib/security'

// SECURITY: reuse the central secret — never fall back to a hardcoded value.
const JWT_SECRET = requireSecret('JWT_SECRET')

/** Mirror of resolveAppUrl in /oauth/start — must produce the same redirect URI. */
function resolveAppUrl(req: NextRequest): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host')
  if (host) return `${proto}://${host}`
  return `http://localhost:3000`
}

interface OAuthState {
  userId: string
  kind: string
  projectId?: string
}

function verifyOAuthState(state: string): OAuthState | null {
  try {
    const decoded = jwt.verify(state, JWT_SECRET) as OAuthState
    if (decoded.kind !== 'github-oauth' || !decoded.userId) return null
    return decoded
  } catch {
    return null
  }
}

function buildRedirectUrl(
  req: NextRequest,
  params: Record<string, string>
): string {
  const appUrl = resolveAppUrl(req)
  const qs = new URLSearchParams(params).toString()
  return `${appUrl}/?tab=github${qs ? `&${qs}` : ''}`
}

/**
 * GET /api/github/oauth/callback?code=...&state=...
 *
 * Handles the OAuth callback from GitHub.
 *  1. Verifies the signed `state` to prevent CSRF.
 *  2. Exchanges `code` for an access token via `exchangeCodeForToken()`.
 *  3. Fetches the GitHub user profile via `getUserProfile()`.
 *  4. Creates or updates a GithubIntegration record:
 *       - If state carried a projectId → integration is scoped to that
 *         project (user must own it).
 *       - Otherwise → a user-level integration (projectId=null) that
 *         represents the GitHub account connection and is used to list
 *         repositories for the panel.
 *  5. Redirects back to the dashboard GitHub tab with a status flag.
 *
 * In demo mode, `exchangeCodeForToken`/`getUserProfile` return simulated
 * results so the rest of the flow still works end-to-end.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state')
  const error = req.nextUrl.searchParams.get('error')
  const errorDesc = req.nextUrl.searchParams.get('error_description')

  if (error) {
    return NextResponse.redirect(
      buildRedirectUrl(req, {
        github_error: error,
        ...(errorDesc ? { github_message: errorDesc } : {}),
      })
    )
  }

  if (!code || !state) {
    return NextResponse.redirect(
      buildRedirectUrl(req, {
        github_error: 'missing_params',
        github_message: 'OAuth callback is missing code or state.',
      })
    )
  }

  const statePayload = verifyOAuthState(state)
  if (!statePayload) {
    return NextResponse.redirect(
      buildRedirectUrl(req, {
        github_error: 'invalid_state',
        github_message: 'OAuth state token is invalid or expired. Please try again.',
      })
    )
  }

  try {
    const redirectUri = `${resolveAppUrl(req)}/api/github/oauth/callback`
    const { accessToken } = await exchangeCodeForToken(code, redirectUri)
    const profile = await getUserProfile(accessToken)

    const githubId = String(profile.id)
    const username = profile.login

    // If state includes a projectId, scope the integration to that project.
    // Otherwise create/update a user-level integration (projectId=null).
    let projectId: string | null = null
    if (statePayload.projectId) {
      const project = await db.project.findUnique({
        where: { id: statePayload.projectId },
      })
      if (!project || project.userId !== statePayload.userId) {
        return NextResponse.redirect(
          buildRedirectUrl(req, {
            github_error: 'invalid_project',
            github_message: 'The selected project no longer exists or is not owned by you.',
          })
        )
      }
      projectId = project.id
    }

    // Find an existing integration to update.
    // For project-scoped: unique on projectId.
    // For user-level: match on userId + githubId + projectId IS NULL.
    let integration
    if (projectId) {
      integration = await db.githubIntegration.findUnique({
        where: { projectId },
      })
    } else {
      // SQLite doesn't support filtering on null via findFirst with a
      // compound where easily, but Prisma handles `null` on equals fine.
      integration = await db.githubIntegration.findFirst({
        where: {
          userId: statePayload.userId,
          githubId,
          projectId: null,
        },
      })
    }

    if (integration) {
      integration = await db.githubIntegration.update({
        where: { id: integration.id },
        data: {
          accessToken,
          username,
          githubId,
          // Don't clobber an already-chosen repoFullName/branch when
          // refreshing a project-scoped integration.
        },
      })
    } else {
      integration = await db.githubIntegration.create({
        data: {
          userId: statePayload.userId,
          projectId: projectId ?? undefined,
          githubId,
          accessToken,
          username,
          // repoFullName / repoUrl left null until the user picks a repo
          branch: 'main',
          autoDeploy: true,
        },
      })
    }

    return NextResponse.redirect(
      buildRedirectUrl(req, {
        github_connected: '1',
        integration_id: integration.id,
        ...(profile.avatarUrl
          ? { avatar: profile.avatarUrl }
          : {}),
        ...(profile.login ? { username: profile.login } : {}),
      })
    )
  } catch (err) {
    console.error('GitHub OAuth callback error:', err)
    // SECURITY: never expose the raw error message to the browser — it can
    // contain internal details (Prisma errors, SSH errors, OAuth secrets in
    // logs). Show a generic message; the full error is logged server-side.
    return NextResponse.redirect(
      buildRedirectUrl(req, {
        github_error: 'exchange_failed',
        github_message: 'GitHub authentication failed. Please try again.',
      })
    )
  }
}

// Note: isGithubDemoMode() is intentionally not branched here — the
// underlying client functions handle demo mode transparently, so the
// callback flow stays identical for demo and real OAuth.
export const _isGithubDemoMode = isGithubDemoMode
