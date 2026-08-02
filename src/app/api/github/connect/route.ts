import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { isGithubDemoMode } from '@/lib/github'
import crypto from 'crypto'

/**
 * POST /api/github/connect
 *
 * Links a GitHub repository to a hosting project.
 *
 * Body: { projectId, repoUrl, branch? }
 *
 * Behavior:
 *  - Always parses the repo URL into owner + repoFullName.
 *  - If GitHub OAuth is enabled (GITHUB_CLIENT_ID set):
 *      * Looks up the user's user-level OAuth integration (projectId=null)
 *        and reuses its real access token for the new project-scoped
 *        integration. If none exists, returns 400 telling the caller to
 *        complete OAuth first.
 *  - If in demo mode (no GITHUB_CLIENT_ID):
 *      * Generates a simulated token (legacy behavior) so the rest of the
 *        GitHub panel (commits, repos, branches) still works via demo data.
 *
 * This endpoint is also used by the "Connect Manually" dialog in the UI
 * when the user prefers to type a repo URL rather than go through OAuth.
 */
export async function POST(req: NextRequest) {
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

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { projectId, repoUrl, branch } = body

    if (!projectId || !repoUrl) {
      return NextResponse.json(
        { error: 'Project ID and repo URL are required' },
        { status: 400 }
      )
    }

    // Verify project ownership
    const project = await db.project.findUnique({
      where: { id: projectId },
    })
    if (!project || project.userId !== payload.userId) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    // Check if integration already exists for this project
    const existing = await db.githubIntegration.findUnique({
      where: { projectId },
    })
    if (existing) {
      return NextResponse.json(
        { error: 'GitHub integration already exists for this project' },
        { status: 400 }
      )
    }

    // Parse repo URL to extract owner and repo name.
    // Supports: https://github.com/owner/repo, github.com/owner/repo, owner/repo
    let username = ''
    let repoFullName = ''
    const match = repoUrl.match(
      /(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/\s]+)/
    )
    if (match) {
      username = match[1]
      repoFullName = `${match[1]}/${match[2].replace(/\.git$/, '')}`
    } else {
      const parts = repoUrl.split('/')
      if (parts.length >= 2) {
        username = parts[0]
        repoFullName = repoUrl.replace(/\.git$/, '')
      } else {
        return NextResponse.json(
          { error: 'Invalid repository URL format' },
          { status: 400 }
        )
      }
    }

    const demoMode = isGithubDemoMode()
    let accessToken = ''
    let githubId = ''
    let webhookId: string | null = null
    let oauthConnected = false

    if (!demoMode) {
      // OAuth mode: reuse the user's user-level OAuth integration token.
      const oauthIntegration = await db.githubIntegration.findFirst({
        where: {
          userId: payload.userId,
          projectId: null,
        },
        orderBy: { updatedAt: 'desc' },
      })

      if (!oauthIntegration || !oauthIntegration.accessToken) {
        return NextResponse.json(
          {
            error:
              'GitHub OAuth is enabled but you have not connected your account yet. Click "Connect with GitHub" to authorize.',
            requiresOAuth: true,
          },
          { status: 400 }
        )
      }

      accessToken = oauthIntegration.accessToken
      githubId = oauthIntegration.githubId
      username = username || oauthIntegration.username
      webhookId = oauthIntegration.webhookId
      oauthConnected = true
    } else {
      // Demo mode: simulate a token (legacy behavior).
      accessToken = `ghp_demo_${crypto.randomBytes(12).toString('hex')}`
      githubId = `gh_${crypto.randomBytes(8).toString('hex')}`
      webhookId = `wh_${crypto.randomBytes(8).toString('hex')}`
    }

    const integration = await db.githubIntegration.create({
      data: {
        userId: payload.userId,
        projectId,
        githubId,
        accessToken,
        refreshToken: null,
        username,
        repoFullName,
        repoUrl,
        branch: branch || 'main',
        autoDeploy: true,
        webhookId,
      },
    })

    return NextResponse.json(
      {
        integration,
        oauthConnected,
        demoMode,
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('GitHub connect error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
