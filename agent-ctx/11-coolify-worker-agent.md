# Task 11 - Coolify Provisioning + Build/Deploy Pipeline + Job Worker

## Agent: Coolify + Worker Agent

## Summary
Implemented end-to-end Coolify integration (with demo-mode fallback), real build/deploy pipeline via JobQueue + automation engine, and a standalone worker-service that drives both job processing and uptime checks via HTTP.

## Files Modified

### Schema & DB
- `prisma/schema.prisma` — added `coolifyDeploymentId String?` column to `Deployment` model so the Coolify deployment UUID (returned by `deployApplication`) can be persisted and used for later status polling.
- `src/lib/db.ts` — bumped `SCHEMA_VERSION` to `'2025-06-18-deployment-coolify-id'` so the dev server discards the cached PrismaClient and picks up the new column.
- Ran `bun run db:push` to apply the schema change and regenerate the Prisma client.

### Automation engine
- `src/lib/automation.ts`:
  - Imported `getApplicationStatus` from `@/lib/coolify`.
  - Added `'deployment_status_check'` to the `ActionType` union.
  - Added a new `case 'deployment_status_check'` in `executeAction` that:
    - Loads the Deployment + Project rows.
    - Short-circuits if the deployment is already in a terminal state (live/failed/rolled_back).
    - Calls `getApplicationStatus(project.coolifyId)` against Coolify (or demo mode).
    - Maps Coolify's status vocabulary (running/healthy/ready → live; error/exited/failed → failed; building/deploying/in_progress → mapped; queued → building; stopped/paused → failed) onto our internal Deployment.status.
    - Updates the Deployment row's status, deployUrl, duration, and appends a status line to buildLog.
    - Bumps the Project status to 'running' on success.
    - Sends a Notification (success/error) to the user.
    - If still in-flight, schedules a follow-up `deployment_status_check` job with `runAt = now + 15s` (capped at 30 attempts) so the worker picks it up again. This implements polling without modifying the existing `processJob` wrapper in `worker.ts`.
    - On Coolify call failure, schedules a retry (capped at 10 attempts) so transient errors don't permanently break the polling loop.

### Hosting routes (Wave 11 changes)
- `src/app/api/hosting/create/route.ts` — full rewrite:
  - After creating the Project row, calls `createApplication()` from `@/lib/coolify` to provision the app (demo-mode returns `demo-app-<ts>`; real Coolify returns a UUID).
  - Persists the returned `coolifyId` on the Project.
  - Falls back to a synthetic id if Coolify provisioning throws (logs the error).
  - Creates a Deployment row, then calls `deployApplication(coolifyId)` to trigger a real build.
  - Stores the returned `coolifyDeploymentId` on the Deployment.
  - Queues a `deployment_status_check` job via `createJob()` so the worker polls Coolify for status updates.
  - Returns `coolifyDemoMode` flag in the response so the UI knows whether it's talking to real Coolify.
  - Body now accepts optional `repoUrl` and `branch` so they flow through to Coolify.
  - Audit log metadata now includes `coolifyAppId`, `coolifyDemoMode`, `coolifyDeploymentId`, `provisioningError`.
- `src/app/api/hosting/[id]/deploy/route.ts` — full rewrite:
  - Removed the old `processEvent({type: 'deployment_triggered'})` call (which immediately faked a 'live' status) and replaced it with real Coolify integration.
  - Creates a Deployment row first (status='queued'), then calls `deployApplication(project.coolifyId)`.
  - Stores the returned `coolifyDeploymentId` on the Deployment and flips status to 'building'.
  - On Coolify call failure, marks the Deployment as 'failed' and returns 502 with the error detail.
  - Queues a `deployment_status_check` job (via `createJob`) so the worker polls Coolify until the build reaches a terminal state.
  - Body now accepts optional `branch` and `commit` overrides.
  - Preserved the auto-provision uptime monitor logic from Wave 8.
  - Audit log metadata includes `coolifyDeploymentId` and `coolifyDemoMode`.
