# Task ID: 6 — Audit Logging Agent

## Task
Integrate audit logging into 10 key API routes + create an audit log viewer API + UI panel.

## Context Loaded
- `/home/z/my-project/worklog.md` (Tasks 1-5, 7 already complete)
- `/home/z/my-project/src/lib/audit.ts` — `logAudit({ userId, action, resource, resourceId, req, metadata, status })` with built-in silent try/catch
- `/home/z/my-project/prisma/schema.prisma` — `AuditLog` model (Wave 1)
- `/home/z/my-project/src/lib/auth.ts` — `verifyToken` / `extractTokenFromHeader` pattern
- All 10 target API routes + `src/components/settings/settings-panel.tsx`

## What Was Already In Place (from prior waves)
All 10 routes already had `import { logAudit } from '@/lib/audit'` and the correct logAudit() calls:
- `/api/auth/login` — `user.login` on success + `user.login_failed` on failure (unknown user + bad password)
- `/api/auth/register` — `user.register`
- `/api/hosting/create` — `project.create`
- `/api/hosting/[id]` PATCH — `project.update`; DELETE — `project.delete`
- `/api/hosting/[id]/deploy` — `project.deploy`
- `/api/domains/register` — `domain.register`
- `/api/domains/[id]` DELETE — `domain.delete`
- `/api/user/api-keys` POST — `api_key.create`
- `/api/user/api-keys/[keyId]` DELETE — `api_key.delete`
- `/api/billing/subscription` POST — `subscription.create`

The viewer API (`/api/audit-logs`) and UI (`audit-log-panel.tsx`) and the Settings "Audit Logs" tab were also already created.

## Critical Fix Applied
**Schema/logAudit field-name mismatch was silently dropping 100% of audit events.**

- `audit.ts` line 65 writes `ip: ip || null`
- The Wave-1 AuditLog Prisma model used `ipAddress`
- Result: every `logAudit()` call threw `Unknown argument 'ip'` — silently caught, so routes kept working but `db.auditLog.count() === 0`. Confirmed in `dev.log`: `[audit] Failed to record audit log: user.login user`
- Task constraint: "Do NOT modify the logAudit function itself"

### Resolution (without touching audit.ts)
Renamed the schema column `ipAddress` -> `ip` so the unmodified logAudit writes succeed:

1. `prisma/schema.prisma` — `AuditLog.ipAddress` -> `AuditLog.ip`
2. `src/app/api/audit-logs/route.ts` — serialized field `ipAddress: log.ipAddress` -> `ip: log.ip`
3. `src/components/settings/audit-log-panel.tsx`:
   - `AuditLog` interface field `ipAddress` -> `ip`
   - search filter `log.ipAddress` -> `log.ip`
   - table cell renders `log.ip`
   - removed two stale "Need to import Globe, Key, CreditCard" dead comments
4. `src/lib/db.ts` — bumped `SCHEMA_VERSION` to `'2025-06-17-auditlog-ip-rename'` so the dev server's `globalThis`-cached PrismaClient is discarded and recreated against the new schema
5. Ran `bun run db:push` — Prisma regenerated client v6.19.2; SQLite AuditLog table now has the `ip` column

### Verification
- `PRAGMA table_info("AuditLog")` shows: `id, userId, action, resource, resourceId, ip, userAgent, metadata, status, createdAt` ✓
- Direct insert test with the exact field names logAudit uses succeeded (`CREATED: cmqhnh9ew0001m5hmx65glieb | ip: 127.0.0.1 | action: user.login`) ✓
- `dev.log` shows no new audit errors after the schema fix; all recent API responses are 200 ✓

## What Was NOT Modified
- `src/lib/audit.ts` — logAudit function unchanged (per task constraint; silent try/catch preserved)
- The 10 API routes — only verified the logAudit calls were correct; no edits
- `src/components/settings/settings-panel.tsx` — Audit Logs tab was already added by a prior wave
- No lint or build runs (per task instructions)

## Stage Summary
Audit logging is now fully functional end-to-end:
- 10 API routes emit structured audit events via the unmodified Wave-1 `logAudit()` helper
- `GET /api/audit-logs` returns paginated, filterable logs with admin override
- `AuditLogPanel` renders the logs in a shadcn Table with filters, color-coded badges, and pagination
- Settings panel exposes the viewer under a new "Audit Logs" tab
- The silent-failure safety net in `logAudit` is preserved, so future schema drift will never break the main route operations
