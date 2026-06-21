---
Task ID: VPS-API
Agent: VPS API Agent
Task: Build VPS server API routes (CRUD, test SSH, provision, stats, container mgmt, SSL)

Work Log:
- Read /home/z/my-project/worklog.md (last ~200 lines) for context on what previous agents (Domain Reseller, Coolify removal, Provisioning API, etc.) had done.
- Read all 6 required pattern files:
  - src/app/api/admin/servers/route.ts (existing GET — kept response shape `{ servers: [...] }` for UI compatibility)
  - src/lib/auth.ts (verifyToken / extractTokenFromHeader signatures)
  - src/lib/audit.ts (logAudit({userId, action, resource, resourceId?, req?, metadata?, status?}))
  - src/lib/encryption.ts (encrypt(text) / decrypt(text) — AES-256-GCM)
  - src/lib/api-response.ts (ok()/fail()/apiError helpers)
  - src/app/api/hosting/[id]/route.ts (ownership-check pattern: load project, check project.userId === decoded.userId || admin)
  - src/app/api/provisioning/[jobId]/status/route.ts (admin auth pattern with super_admin fallback)
- Read all 5 VPS library files to confirm exact function signatures:
  - src/lib/vps/ssh.ts: testConnection(creds) → {ok, info?, error?}; withConnection(creds, fn); exec(client, cmd, opts)
  - src/lib/vps/provisioner.ts: provisionServer(serverId, onProgress?) → ProvisionResult; checkServerHealth(serverId) → {status, details}; getServerCredentials(serverId) → ServerCredentials
  - src/lib/vps/deployer.ts: getContainerStatus(projectId) → ContainerStatus|null; getContainerLogs(projectId, {tail?, since?}) → string; stopProject(projectId); restartProject(projectId)
  - src/lib/vps/proxy.ts: getServerCaddyfile(serverId) → string; reloadCaddy(serverId) → {ok, message}
  - src/lib/vps/ssl.ts: getProjectCertInfo(projectId) → CertInfo|null; forceRenew(projectId); toggleSsl(projectId, enabled)
- Confirmed Prisma schema has all the new Server/Project fields the task lists (sshHost, sshPort, sshUser, sshPrivateKey, sshPassword, sshFingerprint, dockerInstalled, caddyInstalled, firewallConfigured, caddyVersion, dockerVersion, osInfo, lastProvisionedAt, lastHealthCheckAt, healthStatus, deployedPublicKey on Server; containerId, containerName, containerPort, deployPath, externalPort, sslCertStatus, sslCertExpiry, lastDeployedAt on Project).
- Created 12 API route files (1 rewritten, 11 new) — see Files section below.
- Auth pattern used everywhere (per task spec):
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)
    if (!token) return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    const decoded = verifyToken(token)
    if (!decoded) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
- Admin check on admin routes: `if (decoded.role !== 'admin' && decoded.role !== 'super_admin') return 403`
- Ownership check on hosting routes: load project, then `if (project.userId !== decoded.userId && !isAdmin) return 403`
- Credentials NEVER returned in any response — only `hasSshKey: boolean` and `hasSshPassword: boolean` presence flags. Both the list (admin/servers GET) and detail (admin/servers/[serverId] GET) responses use a shared serializer that strips raw credentials.
- Credentials encrypted at rest via `encrypt()` from @/lib/encryption before writing to DB (POST create, PATCH update). On PATCH, empty string → clear (set to null); non-empty → re-encrypt; absent → leave alone.
- Audit logs written for every state-changing admin action (server.create, server.view, server.update, server.delete, server.test, server.provision, server.caddy_reload) and every state-changing user action (project.container.restart, project.container.stop, project.ssl.renew, project.ssl.toggle). Status set to 'success' or 'failure' appropriately. Metadata never includes raw credentials — only `credentialsChanged: boolean` and presence flags.
- Stats route (admin/servers/[serverId]/stats) runs 8 commands in parallel over a single SSH connection (`top -bn1 | head -5`, `free -m`, `df -h /`, `docker ps --format ...`, `docker stats --no-stream --format ...`, `uptime`, `nproc`, `cat /proc/loadavg`) and parses each into structured JSON. In demo mode (VPS_DEMO_MODE=1 or no sshHost), returns realistic simulated stats matching the server's configured cpuCores/ramGB/storageGB.
- Provision route just awaits `provisionServer(serverId, onProgress)` and returns the full result `{ ok, steps, finalStatus, dockerVersion, caddyVersion, osInfo, detectedCpuCores, detectedRamGB, detectedStorageGB }`. onProgress callback is a no-op — the function persists progress to the DB itself; UI polls /health for live status while the long-running POST is in flight.
- All routes wrapped in try/catch with consistent error shape `{ error: string, details?: string }` and proper HTTP status codes (400/401/403/404/409/500).
- Refactored two minor bugs in the stats route mid-write:
  1. Removed unused `uptimeOut` parameter from `parseLoadAvg()` and the corresponding call site (had a `void uptimeOut` after a `return` that ESLint would flag as unreachable).
- Ran `bun run lint` → 0 errors across the whole project.
- Ran `bunx tsc --noEmit` and filtered for my new files → 0 errors in any of the 12 VPS API route files. (The broader project has pre-existing TS errors in billing/domains/analytics/etc. from other agents' code, but those are tolerated by the Turbopack dev server and unrelated to this task.)

Stage Summary:
- 12 API route files delivered (1 rewritten, 11 new):
  • src/app/api/admin/servers/route.ts (REWRITTEN — GET keep+add new fields, POST new)
  • src/app/api/admin/servers/[serverId]/route.ts (NEW — GET/PATCH/DELETE)
  • src/app/api/admin/servers/[serverId]/test/route.ts (NEW — POST test SSH)
  • src/app/api/admin/servers/[serverId]/provision/route.ts (NEW — POST provision)
  • src/app/api/admin/servers/[serverId]/health/route.ts (NEW — GET health)
  • src/app/api/admin/servers/[serverId]/caddyfile/route.ts (NEW — GET caddyfile, POST reload)
  • src/app/api/admin/servers/[serverId]/stats/route.ts (NEW — GET live stats)
  • src/app/api/hosting/[id]/container/route.ts (NEW — GET container status)
  • src/app/api/hosting/[id]/container/logs/route.ts (NEW — GET logs)
  • src/app/api/hosting/[id]/container/restart/route.ts (NEW — POST restart)
  • src/app/api/hosting/[id]/container/stop/route.ts (NEW — POST stop)
  • src/app/api/hosting/[id]/ssl/route.ts (NEW — GET cert info, POST renew/toggle)
- All routes follow the exact auth pattern from the task spec (extractTokenFromHeader → verifyToken → 401 → role check → 403).
- Never leak `sshPrivateKey` / `sshPassword` — only `hasSshKey` / `hasSshPassword` boolean flags. Shared serializer enforces this in both list and detail responses.
- All credentials encrypted at rest via `encrypt()` before DB write.
- Audit logs on every state-changing action (admin: server.create/view/update/delete/test/provision/caddy_reload; user: project.container.restart/stop, project.ssl.renew/toggle).
- Lint clean. TypeScript clean for all 12 new files. No UI code written — UI is being built by a parallel agent.
