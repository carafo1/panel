import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { isGithubDemoMode } from '@/lib/github'
import crypto from 'crypto'
import { isProduction } from '@/lib/demo-mode'

/**
 * Confirm a pasted personal access token is real and can read the repo.
 * Messages are written for the customer; the token itself is never logged.
 */
async function verifyPersonalToken(
  token: string,
  repoFullName: string
): Promise<{ ok: true; login: string; githubId: number } | { ok: false; error: string }> {
  if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/.test(token)) {
    return { ok: false, error: 'That does not look like a GitHub personal access token.' }
  }
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'apsamo-panel',
  }
  try {
    const me = await fetch('https://api.github.com/user', { headers, signal: AbortSignal.timeout(10_000) })
    if (me.status === 401) return { ok: false, error: 'GitHub rejected this token. It may be expired or revoked.' }
    if (!me.ok) return { ok: false, error: `GitHub answered ${me.status} when checking the token. Try again shortly.` }
    const user = (await me.json()) as { login: string; id: number }
    const repo = await fetch(`https://api.github.com/repos/${repoFullName}`, { headers, signal: AbortSignal.timeout(10_000) })
    if (repo.status === 404) {
      return { ok: false, error: `This token cannot see ${repoFullName}. Check the repository name, or give the token access to it.` }
    }
    if (!repo.ok) return { ok: false, error: `GitHub answered ${repo.status} when checking the repository.` }
    return { ok: true, login: user.login, githubId: user.id }
  } catch {
    return { ok: false, error: 'Could not reach GitHub to check the token. Try again shortly.' }
  }
}

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
    const pastedToken =
      typeof body.accessToken === 'string' ? body.accessToken.trim() : ''

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

    // Simulated tokens only outside production. In production a missing
    // OAuth app used to mint a 'ghp_demo_' token here, and the panel then
    // showed invented commits under the customer's real repository name.
    const demoMode = isGithubDemoMode() && !isProduction()
    let accessToken = ''
    let githubId = ''
    let webhookId: string | null = null
    let oauthConnected = false

    if (pastedToken) {
      // A personal access token pasted by the customer: check it works and
      // can see this repository before storing it.
      const check = await verifyPersonalToken(pastedToken, repoFullName)
      if (!check.ok) {
        return NextResponse.json({ error: check.error }, { status: 400 })
      }
      accessToken = pastedToken
      githubId = String(check.githubId)
      username = username || check.login
    } else if (!isGithubDemoMode()) {
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
    } else if (!demoMode) {
      return NextResponse.json(
        {
          error:
            'Paste a GitHub personal access token with read access to this repository (GitHub → Settings → Developer settings → Personal access tokens).',
          requiresToken: true,
        },
        { status: 400 }
      )
    } else {
      // Development only: simulate a token (legacy behavior).
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
