import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { getBranches, isGithubDemoMode } from '@/lib/github'

/**
 * GET /api/github/[id]/branches
 *
 * Lists branches for the connected repository using the GitHub API.
 * Requires the integration to have a valid access token and a
 * repoFullName (owner/repo). Falls back to demo branches when:
 *   - GITHUB_CLIENT_ID is not set, OR
 *   - the integration has no real access token / repoFullName.
 *
 * Returns: { branches: [{ name, protected, commitSha? }], demoMode }
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
      !integration.accessToken.startsWith('ghp_sim_') // legacy simulated tokens
    const repoFullName = integration.repoFullName || ''

    // Fallback to demo branches if no real OAuth setup or no repo chosen.
    if (demoMode || !hasRealToken || !repoFullName) {
      const [owner, repo] = repoFullName
        ? repoFullName.split('/')
        : [integration.username || 'demo-user', 'demo-repo']
      const demoBranches = await getBranches(
        integration.accessToken || 'ghp_demo_',
        owner,
        repo
      )
      return NextResponse.json({
        branches: demoBranches.map((b) => ({
          name: b.name,
          protected: b.protected,
        })),
        demoMode: true,
      })
    }

    const [owner, repo] = repoFullName.split('/')
    if (!owner || !repo) {
      return NextResponse.json(
        { error: 'Invalid repository format' },
        { status: 400 }
      )
    }

    const branches = await getBranches(integration.accessToken, owner, repo)
    return NextResponse.json({
      branches: branches.map((b) => ({ name: b.name, protected: b.protected })),
      demoMode: false,
    })
  } catch (error) {
    console.error('GitHub branches error:', error)
    const message =
      error instanceof Error ? error.message : 'Failed to load branches'
    return NextResponse.json(
      { error: message, branches: [], demoMode: true },
      { status: 500 }
    )
  }
}
