# VPS-ORCH — VPS Orchestration Agent

## Task
Wire the new real VPS deployer (`src/lib/vps/`) into the existing provisioning orchestration engine (`src/lib/orchestration.ts`), the deployment API routes (`src/app/api/hosting/...`), and the automation engine (`src/lib/automation.ts`), while keeping the worker service (`mini-services/worker-service/`) compatible.

## Files Modified (5)
1. `src/lib/orchestration.ts` — provisionHosting() now calls deployProject(); rollbackProvisioning() calls removeProjectContainer(); ProvisioningResult.hostingStatus gains optional `containerId` field; buildResult() success message updated + failure message now surfaces real error.
2. `src/app/api/hosting/[id]/deploy/route.ts` — POST handler now creates Deployment with status='building' and fire-and-forgets deployProject(); response is 201 with `{deployment, message: 'Deployment started'}`.
3. `src/app/api/hosting/create/route.ts` — POST handler now auto-assigns server (prefer dockerInstalled=true, fewest projects), 400s if no active servers, fire-and-forgets deployProject(); response is 201 with `{project, deployment, message}`.
4. `src/app/api/hosting/[id]/route.ts` — DELETE handler now calls removeProjectContainer() to tear down Docker + Caddy on the VPS; response is `{success: true, message: 'Project deleted — container removed from VPS'}`.
5. `src/lib/automation.ts` — deployment_status_check job now polls getContainerStatus(projectId) for the real container state and transitions deployments accordingly. Falls back to attempt-count-based transition in demo mode (no sshHost or VPS_DEMO_MODE=1).

## Files Verified (not modified)
- `mini-services/worker-service/index.ts` — pure polling loop that POSTs to `/api/admin/jobs/process?limit=20` every 10s. Makes no assumptions about job internals; compatible with the updated automation.ts without changes.
- `src/app/api/billing/checkout/route.ts` — creates projects directly in the Stripe demo path (does NOT route through /api/hosting/create); backward-compat preserved.
- `src/lib/worker.ts` — processPendingJobs/processJob dispatch chain unchanged.
- `src/app/api/admin/jobs/process/route.ts` — route unchanged.
- `prisma/schema.prisma` — already has all required fields (Project.containerId/Name/Port/deployPath/externalPort/sslCertStatus/sslCertExpiry/lastDeployedAt; Server.sshHost/dockerInstalled).

## Verification
- `bun run lint` → 0 errors, 0 warnings.
- `bunx tsc --noEmit` filtered to my 5 modified files → 0 errors in any of my code (4 pre-existing TS errors in automation.ts around the legacy `create_coolify_project` case and `results.push(...)` in processEvent/processPendingJobs — untouched by me, unrelated to this task, tolerated by Turbopack).

## End-to-End Flow
1. User creates project → POST /api/hosting/create
2. Route auto-assigns best server (active + dockerInstalled + fewest projects)
3. Project row created (status='creating', serverId set)
4. Deployment row created (status='queued')
5. Fire-and-forget deployProject({projectId, deploymentId, onLog}) — HTTP 201 returns immediately
6. Deployer (real mode): clones repo / writes placeholder → writes Dockerfile + docker-compose.yml → `docker compose build` (streamed) → `docker compose up -d` → connects container to deployhub network → verifies container running → configureProjectProxy() regenerates Caddyfile + reloads Caddy (auto-HTTPS via Let's Encrypt) → updates Project (status='running', containerId, containerName, containerPort, externalPort, deployPath, sslCertStatus='issued', sslCertExpiry=+90d, lastDeployedAt) + Deployment (status='live', deployUrl, duration)
7. Deployer (demo mode): returns simulated success with realistic build log + fake containerId; same DB updates
8. Worker service (port 3005) polls /api/admin/jobs/process?limit=20 every 10s
9. /api/admin/jobs/process → processPendingJobs → processJob (lib/worker.ts) → automationProcessJob (lib/automation.ts) → executeAction case 'deployment_status_check':
   - Real mode: getContainerStatus(projectId) → state='running' confirms deployment is live; state='exited'/'not_found' (and dep was 'building') marks failed; state='paused'/'restarting'/unknown leaves as 'building' and re-queues in 15s
   - Demo mode: attempt-count-based transition (queued → building → live after attempts>=1)
10. User can DELETE /api/hosting/[id] → removeProjectContainer() runs `docker compose down --rmi local -v` on VPS, removes Caddy proxy entry, deletes /opt/deployhub/projects/<slug>, clears Project container fields + sets status='stopped'

## Critical Requirements Met
1. Demo mode safety — all VPS functions gracefully handle demo mode; deployProject returns simulated success; removeProjectContainer is a no-op except for DB cleanup; getContainerStatus returns simulated state. No code breaks when no real VPS is configured.
2. Fire-and-forget pattern — both API routes use `void deployProject({...}).catch(async err => {...})` so the HTTP response returns immediately. The deployer updates the Deployment row directly as it progresses.
3. Error handling — deployProject() failures are persisted by the deployer itself (Project status='error', Deployment status='failed' with error in buildLog). API routes have additional defensive .catch() handlers that re-persist if the deployer threw before persisting.
4. Server assignment — prefers active+dockerInstalled=true with fewest projects; falls back to any active server; returns 400 `{error: 'No active servers available. Add a server in admin panel first.'}` if NO servers exist at all.
5. Backward compat — billing/checkout route creates projects directly without going through hosting/create; flow unaffected.
6. Clean imports — `bun run lint` passes.
