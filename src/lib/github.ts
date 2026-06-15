/**
 * GitHub OAuth and REST API client.
 *
 * Used by:
 *  - #4 GitHub OAuth
 *
 * When GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set, runs in DEMO MODE
 * - returns simulated data so the GitHub integration UI can be exercised
 * without a real GitHub OAuth app.
 *
 * Docs: https://docs.github.com/en/rest
 */

function getCredentials(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export function isGithubDemoMode(): boolean {
  return !getCredentials()
}

const API_BASE = 'https://api.github.com'

async function githubFetch<T>(
  path: string,
  token: string,
  init: RequestInit = {}
): Promise<T> {
  const res = await fetch(path.startsWith('http') ? path : `${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API ${res.status}: ${text}`)
  }
  if (res.status === 204) return {} as T
  return (await res.json()) as T
}

/**
 * Build the GitHub OAuth authorization URL that the user will be redirected to.
 */
export function getAuthUrl(state: string, redirectUri: string): string {
  const clientId = process.env.GITHUB_CLIENT_ID || 'demo_client_id'
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo read:user user:email',
    state,
  })
  return `https://github.com/login/oauth/authorize?${params.toString()}`
}

interface TokenResult {
  accessToken: string
  tokenType: string
  scope: string
}

/**
 * Exchange an OAuth code for an access token.
 */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<TokenResult> {
  const creds = getCredentials()
  if (!creds) {
    // Demo mode - return a fake token
     
    console.log('[github] DEMO MODE: exchangeCodeForToken', code)
    return {
      accessToken: `ghp_demo_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      tokenType: 'bearer',
      scope: 'repo read:user user:email',
    }
  }

  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  })
  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: ${res.status}`)
  }
  const data = (await res.json()) as {
    access_token: string
    token_type: string
    scope: string
    error?: string
    error_description?: string
  }
  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error} - ${data.error_description}`)
  }
  return {
    accessToken: data.access_token,
    tokenType: data.token_type,
    scope: data.scope,
  }
}

interface UserProfile {
  id: number
  login: string
  name: string
  avatarUrl: string
  email?: string
}

/**
 * Get the authenticated user's profile.
 */
export async function getUserProfile(token: string): Promise<UserProfile> {
  if (isGithubDemoMode() && token.startsWith('ghp_demo_')) {
     
    console.log('[github] DEMO MODE: getUserProfile')
    return {
      id: 1234567,
      login: 'demo-user',
      name: 'Demo User',
      avatarUrl: 'https://avatars.githubusercontent.com/u/0?v=4',
      email: 'demo@deployhub.local',
    }
  }

  const data = await githubFetch<{
    id: number
    login: string
    name: string | null
    avatar_url: string
    email: string | null
  }>('/user', token)
  return {
    id: data.id,
    login: data.login,
    name: data.name || data.login,
    avatarUrl: data.avatar_url,
    email: data.email || undefined,
  }
}

interface Repository {
  id: number
  name: string
  fullName: string
  private: boolean
  defaultBranch: string
  htmlUrl: string
  description?: string
}

/**
 * List repositories accessible to the authenticated user.
 */
export async function listRepositories(token: string): Promise<Repository[]> {
  if (isGithubDemoMode() && token.startsWith('ghp_demo_')) {
     
    console.log('[github] DEMO MODE: listRepositories')
    return [
      {
        id: 1,
        name: 'my-nextjs-app',
        fullName: 'demo-user/my-nextjs-app',
        private: false,
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/demo-user/my-nextjs-app',
        description: 'A demo Next.js app',
      },
      {
        id: 2,
        name: 'api-server',
        fullName: 'demo-user/api-server',
        private: true,
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/demo-user/api-server',
        description: 'Backend API service',
      },
      {
        id: 3,
        name: 'landing-page',
        fullName: 'demo-user/landing-page',
        private: false,
        defaultBranch: 'main',
        htmlUrl: 'https://github.com/demo-user/landing-page',
      },
    ]
  }

  const data = await githubFetch<Array<{
    id: number
    name: string
    full_name: string
    private: boolean
    default_branch: string
    html_url: string
    description: string | null
  }>>('/user/repos?per_page=100&sort=updated', token)
  return data.map((r) => ({
    id: r.id,
    name: r.name,
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    htmlUrl: r.html_url,
    description: r.description || undefined,
  }))
}

interface Commit {
  sha: string
  message: string
  author: string
  date: string
  url: string
  /** GitHub login of the commit author, when available. */
  authorLogin?: string
  /** GitHub avatar URL of the commit author, when available. */
  authorAvatarUrl?: string
  /** Email of the commit author (from the git commit metadata). */
  authorEmail?: string
}

/**
 * List recent commits on a branch.
 */
export async function listCommits(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  perPage = 10
): Promise<Commit[]> {
  if (isGithubDemoMode() && token.startsWith('ghp_demo_')) {
     
    console.log('[github] DEMO MODE: listCommits', owner, repo, branch)
    const now = Date.now()
    const demoAuthors = [
      { name: 'Demo User', login: 'demo-user', email: 'demo@deployhub.local' },
      { name: 'Alice Johnson', login: 'alice', email: 'alice@users.noreply.github.com' },
      { name: 'Bob Smith', login: 'bob', email: 'bob@users.noreply.github.com' },
    ]
    return Array.from({ length: Math.min(perPage, 5) }).map((_, i) => {
      const a = demoAuthors[i % demoAuthors.length]
      return {
        sha: `${(i + 1).toString(16).padStart(7, '0')}`.repeat(6).slice(0, 7),
        message: i === 0 ? 'feat: latest improvement' : `chore: tweak #${i}`,
        author: a.name,
        authorLogin: a.login,
        authorEmail: a.email,
        authorAvatarUrl: `https://avatars.githubusercontent.com/${a.login}?v=4`,
        date: new Date(now - i * 86400000).toISOString(),
        url: `https://github.com/${owner}/${repo}/commit/demo-${i}`,
      }
    })
  }

  const data = await githubFetch<Array<{
    sha: string
    commit: {
      message: string
      author: { name: string; date: string; email: string }
    }
    html_url: string
    author?: { login: string; avatar_url: string } | null
  }>>(
    `/repos/${owner}/${repo}/commits?sha=${encodeURIComponent(branch)}&per_page=${perPage}`,
    token
  )
  return data.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author.name,
    authorEmail: c.commit.author.email,
    authorLogin: c.author?.login,
    authorAvatarUrl: c.author?.avatar_url,
    date: c.commit.author.date,
    url: c.html_url,
  }))
}

