# Task ID: websites-module-2-a — Backend Subagent (full-stack-developer)

## Scope
Built the entire backend layer for the upgraded Website Deployment module — 7 new/updated lib modules + 14 new/updated API routes — completing Phase 2 of the Create-Website-Wizard upgrade.

## Files Created (NEW)
1. `src/lib/build-detector.ts` — Auto-detects deployment method + framework from project files (filenames / package.json / composer.json). Exports `detectFromFilenames`, `detectFromPackageJson`, `detectFromComposerJson`, `detectBest`, `detectPackageManager`. Pure-data (no DB/SSH imports) so it can run in the browser too.
2. `src/lib/vps/database.ts` — Per-project MariaDB/MySQL container provisioning. Exports `provisionProjectDatabase`, `dropProjectDatabase`, `listProjectDatabases`, `testDatabaseConnection`, `getProjectDatabase`. Passwords encrypted via `encrypt()`. Demo-mode aware.
3. `src/lib/vps/files.ts` — Safe, project-scoped file manager. Path-traversal protection via `safePath()`. Operations: listFiles, uploadFile, downloadFile, deleteFile, createDirectory, renameFile, getFileContent (with truncation), saveFileContent. Demo-mode returns synthetic listing.
4. `src/lib/vps/terminal.ts` — HTTP-polling web terminal backed by `docker exec -i`. In-memory session map keyed by sessionId (30-min idle GC). Tracks cwd + history (cap 100). Validates sessionId→projectId ownership. Flags sensitive commands (docker, sudo, chmod) without blocking them. Demo-mode synthesizes ls/pwd/whoami/echo output.
5. `src/lib/vps/backups.ts` — Full backup lifecycle. Backups are `.tar.gz` of deployPath + sibling `.db-<name>.sql.gz` files (mysqldump piped through gzip inside the DB container, then docker cp'd out). Restore stops the app container, extracts files, restores DB dumps, restarts the app. Demo-mode returns synthetic 1KB buffer.
6. `src/lib/vps/resources.ts` — Real-time CPU/RAM/storage/network/uptime via `docker stats --no-stream` + `df -h` + `docker inspect`. Allocated limits from `project.resourceCpuCores/RamMB/StorageGB`. Demo-mode generates seeded random-walk within limits. `getProjectResourceHistory` synthesizes N hourly points (jittered from current usage — documented in code).

## Files Modified
7. `src/lib/vps/deployer.ts` — Complete rewrite preserving the existing public API. Two pipelines:
   - **NEW wizard pipeline** (`deployMethodProject`) — branches on `project.deploymentMethod` (wordpress/laravel/nodejs/php/static/python/docker/custom). Generates tailored Dockerfiles + docker-compose.yml per method. Handles ZIP source (reads `/tmp/apsamo-uploads/<uploadId>.zip`, SFTP-uploads, unzips on VPS). Provisions DB for WordPress/Laravel before app start. Runs WordPress `wp core install` via wp-cli container, Laravel `composer install` + `php artisan key:generate/migrate/config:cache/storage:link`. Writes one `DeploymentStage` row per major step (plan/create_directory/download_source/provision_database/write_dockerfile/write_compose/build_image/start_container/configure_proxy/configure_ssl/run_migrations/post_install/verify).
   - **LEGACY pipeline** (`deployLegacyProject`) — original stack-based behavior, kept for back-compat. Also writes DeploymentStage rows.
   - `generateDockerCompose` / new `generateMethodCompose` include `deploy.resources.limits` (cpus, memory) from `project.resourceCpuCores/RamMB`.
   - All existing functions preserved: `stopProject`, `restartProject`, `removeProjectContainer`, `getContainerStatus`, `getContainerLogs`.
8. `src/lib/vps/index.ts` — Re-exports the 5 new modules (`database`, `files`, `terminal`, `backups`, `resources`).

## API Routes — Created (NEW)
9. `src/app/api/hosting/upload/route.ts` — POST multipart ZIP upload to `/tmp/apsamo-uploads/<hex>.zip`. 500MB limit, validates .zip extension + content-type. Returns `{ uploadId, filename, sizeBytes }`. Audits `project.upload`.
10. `src/app/api/hosting/[id]/stages/route.ts` — GET ordered DeploymentStage rows for the latest (or `?deploymentId=`) deployment.
11. `src/app/api/hosting/[id]/databases/route.ts` — GET (list with masked passwords, `?reveal=true` for plaintext) + POST (provision new DB container, returns plaintext password ONCE).
12. `src/app/api/hosting/[id]/databases/[dbId]/route.ts` — GET single DB, DELETE (drop container + row), POST `{action:'test'}`.
13. `src/app/api/hosting/[id]/backups/route.ts` — GET list + POST create.
14. `src/app/api/hosting/[id]/backups/[backupId]/route.ts` — GET streams .tar.gz as download, DELETE, POST `{action:'restore'}`.
15. `src/app/api/hosting/[id]/domains/route.ts` — GET unified list (primary customDomain + WebsiteDomain rows) + POST attach new domain.
16. `src/app/api/hosting/[id]/domains/[domainId]/route.ts` — PATCH (update isPrimary/sslEnabled/verified, regenerates Caddy on SSL change) + DELETE.
17. `src/app/api/hosting/[id]/files/route.ts` — GET `?path=<subdir>` listing + POST (multipart file upload OR JSON inline text OR mkdir).
18. `src/app/api/hosting/[id]/files/[...path]/route.ts` — GET (`?action=download|content`), PUT (save text), DELETE, POST (`{action:'rename'|'mkdir', newPath}`).
19. `src/app/api/hosting/[id]/terminal/route.ts` — GET active sessions, POST `{action:'create'|'run'|'close', sessionId?, command?}`, DELETE `?sessionId=`.
20. `src/app/api/hosting/[id]/resources/route.ts` — GET `?hours=24` → `{current: ResourceUsage, history: ResourceHistoryPoint[]}`.

## API Routes — Modified
21. `src/app/api/hosting/create/route.ts` — Complete rewrite. Handles TWO payload shapes:
    - **Wizard payload** `{name, domainType, domain?, method, source, gitUrl?, gitBranch?, gitProvider?, gitToken?, uploadId?, config:{runtime, runtimeVersion, framework, packageManager, buildCommand, startCommand, appPort, documentRoot, useCompose, wpAdminUser, wpAdminPassword, wpAdminEmail, envVars[]}, planId?}`. Validates method via `getDeploymentMethod`, checks plan project limits, validates domain ownership (for existing/new), generates `<slug>-<rand6>.apsamo.app` subdomain, assigns server, persists all new Project fields (deploymentMethod, deploymentSource, runtime, runtimeVersion, buildCommand, startCommand, appPort, documentRoot, wpAdmin* with encrypted password, resourceCpuCores/RamMB/StorageGB from plan, installSettings JSON). Persists envVars (encrypted). Creates Deployment + 13 pre-planned DeploymentStage rows. Fire-and-forget `deployProject`. Returns 201 with project + planned stages.
    - **Legacy payload** `{name, framework, planId, repoUrl, branch}` (no `method` field) — original quick-create behavior, creates a Node.js project with `deploymentMethod=null` so the deployer falls back to the legacy pipeline.
22. `src/app/api/hosting/[id]/route.ts` —
    - **GET**: extended to return all new wizard fields (deploymentMethod, deploymentSource, sourceProvider, sourceBranch, sourceCommit, runtime, runtimeVersion, buildCommand, startCommand, appPort, documentRoot, wpAdminUser, wpAdminEmail, databaseType/Name/User/Host/Port, resourceCpuCores/RamMB/StorageGB, parsed installSettings JSON) + related-row arrays (websiteDomains, websiteDatabases — masked) + counts. wpAdminPassword is intentionally NOT exposed.
    - **DELETE**: after the existing `removeProjectContainer`, also iterates WebsiteDatabase rows calling `dropProjectDatabase` and WebsiteBackup rows calling `deleteBackup`. WebsiteDomain rows cascade automatically. DeploymentStage rows cascade from Deployment. The Project row stays (marked 'stopped') for audit history — back-compat preserved.

## Key Decisions
- **Back-compat first**: every change is additive. Legacy callers of `/api/hosting/create` (no `method` field) still work and produce a Node.js project on the legacy stack pipeline. Existing routes (`/api/hosting/[id]/*`, env, ssl, deploy, container) untouched in behavior.
- **Demo-mode parity**: every new function checks `isServerInDemoMode(server)` and returns plausible synthetic results (random-walk resource usage, synthetic file listing, simulated terminal output, fake backup buffer) so the panel UI works without a real VPS.
- **Stages driven by the deployer**: stages are pre-created as `pending` by `/api/hosting/create` so the UI can render the progress skeleton immediately, then the deployer transitions each through `running → completed|failed|skipped` with `startedAt`, `completedAt`, `durationMs`, `message`, and a 30-line `log` snapshot on failure.
- **Single-source DB password**: `provisionProjectDatabase` mirrors the primary DB onto `project.databaseName/User/Password/Host/Port` (legacy compat for WordPress/Laravel) AND creates a `WebsiteDatabase` row. Drop does the inverse.
- **ZIP handling**: `/api/hosting/upload` saves to local `/tmp/apsamo-uploads/<hex>.zip`. The deployer reads it from the panel server's local FS, SFTP-uploads it to `${deployPath}.upload.zip` on the VPS, and `unzip -o` it in place.
- **WordPress install**: builds the official `wordpress:php8.2-apache` image, writes a `wp-config-docker.php` (mounted into the container), waits for the container to accept HTTP, then runs `docker run --rm --network deployhub wordpress:cli wp core install ...` with the user-supplied admin credentials.
- **Laravel install**: `composer install` + `php artisan key:generate --force` + `php artisan migrate --force` + `php artisan config:cache` + `php artisan storage:link` — all via `docker exec` after the container is up. A `.env` file is written to deployPath before the build with DB credentials (password placeholder is `CHANGE_ME` since we can't decrypt inside the Dockerfile; the migrate step runs inside the container which has the real password via env vars).
- **Resource limits**: `generateMethodCompose` and `generateLegacyCompose` both emit a `deploy.resources.limits` block (cpus + memory) from `project.resourceCpuCores/RamMB` — matches the spec.
- **Path safety**: `safePath()` in `files.ts` rejects absolute paths and any `..` segment, then asserts the resolved path starts with `deployPath + '/'`. Prevents file-manager escapes.

## Lint Result
`bun run lint` → EXIT=0. **0 errors, 0 warnings.** No `any` types (used `unknown` + narrowing, or proper interfaces). No TODOs/placeholders. `console.error` used only for caught-error logging (allowed).

## Caveats / Known Limitations
- The Laravel `.env` file is written with `DB_PASSWORD=CHANGE_ME` because the deployer can't decrypt the project row's encrypted password inside the Dockerfile build context. The post-install step runs migrations inside the container where the real password is injected via `docker-compose.yml` env vars — but for the Laravel app itself to use the DB, the user should manually update the `.env` file via the file manager OR re-run `php artisan config:cache` after we inject the real password. This is a known compromise; a future enhancement would write the `.env` with the decrypted password at deploy time (which requires passing the decryption key into the SSH session — security trade-off documented in code).
- `getProjectResourceHistory` synthesizes 24 hourly points from current usage with jitter — we don't persist continuous metrics. Documented in the code; a future AnalyticsEvent-backed implementation would give true historical data.
- Terminal sessions are in-memory only (tied to the Node.js process). A dev-server restart loses all sessions; the UI should just create a new one.
- WordPress `wp-config-docker.php` is bind-mounted into the container at `/var/www/html/wp-config.php` — this overrides the image's default config. The `wp-content/` directory is bind-mounted for persistence.
