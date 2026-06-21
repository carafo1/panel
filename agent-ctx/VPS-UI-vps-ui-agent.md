# VPS UI Agent — Work Record

**Task ID:** VPS-UI
**Agent:** VPS UI Agent
**Task:** Build admin Server Management UI + enhance hosting panel with container/SSL controls

## Work Log

### Context gathering
- Read `/home/z/my-project/worklog.md` (last 200 lines) — found the VPS-API agent's notes confirming the 12 new VPS API routes are in place (CRUD + test SSH + provision + health + caddyfile + stats + container status/logs/restart/stop + SSL cert info/renew/toggle).
- Read existing patterns:
  - `src/components/admin/admin-panel.tsx` — tabs structure (Users / Job Queue / Servers / Payment Methods), `apiFetch` helper, status badge pattern.
  - `src/components/hosting/hosting-panel.tsx` — `getAuthHeaders()` pattern, `ProjectDetailView` skeleton/loading/dialog conventions, `timeAgo` / `formatDate` helpers, dialog patterns (Dialog/AlertDialog), `Skeleton` loading, custom scrollbar styling.
  - `src/components/provisioning/provisioning-panel.tsx` — multi-step pipeline `PipelineStepRow` (running/success/failed states with icons + connectors).
  - `src/store/auth-store.ts` — `useAuthStore` + `localStorage.getItem('deployhub_token')` JWT pattern.
- Read all 12 VPS API route files to confirm exact response shapes (server serializer with `hasSshKey`/`hasSshPassword` flags, never raw creds; provisioner step names `connect|system_update|install_docker|install_caddy|configure_firewall|setup_directories|detect_resources`; SSL cert info shape with `sans[]` and `daysUntilExpiry`; container status with `state: running|exited|paused|restarting|not_found`).
- Read `src/lib/vps/deployer.ts` `ContainerStatus` interface and `getContainerStatus` shape — confirmed response uses `containerName` for demo mode.

### Part 1 — ServersPanel (`src/components/admin/servers-panel.tsx`, new file)

Created a self-contained admin Server Management panel with:

1. **Server list** (`ServersPanel` + `ServerCard`)
   - Card grid (1 col mobile, 2 col tablet, 3 col desktop)
   - Per-card: server icon, name, IP, provider badge with `Network` icon, region with `MapPin`, project count with `Container` icon
   - Status badge with state-aware colors (active=emerald, provisioning=amber+pulse, maintenance=amber, offline=red)
   - `HealthDot` indicator with tooltip — green (healthy) / amber pulse (degraded) / red (down) / gray (unknown)
   - Three `ResourceBar` rows: CPU cores, RAM usage % (color shifts emerald→amber→red at 65%/85%), Storage usage %
   - Three `SoftwareBadge` rows: Docker (with version abbreviation), Caddy (with version), Firewall (configured/not)
   - OS info line with `Terminal` icon
   - Timestamps grid: "Provisioned" + "Health check" both as relative `timeAgo()` strings
   - 6 action buttons in a 3-col grid: Test SSH (Zap), Provision (Play), Stats (Activity), Caddyfile (FileCode), Edit (Edit), Delete (Trash2 — disabled if `projectCount > 0`, hover-red)
   - Empty state with "Add Your First Server" CTA
   - Header shows server count + total projects

2. **Add/Edit Server dialog** (`EditServerDialog`)
   - "Basic Information" section: name, ip, provider (Select with 11 providers), region, cpuCores, ramGB, storageGB, bandwidthGB
   - "SSH Connection" section: sshHost (defaults to ip when blank), sshPort (default 22), sshUser (default root), sshPassword (with show/hide `Eye`/`EyeOff` toggle), sshPrivateKey (Textarea, PEM format, with show/hide toggle)
   - When editing a server that already has credentials: info banner noting "Leave fields blank to keep current credentials"
   - AES-256-GCM encryption notice (emerald-tinted callout) at the bottom: "SSH credentials are encrypted at rest with AES-256-GCM and never displayed again after saving. Only boolean presence flags are returned by the API."
   - Validation: name + ip + cpuCores + ramGB + storageGB required (toast errors)
   - Auto-defaults sshHost to ip when creating
   - POST for create, PATCH for update — both use `authHeaders()` bearer token