interface Branch {
  name: string
  protected: boolean
}

/**
 * List branches in a repository.
 */
export async function getBranches(
  token: string,
  owner: string,
  repo: string
): Promise<Branch[]> {
  if (isGithubDemoMode() && token.startsWith('ghp_demo_')) {
     
    console.log('[github] DEMO MODE: getBranches', owner, repo)
    return [
      { name: 'main', protected: true },
      { name: 'develop', protected: false },
      { name: 'feature/auth', protected: false },
    ]
  }

  const data = await githubFetch<Array<{
    name: string
    protected: boolean
  }>>(`/repos/${owner}/${repo}/branches?per_page=100`, token)
  return data.map((b) => ({ name: b.name, protected: b.protected }))
}

interface WebhookResult {
  id: number
  url: string
}

/**
 * Create a webhook on a repository (used for auto-deploy on push).
 */
export async function createWebhook(
  token: string,
  owner: string,
  repo: string,
  config: { url: string; content_type?: 'json' | 'form'; secret?: string; events: string[] }
): Promise<WebhookResult> {
  if (isGithubDemoMode() && token.startsWith('ghp_demo_')) {
     
    console.log('[github] DEMO MODE: createWebhook', owner, repo, config.url)
    return {
      id: Math.floor(Math.random() * 1_000_000),
      url: config.url,
    }
  }

  const data = await githubFetch<{ id: number; url: string }>(
    `/repos/${owner}/${repo}/hooks`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        name: 'web',
        active: true,
        events: config.events,
        config: {
          url: config.url,
          content_type: config.content_type || 'json',
          secret: config.secret || undefined,
        },
      }),
    }
  )
  return { id: data.id, url: config.url }
}

/**
 * Delete a webhook from a repository.
 */
export async function deleteWebhook(
  token: string,
  owner: string,
  repo: string,
  hookId: number
): Promise<boolean> {
  if (isGithubDemoMode() && token.startsWith('ghp_demo_')) {
    return true
  }
  await githubFetch(`/repos/${owner}/${repo}/hooks/${hookId}`, token, {
    method: 'DELETE',
  })
  return true
}
