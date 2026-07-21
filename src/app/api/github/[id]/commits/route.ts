import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { listCommits, isGithubDemoMode } from '@/lib/github'

/**
 * GET /api/github/[id]/commits
 *
 * Lists recent commits for the connected repository on the integration's
 * branch (or the ?branch=... query override).
 *
 * Behavior:
 *  - Uses `listCommits()` from `@/lib/github` to call the GitHub API when
 *    the integration has a real access token and OAuth is enabled.
 *  - Parses owner/repo from `integration.repoFullName`.
 *  - Falls back to demo commits when:
 *      * GITHUB_CLIENT_ID is not set, OR
 *      * the integration has no real access token, OR
 *      * repoFullName is not set.
 *
 * Returns: { commits: [{ sha, shortSha, message, author, authorEmail,
 *                         authorLogin?, authorAvatarUrl?, date, branch, url }],
 *            demoMode }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    const { id } = await params
    const branchOverride = req.nextUrl.searchParams.get('branch') || undefined

    // Verify integration belongs to user
    const integration = await db.githubIntegration.findUnique({
      where: { id },
    })
    if (!integration || integration.userId !== payload.userId) {
      return NextResponse.json(
        { error: 'Integration not found' },
        { status: 404 }
      )
    }

    const demoMode = isGithubDemoMode()
    const hasRealToken =
      !!integration.accessToken &&
      !integration.accessToken.startsWith('ghp_sim_')
    const repoFullName = integration.repoFullName || ''
    const branch = branchOverride || integration.branch || 'main'

    const [owner, repo] = repoFullName
      ? repoFullName.split('/')
      : [integration.username || 'demo-user', 'demo-repo']

    // ── Real mode ───────────────────────────────────────────────
    if (!demoMode && hasRealToken && repoFullName) {
      try {
        const ghCommits = await listCommits(
          integration.accessToken,
          owner,
          repo,
          branch
        )
        const commits = ghCommits.map((c) => ({
          sha: c.sha,
          shortSha: c.sha.slice(0, 7),
          message: c.message,
          author: c.author,
          authorEmail: c.authorEmail,
          authorLogin: c.authorLogin,
          authorAvatarUrl: c.authorAvatarUrl,
          date: c.date,
          url: c.url,
          branch,
        }))
        return NextResponse.json({ commits, demoMode: false })
      } catch (err) {
        console.error('GitHub listCommits failed:', err)
        // Fall through to demo data on API error so the UI keeps working.
      }
    }

    // ── Demo fallback ───────────────────────────────────────────
    // Use the github.ts demo helper so the response shape matches the
    // real API contract (including avatar URLs).
    const demoCommits = await listCommits(
      integration.accessToken || 'ghp_demo_',
      owner,
      repo,
      branch
    )

    const commits = demoCommits.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: c.message,
      author: c.author,
      authorEmail: c.authorEmail,
      authorLogin: c.authorLogin,
      authorAvatarUrl: c.authorAvatarUrl,
      date: c.date,
      url: c.url,
      branch,
    }))

    return NextResponse.json({ commits, demoMode: true })
  } catch (error) {
    console.error('GitHub commits error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