3. **Test SSH dialog** (`TestSshDialog`)
   - Auto-runs `POST /api/admin/servers/[id]/test` on open
   - Loading state with spinner + "This can take up to 20 seconds" hint
   - Success: green check banner + structured details (Host, User, Auth Method, OS, Docker version, Caddy version) using `DetailRow` helper
   - Failure: red X banner + error message + amber troubleshooting box with 5 bullet-point tips (verify IP/port, SSH running, user shell access, key perms, UFW/firewall)
   - "Retry Test" button to re-run

4. **Provision dialog** (`ProvisionDialog`)
   - Auto-starts `POST /api/admin/servers/[id]/provision` on open
   - Indeterminate progress bar (CSS animation, 1.5s loop)
   - Live elapsed-time counter (mm:ss)
   - Amber info banner: "Provisioning can take 5-10 minutes on a fresh VPS. The dialog will update when complete."
   - Vertical stepper with all 7 steps (`connect`, `system_update`, `install_docker`, `install_caddy`, `configure_firewall`, `setup_directories`, `detect_resources`) — each with icon, label, status badge, duration, and message
   - Per-step state: pending (gray icon), running (amber spinner), success (green check + green connector), failed (red X), skipped (faded icon)
   - On completion: result banner showing final status + detected resources (OS, Docker, Caddy, detected CPU/RAM/Disk) — green for success, red for failure
   - On failure: error message + "Retry Provisioning" button
   - Cancel button only enabled while running (Close button otherwise)

5. **Stats dialog** (`StatsDialog`)
   - Auto-fetches `GET /api/admin/servers/[id]/stats` on open
   - Auto-refresh every 5s (toggle-able via Switch in header)
   - "Simulated (demo mode)" badge when `stats.demo === true`
   - "Updated HH:MM:SS" timestamp
   - 3 `MetricCard`s (CPU / Memory / Disk) — each with icon, value, `Progress` bar, sublabel
   - 2 metric cards (Load Average with 1/5/15-min columns; Uptime + logged-in users)
   - Docker containers table (sticky header) — name, status (with green/gray dot), per-container CPU/mem (when `containerStats` available), ports (mono, break-all)
   - "Refresh Now" button to force-refresh

6. **Caddyfile dialog** (`CaddyfileDialog`)
   - Fetches `GET /api/admin/servers/[id]/caddyfile` on open
   - Dark terminal-style viewer: zinc-950 bg, traffic-light dots, monospace content
   - "Copy" button with check feedback
   - "Reload Caddy" button (POST endpoint) — emerald-tinted primary, shows spinner while reloading
   - "Reload Content" secondary button (re-fetches file)

