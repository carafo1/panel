import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { listRepositories, isGithubDemoMode } from '@/lib/github'

/**
 * GET /api/github/[id]/repos
 *
 * Lists repositories the authenticated GitHub user has access to.
 *
 * Behavior:
 *  - Uses `listRepositories()` from `@/lib/github` to call the GitHub API
 *    when the integration has a real access token and OAuth is enabled.
 *  - Falls back to demo repos when:
 *      * GITHUB_CLIENT_ID is not set, OR
 *      * the integration's access token is missing or simulated.
 *
 * Returns: { repos: [{ id, name, fullName, private, defaultBranch,
 *                      htmlUrl, description?, stars?, language?, updatedAt? }],
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

    // ── Real mode ───────────────────────────────────────────────
    if (!demoMode && hasRealToken) {
      try {
        const ghRepos = await listRepositories(integration.accessToken)
        const repos = ghRepos.map((r) => ({
          id: r.id,
          name: r.name,
          fullName: r.fullName,
          private: r.private,
          defaultBranch: r.defaultBranch,
          htmlUrl: r.htmlUrl,
          description: r.description,
          // GitHub's /user/repos response doesn't include stars/language
          // in the same field set we expose here; leave them undefined.
          stars: undefined,
          language: undefined,
          updatedAt: undefined,
          // mark connected
          connected: integration.repoFullName === r.fullName,
        }))
        return NextResponse.json({ repos, demoMode: false })
      } catch (err) {
        console.error('GitHub listRepositories failed:', err)
        // Fall through to demo data on API error so the UI keeps working.
      }
    }

    // ── Demo fallback ───────────────────────────────────────────
    // Use the github.ts demo helper (it returns simulated repos when the
    // token starts with `ghp_demo_`). This keeps the shape consistent
    // with the real API response.
    const demoRepos = await listRepositories(
      integration.accessToken || 'ghp_demo_'
    )

    const repos = demoRepos.map((r) => ({
      name: r.name,
      fullName: r.fullName,
      private: r.private,
      defaultBranch: r.defaultBranch,
      htmlUrl: r.htmlUrl,
      description: r.description,
      stars: Math.floor(Math.random() * 300) + 5,
      language: ['TypeScript', 'JavaScript', 'Python', 'Go', 'Rust'][
        Math.floor(Math.random() * 5)
      ],
      updatedAt: new Date(
        Date.now() - Math.floor(Math.random() * 7) * 86400000
      ).toISOString(),
      connected: integration.repoFullName === r.fullName,
    }))

    return NextResponse.json({ repos, demoMode: true })
  } catch (error) {
    console.error('GitHub repos error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
