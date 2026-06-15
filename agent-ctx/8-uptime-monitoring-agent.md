# Task ID: 8 - Uptime Monitoring Agent

## Goal
Implement #11 Uptime Monitoring & Alerting - create API routes, integrate into hosting panel, and show stats in overview.

## Wave 1 Status (provided)
- `src/lib/monitor.ts` exists with: checkUptime(), runUptimeChecks(), createMonitor(), getMonitorStats(), deleteMonitor(), setMonitorEnabled()
- Prisma models `UptimeMonitor` and `UptimeCheck` exist in `prisma/schema.prisma`

## Issue Found in Wave 1
The `monitor.ts` file uses `(db as any).monitor.findMany(...)` and `(db as any).uptimeCheck.create(...)`.
However, the actual Prisma schema model is named `UptimeMonitor` (capital U), which means the Prisma client
exposes it as `db.uptimeMonitor`, NOT `db.monitor`. The current code silently fails (caught by try/catch
blocks) and returns empty/default data.

## Fix Applied
- Updated `monitor.ts` to use `db.uptimeMonitor` and `db.uptimeCheck` (correct Prisma accessors)
- Updated `runUptimeChecks` to also update the parent monitor's `lastStatus`, `lastCheckedAt`, and
  `uptimePct` fields after each check, so the listing endpoint can show live status without re-querying
  checks.

## Plan
1. Fix `src/lib/monitor.ts` (DONE - see above)
2. API routes:
   - `src/app/api/monitors/route.ts` - GET (list), POST (create)
   - `src/app/api/monitors/[id]/route.ts` - GET, PATCH, DELETE
   - `src/app/api/monitors/[id]/stats/route.ts` - GET stats with `?hours=24`
   - `src/app/api/monitors/run/route.ts` - POST trigger run (admin OR cron API key)
3. Component: `src/components/monitoring/uptime-panel.tsx`
4. Add `'monitoring'` to `DashboardTab` union in `src/store/app-store.ts`
5. Wire into `src/app/page.tsx` (import, nav item, render case)
6. Auto-create monitor on deploy in `src/app/api/hosting/[id]/deploy/route.ts`

## Auth Patterns (from existing code)
- `extractTokenFromHeader(authHeader)` + `verifyToken(token)` returns `{ userId, email, role }`
- Project ownership: `db.project.findFirst({ where: { id, userId: decoded.userId } })`
- `apiFetch(path, options)` from `@/store/auth-store` injects `Authorization: Bearer <token>` on client

## Cron / Run Endpoint Auth
The `POST /api/monitors/run` endpoint accepts EITHER:
- A valid user JWT (admin role), OR
- An `x-cron-key` header matching `process.env.CRON_API_KEY` (falls back to `'deployhub-cron-key'`
  in dev). This lets a cron job hit the endpoint without a user session.

## Files Modified
- `src/lib/monitor.ts` (fixed model name + lastStatus updates)
- `src/app/api/monitors/route.ts` (new)
- `src/app/api/monitors/[id]/route.ts` (new)
- `src/app/api/monitors/[id]/stats/route.ts` (new)
- `src/app/api/monitors/run/route.ts` (new)
- `src/components/monitoring/uptime-panel.tsx` (new)
- `src/store/app-store.ts` (added 'monitoring' tab)
- `src/app/page.tsx` (imported UptimePanel, added nav item + render case)
- `src/app/api/hosting/[id]/deploy/route.ts` (auto-create monitor on deploy)