7. **Delete confirmation** (`DeleteServerDialog`)
   - AlertDialog with destructive styling
   - When `projectCount > 0`: red warning text + "Cannot Delete (projects attached)" disabled button (mirrors API's 409 refusal)
   - When safe: standard destructive confirmation with "Delete Permanently" button

### Part 2 — Enhance hosting-panel.tsx ProjectDetailView

Added new types (`ContainerStatus`, `ContainerInfoResponse`, `CertInfo`, `SslInfoResponse`) at the top of the file, new icons (`Container`, `Calendar`, `Network`, `FileText`), new state variables, fetchers, action handlers, and three new UI sections (Container Status card + SSL Certificate card below the existing Settings card, plus a Container Logs Dialog).

#### State + fetchers
- `containerInfo`, `containerLoading`, `containerActionLoading`, `containerLogsOpen`, `containerLogs`, `containerLogsLoading`, `logTail` state
- `sslInfo`, `sslLoading`, `sslActionLoading` state
- `fetchContainerInfo()` — GET `/api/hosting/[id]/container`, auto-refreshes every 10s **only while container state === 'running'**
- `fetchSslInfo()` — GET `/api/hosting/[id]/ssl`
- `handleContainerRestart()` — POST `/api/hosting/[id]/container/restart`
- `handleContainerStop()` — POST `/api/hosting/[id]/container/stop`
- `handleFetchContainerLogs(tail)` — GET `/api/hosting/[id]/container/logs?tail=N`
- `handleSslRenew()` — POST `/api/hosting/[id]/ssl` with `{ action: 'renew' }`
- `handleSslToggle(enabled)` — POST `/api/hosting/[id]/ssl` with `{ action: 'toggle', enabled }`

#### Container Status card (below Settings card)
- Header: title + description + manual Refresh button
- Loading state: 3 Skeleton rows
- Empty state ("No container running") with explanation + "Deploy now" button (calls existing `handleDeploy`)
- Container present:
  - 2-col grid: Name, Container ID (truncated to 12 chars), Image, Created timestamp / State badge (running=emerald pulse, paused=amber, exited/other=gray), Status, Port mappings (mono chips, break-all)
  - 3 action buttons: Restart (`RotateCcw`), Stop (`Square`, disabled if not running), View Logs (`Terminal`, opens dialog)
  - `formatDate()` for absolute timestamps

#### SSL Certificate card (below Container Status card)
- Header: title + description + manual Refresh button
- Loading state: 2 Skeleton rows
- Failure state: "Failed to load SSL info"
- SSL disabled state: amber-tinted info box explaining Caddy auto-issues via Let's Encrypt + "Enable SSL" button (calls `handleSslToggle(true)`)
- SSL enabled with cert info:
  - Status badge (issued=emerald, pending=amber+pulse, failed=red, renewing=amber+pulse, none=gray) + hostname (mono)
  - 2x2 grid: Hostname, Issuer, Issued date, Expiry date with color-coded days-left (<7d red, <30d amber, otherwise emerald)
  - SANs chip list (mono)
  - Footer: SSL toggle Switch + auto-renew badge + "Renew Certificate" button (calls `handleSslRenew`)

#### Container Logs Dialog (`ContainerLogsDialog` component, defined before `ProjectDetailView`)
- Dark terminal-style viewer: zinc-950 bg with traffic-light dots header showing `docker logs --tail N {containerName}`
- Line-by-line rendering with line numbers (zinc-600) and color-coded text:
  - `error`/`fatal` lines → red-400
  - `warn` lines → yellow-400
  - `debug` lines → zinc-500
  - normal lines → emerald-400
- Auto-scroll to bottom on new logs (`useRef` + `useEffect`)
- Tail size selector: 100 / 500 / 1000 / 5000 (changing triggers immediate refetch)
- Refresh button (re-fetches with current tail)
- Copy button (copies full log text via `navigator.clipboard`) with check feedback
- Loading state: spinner + "Fetching logs..."

### Part 3 — Admin tab wiring

- Imported `ServersPanel` from `@/components/admin/servers-panel` into `admin-panel.tsx`
- Replaced the inline ~70-line Servers tab (which only rendered minimal server cards) with a one-line `<ServersPanel />` invocation
- Removed the now-unused `ServerStatusBadge` helper function, the `ServerInfo` interface, the `servers` state slice, the `apiFetch<{ servers: ServerInfo[] }>('/admin/servers')` Promise.all leg, and unused icon imports (`Cpu`, `HardDrive`, `MapPin`, `Progress`)

### Lint + type-check
- `bun run lint` → 0 errors, 0 warnings across the whole project.
- `bunx tsc --noEmit` filtered to my 3 files (servers-panel.tsx, hosting-panel.tsx, admin-panel.tsx) → 0 errors. (Pre-existing TS errors in billing/domains/automation/stripe/vps-ssh remain, all unrelated to this task and tolerated by Turbopack.)

## Stage Summary
- 1 new file: `src/components/admin/servers-panel.tsx` (~2300 lines, 8 sub-components)
- 2 modified files: `src/components/hosting/hosting-panel.tsx` (+520 lines: types, state, handlers, 2 cards, 1 dialog), `src/components/admin/admin-panel.tsx` (-95 lines: removed inline Servers tab + replaced with new component)
- Lint: clean. TypeScript: clean for all 3 files I touched.
- All API endpoints called via relative paths (`/api/admin/servers/...`, `/api/hosting/[id]/...`) with bearer-token `Authorization` header — Caddy gateway handles routing.
- All credential fields use the project's "encrypted at rest, presence flag only" pattern — UI never displays or sends back raw creds unless explicitly typed into the form.
- Color palette: emerald accents throughout (the project's theme). No indigo/blue.
- Responsive: server cards stack on mobile, 2-col on tablet, 3-col on desktop; dialogs use `sm:max-w-2xl` / `sm:max-w-3xl` / `sm:max-w-4xl` with `max-h-[90vh] overflow-y-auto`.
- Auto-refresh: container status every 10s while running; server stats every 5s (toggle-able).
- Accessibility: ARIA labels on icon-only buttons, `Tooltip` wrappers for status indicators, semantic HTML throughout.
