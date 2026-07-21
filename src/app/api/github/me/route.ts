import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { isGithubDemoMode } from '@/lib/github'

/**
 * GET /api/github/me
 *
 * Returns the authenticated user's user-level GitHub OAuth integration
 * (projectId=null) along with the current demo-mode flag. The frontend
 * uses this to decide whether to show "Connect with GitHub" (OAuth) or
 * fall back to manual connect, and to fetch real repos via the
 * integration's ID.
 *
 * Returns:
 *   {
 *     integration: GithubIntegration | null,  // user-level OAuth integration
 *     oauthEnabled: boolean,                  // GITHUB_CLIENT_ID set?
 *     demoMode: boolean
 *   }
 */
export async function GET(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const payload = await verifyTokenFresh(token)
    if (!payload) {
      return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
    }

    const demoMode = isGithubDemoMode()
    const oauthEnabled = !demoMode

    // Look up the user-level OAuth integration (no project attached).
    const integration = await db.githubIntegration.findFirst({
      where: {
        userId: payload.userId,
        projectId: null,
      },
      orderBy: { updatedAt: 'desc' },
    })

    return NextResponse.json({
      integration: integration
        ? {
            id: integration.id,
            userId: integration.userId,
            projectId: integration.projectId,
            githubId: integration.githubId,
            username: integration.username,
            repoFullName: integration.repoFullName,
            repoUrl: integration.repoUrl,
            branch: integration.branch,
            autoDeploy: integration.autoDeploy,
            webhookId: integration.webhookId,
            hasToken: !!integration.accessToken,
            createdAt: integration.createdAt,
            updatedAt: integration.updatedAt,
          }
        : null,
      oauthEnabled,
      demoMode,
    })
  } catch (error) {
    console.error('GitHub /me error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
