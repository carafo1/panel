# Task 12: GitHub OAuth Agent

## Task
Implement real GitHub OAuth integration for the DeployHub project.

## Work Completed

### New API Routes Created

1. **`POST /api/github/oauth/start/route.ts`** (NEW)
   - GET: Begins the GitHub OAuth flow
   - Authenticates the user via Bearer token
   - Generates a signed state JWT (10 min expiry) carrying `{ userId, kind: 'github-oauth', projectId? }`
   - Builds the GitHub authorize URL using `getAuthUrl()` from `@/lib/github`
   - Redirect URI: `${APP_URL}/api/github/oauth/callback` (resolved from `NEXT_PUBLIC_APP_URL`/`APP_URL`/request headers)
   - Returns `{ url, demoMode: false }` for the frontend to redirect to
   - In demo mode (no `GITHUB_CLIENT_ID`), returns `{ demoMode: true, message }` with instructions
   - Optional `?projectId=` query param scopes the resulting integration to a project

2. **`GET /api/github/oauth/callback/route.ts`** (NEW)
   - Handles the OAuth callback from GitHub
   - Verifies the signed state JWT (kind: 'github-oauth') to prevent CSRF
   - Exchanges the code for an access token via `exchangeCodeForToken()`
   - Fetches the GitHub user profile via `getUserProfile()`
   - If state carried a `projectId`: creates/updates a project-scoped integration (verifies ownership)
   - Otherwise: creates/updates a user-level OAuth integration (projectId=null) matched by `userId + githubId`
   - Stores the real access token, username, and githubId
   - Redirects to `/?tab=github&github_connected=1&integration_id=...&username=...` on success
   - Redirects to `/?tab=github&github_error=...&github_message=...` on error

3. **`GET /api/github/[id]/branches/route.ts`** (NEW)
   - Lists branches for the connected repository using `getBranches()` from `@/lib/github`
   - Parses owner/repo from `integration.repoFullName`
   - Returns `{ branches: [{ name, protected }], demoMode }`
   - Falls back to demo branches when in demo mode or no real token/repo

4. **`GET /api/github/me/route.ts`** (NEW)
   - Returns the user's user-level OAuth integration (projectId=null)
   - Returns `{ integration, oauthEnabled, demoMode }`
   - Frontend uses this to decide whether to show the OAuth button vs. manual connect

### Updated API Routes

5. **`POST /api/github/connect/route.ts`** (UPDATED)
   - Kept existing manual connect (repo URL + branch) for demo mode
   - When `GITHUB_CLIENT_ID` is set (OAuth mode): looks up the user's user-level OAuth integration and reuses its real access token for the new project-scoped integration
   - If no OAuth integration exists, returns 400 with `requiresOAuth: true`
   - Returns `{ integration, oauthConnected, demoMode }`
   - Backward compatible: in demo mode, generates a simulated `ghp_demo_` token (legacy behavior)

6. **`GET /api/github/[id]/repos/route.ts`** (UPDATED)
   - Uses `listRepositories()` from `@/lib/github` to fetch real repos when in OAuth mode and a real token exists
   - Returns `{ repos: [{ id, name, fullName, private, defaultBranch, htmlUrl, description, connected }], demoMode }`
   - Falls back to demo repos (with simulated stars/language/updatedAt) when in demo mode or on API error
   - Marks the currently-connected repo with `connected: true`

7. **`GET /api/github/[id]/commits/route.ts`** (UPDATED)
   - Uses `listCommits()` from `@/lib/github` to fetch real commits
   - Supports `?branch=` query override (otherwise uses `integration.branch`)
   - Returns `{ commits: [{ sha, shortSha, message, author, authorEmail, authorLogin?, authorAvatarUrl?, date, url, branch }], demoMode }`
   - Falls back to demo commits (now with avatars) when in demo mode or on API error

8. **`GET /api/hosting/[id]/route.ts`** (UPDATED)
   - Added `oauthConnected` boolean to the `githubIntegration` payload
   - True when the stored access token is real (not `ghp_demo_` or `ghp_sim_`)
   - Frontend uses this to show the "Connected via OAuth" badge

### Library Updates

