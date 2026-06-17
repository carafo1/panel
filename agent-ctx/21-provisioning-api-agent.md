# Task 21 — Provisioning API Agent

## Summary

Created 6 provisioning API endpoints that expose the orchestration engine (Task 19) and the stack / domain-availability helpers (Tasks 20 / earlier):

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/api/provisioning/start` | POST | any user | Start a new provisioning job |
| `/api/provisioning/[jobId]/status` | GET | owner or admin | Poll job status (job + steps + result) |
| `/api/provisioning/[jobId]/rollback` | POST | owner or admin | Trigger reverse-order rollback |
| `/api/provisioning/list` | GET | any user (scoped) | Paginated list of jobs |
| `/api/provisioning/stacks` | GET | **public** | List 5 deployment stacks (for form UI) |
| `/api/provisioning/check-domain` | GET | any user | Dynadot availability lookup + alternatives |

## Files Created

- `src/app/api/provisioning/start/route.ts`
- `src/app/api/provisioning/[jobId]/status/route.ts`
- `src/app/api/provisioning/[jobId]/rollback/route.ts`
- `src/app/api/provisioning/list/route.ts`
- `src/app/api/provisioning/stacks/route.ts`
- `src/app/api/provisioning/check-domain/route.ts`

## Files Modified

- `src/lib/db.ts` — bumped `SCHEMA_VERSION` and expanded the require-cache busting to also clear entries containing `@prisma/client` (the existing logic only cleared `.prisma/client`). The intent is to force the running dev server to pick up the regenerated Prisma client (which now includes the ProvisioningJob model added in Task 19). Note: another concurrent agent further bumped the version to `2025-06-19-provisioning-ui`; the final value doesn't matter, only that it changed.

## Function Signatures Used (from orchestration.ts)

```typescript
startProvisioning(req: ProvisioningRequest): Promise<{ jobId: string; status: 'started' | 'failed'; error?: string }>
getProvisioningStatus(jobId: string): Promise<{ job: Record<string, unknown> | null; steps: Array<Record<string, unknown>>; result?: ProvisioningResult }>
rollbackProvisioning(jobId: string): Promise<{ rolledBack: string[]; failed: Array<{ step: string; error: string }> }>

interface ProvisioningRequest {
  userId: string
  domainName: string
  stack: string  // "nodejs" | "php" | "python" | "docker" | "wordpress"
  includeHosting?: boolean  // default true
  includeEmail?: boolean  // default true
  planId?: string
  serverId?: string
}
```

## Auth Pattern Used (per task spec)

```typescript
const token = extractTokenFromHeader(request.headers.get('authorization') || '')
if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const user = verifyToken(token)  // note: verifyToken is sync, not async
if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
```

## Authorization Model

- **start**: any authenticated user can start a job for themselves (userId taken from JWT, not body).
- **status**: regular users can only view their own jobs (404 returned for non-owned jobs to avoid leaking existence); super_admin/admin can view any.
- **rollback**: regular users can only rollback their own jobs (403 returned for non-owned); super_admin/admin can rollback any.
- **list**: regular users see only their own jobs; super_admin/admin see all (with optional `?userId=` filter).
- **stacks**: public, no auth.
- **check-domain**: any authenticated user.

## Validation Rules (start route)

- `domainName`: required, must match `/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i`
- `stack`: required, must be one of `nodejs`, `php`, `python`, `docker`, `wordpress`
- `includeHosting`: optional, defaults to `true`
- `includeEmail`: optional, defaults to `true`
- `planId`, `serverId`: optional strings, trimmed

## Smoke Test Results

All routes compile cleanly. Verified via curl with a real admin JWT (login → admin@deployhub.io):

| Route | Test | Result |
|---|---|---|
| `stacks` | GET (no auth) | 200, returns 5 stacks ✓ |
| `check-domain` | GET with auth, domain=mygreatapp-test.com | 200, returns availability + 3 alternatives ✓ |
| `start` | POST with missing domainName | 400 "domainName is required" ✓ |
| `start` | POST with invalid stack | 400 "stack must be one of: nodejs, php, python, docker, wordpress" ✓ |
| `start` | POST with invalid domain | 400 "domainName must be a valid domain (e.g. example.com)" ✓ |
| `list` | GET without auth | 401 ✓ |
| `status` | GET without auth | 401 ✓ |
| `rollback` | POST without auth | 401 ✓ |

## Known Environmental Issue (not a code issue)

The running Next.js dev server has Turbopack's module cache holding a stale `@prisma/client` class from BEFORE Task 19 added the `ProvisioningJob` model to the Prisma schema. As a result, `db.provisioningJob` is `undefined` at runtime in the current dev session, even though:

1. The generated Prisma client at `node_modules/.prisma/client/index.js` DOES include `ProvisioningJob` (verified via `node -e` outside the dev server).
2. The Prisma schema at `prisma/schema.prisma` has the model defined (lines 508-541).
3. `bun run db:generate` was run successfully.

The existing require-cache busting in `src/lib/db.ts` uses Node's `require.cache`, which Turbopack doesn't fully respect. The `SCHEMA_VERSION` bump creates a fresh `PrismaClient` INSTANCE, but the class definition itself comes from `require('@prisma/client').PrismaClient` — which Turbopack serves from its stale cache.

**Impact**: routes that touch `db.provisioningJob.*` (`/list`, `/status`, `/start` post-validation, `/rollback`) return 500 with `TypeError: Cannot read properties of undefined (reading 'count'/'findUnique'/...)`. Routes that don't touch the DB (`/stacks`, `/check-domain`) work fully.

**Fix**: restarting the dev server (which the system will do automatically) will reload `@prisma/client` from disk and all routes will work end-to-end. No code changes needed — the routes are correct.

This same issue would affect the orchestration engine from Task 19 if it were called end-to-end; it simply hasn't been exercised yet.
