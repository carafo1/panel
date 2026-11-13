import { NextRequest, NextResponse } from 'next/server'
import { isProduction } from '@/lib/demo-mode'
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

    // Decide by the TOKEN, not by whether OAuth is configured: a pasted
    // personal access token is real even when the OAuth app is not set up.
    // Only a demo token, outside production, gets simulated data.
    const ghToken = integration.accessToken || ''
    const simulated = ghToken.startsWith('ghp_demo_') && isGithubDemoMode() && !isProduction()
    const hasRealToken = !!ghToken && !ghToken.startsWith('ghp_sim_') && !simulated

    // ── Real mode ───────────────────────────────────────────────
    if (hasRealToken) {
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
        console.error('GitHub listRepositories failed:', err instanceof Error ? err.message : err)
        // Falling back to demo data here showed invented repositories when
        // GitHub was unreachable or the token had been revoked.
        return NextResponse.json(
          { error: 'Could not load repositories from GitHub. The token may have expired — reconnect the repository.' },
          { status: 502 }
        )
      }
    }

    if (!simulated) {
      return NextResponse.json(
        { error: 'This repository is not connected with a valid GitHub token. Reconnect it.' },
        { status: 400 }
      )
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
      stars: undefined,
      language: undefined,
      updatedAt: undefined,
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
