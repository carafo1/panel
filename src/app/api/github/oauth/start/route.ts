import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { isGithubDemoMode, getAuthUrl } from '@/lib/github'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'deployhub-secret-key-2024'
const OAUTH_STATE_EXPIRY = '10m'

/**
 * Resolve the public app URL to use for OAuth redirects.
 * Falls back through env vars and finally to the request origin so this
 * works in preview environments where NEXT_PUBLIC_APP_URL isn't set.
 */
function resolveAppUrl(req: NextRequest): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL
  if (fromEnv) return fromEnv.replace(/\/$/, '')
  const proto = req.headers.get('x-forwarded-proto') || 'https'
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host')
  if (host) return `${proto}://${host}`
  return `http://localhost:3000`
}

/**
 * Build a short-lived signed state token (JWT) used to link an OAuth
 * callback back to the authenticated user and prevent CSRF.
 *
 * Carries: { userId, kind: 'github-oauth', projectId? }
 * Expires in 10 minutes.
 */
function signOAuthState(userId: string, projectId?: string): string {
  return jwt.sign(
    { userId, kind: 'github-oauth', ...(projectId ? { projectId } : {}) },
    JWT_SECRET,
    { expiresIn: OAUTH_STATE_EXPIRY }
  )
}

/**
 * GET /api/github/oauth/start
 *
 * Begins the GitHub OAuth flow.
 * - Requires an authenticated user (Bearer token).
 * - Generates a signed state token, then returns the GitHub authorize URL.
 * - In demo mode (GITHUB_CLIENT_ID not set), returns demo instructions
 *   instead of a real URL so the UI can fall back to manual connect.
 *
 * Optional query params:
 *   - projectId: when present, the OAuth callback will associate the
 *     resulting integration with this project (still requires the user
 *     to own it). If omitted, a user-level OAuth integration is created.
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const payload = verifyToken(token)
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    // Demo mode: no real GitHub OAuth app configured. Tell the caller so
    // the UI can fall back to "Connect Manually".
    if (isGithubDemoMode()) {
      return NextResponse.json({
        demoMode: true,
        message:
          'GitHub OAuth is running in demo mode. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET to enable real OAuth. Use "Connect Manually" to create a simulated integration.',
      })
    }

    const projectId = req.nextUrl.searchParams.get('projectId') || undefined
    // Optional: allow the caller to verify the project belongs to the user
    // before starting the flow. We don't strictly need to here since the
    // callback will verify ownership when applying the result.

    const state = signOAuthState(payload.userId, projectId)
    const appUrl = resolveAppUrl(req)
    const redirectUri = `${appUrl}/api/github/oauth/callback`
    const url = getAuthUrl(state, redirectUri)

    return NextResponse.json({ url, demoMode: false })
  } catch (error) {
    console.error('GitHub OAuth start error:', error)
    return NextResponse.json(
      { error: 'Failed to start GitHub OAuth flow' },
      { status: 500 }
    )
  }
}