- `src/app/api/hosting/[id]/route.ts` (DELETE handler):
  - Before updating the DB status to 'stopped', calls `deleteApplication(project.coolifyId)` from `@/lib/coolify` to clean up the server-side resource.
  - Wrapped in try/catch with detailed error logging — DB cleanup continues even if Coolify delete fails (per task spec: "Continue with DB deletion even if Coolify call fails").
  - Audit log metadata now includes `coolifyId` and `coolifyDemoMode`.

### New API routes
- `src/app/api/deployments/[id]/status/route.ts` (NEW):
  - GET: pulls the Deployment + Project, then makes a fresh `getApplicationStatus(project.coolifyId)` call against Coolify to get the live status & URL.
  - Best-effort: also calls `getDeploymentLogs(coolifyAppId, coolifyDeploymentId)` to fetch live build log text from Coolify.
  - Maps Coolify's vocabulary onto our internal Deployment.status vocabulary and returns a unified response: `{ deploymentId, projectId, status, dbStatus, coolifyStatus, url, logs, coolifyDeploymentId, coolifyDemoMode, duration, updatedAt, createdAt }`.
  - In demo mode the response reflects `status: 'live'`, `coolifyStatus: 'running'`, and the simulated Coolify build log text.
- `src/app/api/admin/jobs/process/route.ts` (NEW):
  - POST: manually triggers processing of pending JobQueue rows via `processPendingJobs(limit)` from `@/lib/worker`.
  - Auth: either admin JWT (Bearer token with role='admin') OR `x-cron-key` header matching `CRON_API_KEY` env var (falls back to `deployhub-cron-key` in dev, same as `/api/monitors/run`).
  - Supports `?limit=N` query param (1-100, default 10).
  - Returns `{ processed, succeeded, failed, ranAt }`.
  - Also exposes GET (alias for POST) so cron systems that can't POST can still trigger it.

### Worker service (mini-service, port 3005)
- `mini-services/worker-service/package.json` (NEW):
  ```json
  { "name": "worker-service", "version": "1.0.0", "scripts": { "dev": "bun --hot index.ts" } }
  ```
- `mini-services/worker-service/index.ts` (NEW):
  - Standalone Bun service on port 3005.
  - Every 10s: POST `http://localhost:3000/api/admin/jobs/process?limit=20` with `x-cron-key` header → drives the automation engine to process pending JobQueue rows (which is what advances `deployment_status_check` jobs through to completion).
  - Every 60s: POST `http://localhost:3000/api/monitors/run` with `x-cron-key` header → drives the uptime monitor sweep.
  - Kicks off an immediate tick on startup so we don't wait a full interval before the first batch.
  - HTTP helper `callNextApi()` uses `AbortController` with a 30-60s timeout per call.
  - Tracks per-tick stats: `runs`, `successes`, `failures`, `lastRunAt`, `lastResult`, `lastError` for both jobs and monitors.
  - GET `/health` returns JSON: `{ status, service, uptime, uptimeHuman, nextApiBase, intervals, stats, timestamp }`.
  - GET `/` returns a friendly service description.
  - Graceful shutdown on SIGTERM/SIGINT (clears timers, closes HTTP server, force-exits after 5s).
  - Designed as a separate Bun project (per task spec) that drives the Next.js API via HTTP instead of importing from the Next.js codebase — avoids the cross-project import problem entirely.