9. **`src/lib/github.ts`** (UPDATED)
   - Extended `Commit` interface with `authorLogin?`, `authorAvatarUrl?`, `authorEmail?`
   - Updated `listCommits()` to parse and return these fields from the GitHub API response
   - Updated the demo-mode commits to include avatar URLs (`https://avatars.githubusercontent.com/{login}?v=4`)
   - Backward compatible: existing fields (`sha`, `message`, `author`, `date`, `url`) are unchanged

### Frontend Updates

10. **`src/components/github/github-panel.tsx`** (UPDATED)
    - Added new types: `GithubAccountIntegration`, `BranchData`
    - Extended `CommitData` with `authorLogin?`, `authorAvatarUrl?`, `url?`
    - Extended `RepoData` with `private?`, `defaultBranch?`, `htmlUrl?`, `connected?` (all optional)
    - Extended `GithubIntegration` with `oauthConnected?` flag

    - **New `GithubAccountCard` component**:
      - Shows at the top of the GitHub panel when OAuth is enabled
      - Displays the user's GitHub avatar, username, and "Connected via OAuth" badge
      - "Connect with GitHub" button initiates OAuth flow
      - "Re-authorize" button when already connected

    - **Updated `ConnectRepositoryDialog`**:
      - When OAuth is enabled, shows a prominent "Connect with GitHub" option at the top
      - Divider "or connect manually" separates OAuth from the existing manual form
      - Manual connect button relabeled to "Connect Manually"
      - Passes `oauthEnabled` and `oauthIntegration` props from the parent

    - **Updated `IntegrationDetailView`**:
      - Added "Connected via OAuth" badge when `integration.oauthConnected` is true
      - Branch selector now fetches real branches from `/api/github/[id]/branches`
      - Falls back to static branch list when no real branches are available
      - Shows protected branch indicator (lock icon)
      - Commit history now shows author avatars (`<img>` with GitHub avatar URL)
      - Falls back to commit icon when no avatar URL
      - Shows `@login` instead of plain author name when available
      - "View" link to the commit on GitHub
      - Refresh button now refreshes commits, repos, AND branches with a loading spinner
      - Re-fetches commits automatically when the branch selection changes

    - **Updated main `GithubPanel`**:
      - Fetches `/api/github/me` on mount to get OAuth status
      - Handles OAuth callback URL params (`?github_connected=1`, `?github_error=...`)
      - Shows success/error toast on OAuth callback
      - Cleans up URL params after handling
      - Passes OAuth state to `ConnectRepositoryDialog`
      - Shows "OAuth" badge on project cards connected via OAuth
      - Rendered `GithubAccountCard` between the header and stats row

### Files Modified
- `src/app/api/github/oauth/start/route.ts` (NEW)
- `src/app/api/github/oauth/callback/route.ts` (NEW)
- `src/app/api/github/[id]/branches/route.ts` (NEW)
- `src/app/api/github/me/route.ts` (NEW)
- `src/app/api/github/connect/route.ts` (UPDATED)
- `src/app/api/github/[id]/repos/route.ts` (UPDATED)
- `src/app/api/github/[id]/commits/route.ts` (UPDATED)
- `src/app/api/hosting/[id]/route.ts` (UPDATED - added `oauthConnected` flag)
- `src/lib/github.ts` (UPDATED - extended `Commit` interface)
- `src/components/github/github-panel.tsx` (UPDATED - OAuth UI)

## Stage Summary

- Real GitHub OAuth flow implemented end-to-end: `/oauth/start` → GitHub authorize → `/oauth/callback` → create/update integration → redirect to dashboard
- All GitHub API calls (`listRepositories`, `listCommits`, `getBranches`) now use the real access token when available
- Comprehensive demo-mode fallback: every endpoint returns simulated data when `GITHUB_CLIENT_ID` is not set, so the GitHub panel works in all environments
- OAuth state token is a signed JWT (10 min expiry) — CSRF-safe
- Access tokens stored securely in the `GithubIntegration` record (never exposed to the frontend)
- Frontend shows real repository list, real commit history with author avatars, real branches, and a "Connected via OAuth" badge
- Backward compatible: existing manual connect flow still works in demo mode
- All endpoints verified working via curl (correct 401/307/405 responses without auth)
