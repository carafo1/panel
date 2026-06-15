# Task 14 — CLI Tool Agent

## Scope
Implement a standalone Node.js CLI (`cli/deployhub.mjs`) that drives the DeployHub API using API-key auth, plus the backend wiring needed to make API keys work as a bearer token on the routes the CLI hits.

## What I changed

### Backend — API key authentication
`src/lib/auth.ts`:
- Added `verifyApiKey(token)` — looks up the raw key in `db.apiKey` (only when the token starts with the `dh_` prefix), returns the owning user's `{userId, email, role}` payload, and fire-and-forget updates `lastUsed`.
- Added `authenticateRequest(request)` — tries JWT first (fast path), then falls back to `verifyApiKey` for API keys. Accepts the key from either `Authorization: Bearer <key>` or `x-api-key`.

`src/app/api/auth/me/route.ts`
`src/app/api/hosting/route.ts`
`src/app/api/hosting/[id]/deploy/route.ts`
`src/app/api/deployments/route.ts`
`src/app/api/deployments/[id]/logs/route.ts`
`src/app/api/hosting/[id]/env/route.ts` (GET + POST)
`src/app/api/hosting/[id]/env/[varId]/route.ts` (PATCH + DELETE)
`src/app/api/domains/route.ts`
- All switched from `verifyToken(extractTokenFromHeader(...))` to the new `authenticateRequest(request)` helper, so they accept JWTs **and** API keys transparently.

### Side-fix (blocking)
- `src/lib/monitor.ts` had a `const` reassignment that broke Turbopack compilation for any route that imported it (deploy, hosting list). Rewrote the `runUptimeChecks` block to use `let monitors = []` followed by `const found = await db.uptimeMonitor.findMany(...)` + `monitors = found`. This was needed to make the deploy endpoint respond at all.

### CLI
- `cli/deployhub.mjs` — single-file ES module, zero runtime deps. Uses built-in `fetch` (Node 18+), `fs/promises`, `readline`. Config stored at `~/.deployhub/config.json` (mode 0600).
- Commands: `login`, `whoami`, `projects`, `deploy <id|name>`, `deployments [id|name]`, `logs <id>`, `env list`, `env set <KEY=value>`, `env delete <KEY>`, `domains`, `help`.
- Colours via direct ANSI escapes (green/red/yellow/cyan/gray), loading spinner via `setInterval`, table renderer, `--json` flag on all list commands, `--reveal` flag on `env list` to fetch decrypted values.
- Project name/slug resolution built-in (fetches `/api/hosting` and matches case-insensitively) so users can `deploy my-blog` instead of needing the cuid.
- `env set` transparently falls back to PATCH when the API returns 409 (key already exists), so callers don't have to know whether a var is new or being updated.
- Made executable (`chmod +x`), `bin` field added to `package.json`.

### Docs
- `cli/README.md` — installation (3 options), how to obtain an API key (Settings → API Keys), config file format, every command with examples, scripting recipes (`jq` pipelines, CI deploy), troubleshooting table.

## Manual test results (all green)
- `login <key>` — validates via `/api/auth/me`, prints user, saves config.
- `whoami` / `whoami --json` — both work, including plan + API key prefix.
- `projects` / `projects --json` — table + JSON.
- `deploy "My Test App"` (by name) — resolves name → id, triggers POST, streams build log lines, ends with `✓ Deployment is live!` summary.
- `deploy <cuid>` (by id) — same flow.
- `deployments` / `deployments "My Test App"` (filter) / `deployments --json` — all three.
- `logs <id>` — prints header + build logs.
- `env list` (empty) → `env set KEY=value` → `env list` (masked) → `env list --reveal` (decrypted) → `env set` again (PATCH path) → `env delete KEY` → `env list` (empty).
- `domains` / `domains --json`.
- `help`, no-args (= help), unknown command (error + hint), unauthenticated state (clear hint to run `login`).
- Invalid API key → `✗ Login failed`.

## Notes for downstream agents
- The `authenticateRequest` helper is the new canonical way to authenticate any API route that wants to accept both session JWTs and long-lived API keys. Old routes still using the manual `extractTokenFromHeader` + `verifyToken` pattern continue to work (JWT-only) and can be migrated opportunistically.
- API keys are stored unhashed in the `ApiKey.key` column (matches the existing `/api/user/api-keys` POST that generates them). If that ever changes to hashed storage, `verifyApiKey` will need to switch to a constant-time scan or prefix+hash lookup.