### Realtime service (build log polish)
- `mini-services/realtime-service/index.ts`:
  - Rewrote `BUILD_LOG_LINES` (~50 lines) to mirror actual shell commands Coolify runs:
    - `$ git clone --depth 1 https://github.com/deployhub/app.git .`
    - `$ npm install --no-audit --no-fund` (with realistic `npm WARN deprecated` + `added 342 packages` output)
    - `$ npm run build` (with `> next build`, route table, "Compiled successfully")
    - `$ docker build -t app-{id} .` (with realistic `[+] Building 18.4s (12/12) FINISHED` and per-layer log)
  - Rewrote `DEPLOY_LOG_LINES` to use `$ docker run -d -p 8080:8080 --name app-{id} ...` with multi-line backslash continuation, Traefik reverse-proxy setup, Let's Encrypt SSL provisioning, and a real health-check log line (`GET https://{subdomain}/api/health → 200 OK (84ms)`).
  - Rewrote `FAIL_LOG_LINES` to end with `❌ Deployment failed at https://{subdomain}`.
  - Added a `renderLine()` helper inside `simulateDeployment` that substitutes `{id}` and `{subdomain}` placeholders in every log line, so the simulated logs read like a real build for the specific deployment.
  - Derived a realistic subdomain (`<shortId>.deployhub.io`) from the deploymentId instead of using `<projectId>.deployhub.io` (which was wrong — projectId isn't a slug).
  - Updated the final "Deployment live" URL to use the realistic subdomain.
  - All three log arrays (BUILD/DEPLOY/FAIL) now route through `renderLine()` so the placeholder substitution is consistent.

## Verification (live dev server)
1. POST /api/hosting/create → returns project with `coolifyId: 'demo-app-<ts>'`, `coolifyDemoMode: true`, and a deployment with `coolifyDeploymentId: 'demo-deploy-<ts>'`. Dev log shows `[coolify] DEMO MODE: createApplication` + `[coolify] DEMO MODE: deployApplication`.
2. POST /api/hosting/[id]/deploy → returns deployment with `coolifyDeploymentId`, `status: 'building'`, and message "Deployment triggered - worker will poll for status updates".
3. GET /api/deployments/[id]/status → returns live status from Coolify: `{ status: 'live', coolifyStatus: 'running', url: 'https://coolify-<ts>.deployhub.io', logs: '🚀 DeployHub Coolify Deployment...' }`.
4. DELETE /api/hosting/[id] → logs `[coolify] DEMO MODE: deleteApplication` and returns `{ message: 'Project stopped successfully', project: { ..., coolifyId: 'coolify-<ts>' } }`.
5. POST /api/admin/jobs/process (with x-cron-key) → returns `{ processed: N, succeeded: N, failed: 0, ranAt: '...' }`. Admin JWT path also works (returns `processed: 2` after the two test deployments queued status checks).
6. Worker-service (port 3005):
   - GET /health returns full stats with `runs`, `successes`, `failures`, `lastResult` for both jobs and monitors.
   - Logs `[worker] jobs: processed=1 succeeded=1 failed=0` and `[worker] monitors: checked=1 up=0 down=1` on each tick.
   - After ~15s the worker's deployment_status_check job processed the demo-mode deployment and updated its status from 'building' → 'live' (verified via /api/deployments/[id]/status).
7. Realtime service (port 3003): restarted to pick up the new build log lines. GET /health returns 200.

## Operational notes
- All Coolify calls gracefully fall back to demo mode when `COOLIFY_API_URL` / `COOLIFY_API_TOKEN` env vars are not set — the entire flow (provision → deploy → poll → delete) works out-of-the-box in demo mode and will switch to live Coolify calls the moment those env vars are set, with no code changes required.
- The worker-service uses `x-cron-key` auth (defaulting to `deployhub-cron-key` in dev) so it doesn't need a user session. Set `CRON_API_KEY` in production to lock it down.
- The polling design (one JobQueue row per check, re-queued with `runAt = now + 15s`) keeps the existing `processPendingJobs` / `processJob` infrastructure unchanged — no special-casing in the worker for this job type.
- All existing deployment functionality (audit logs, automation events, monitor auto-provisioning, environment variables, etc.) is preserved. The only behavioral change is that deployments now go through real Coolify calls (or demo-mode equivalents) instead of being immediately faked as 'live'.
