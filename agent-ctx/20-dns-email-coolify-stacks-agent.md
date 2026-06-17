# Task 20 — DNS Email Helper + Coolify Multi-Stack Agent

**Task ID:** 20
**Agent:** DNS Email + Coolify Stacks Agent
**Task:** Add email DNS record helpers + multi-stack Coolify support

## Files read first

- `/home/z/my-project/worklog.md` (last 100 lines) — to understand what tasks 16/17/18 produced (Mailcow client, Prisma schema with `Project.stack`, multi-payment billing).
- `/home/z/my-project/src/lib/dns.ts` — existing DNS resolution utilities (TXT/A/MX lookups + propagation checker). Used as the resolver that feeds `validateDnsRecords`.
- `/home/z/my-project/src/lib/coolify.ts` — existing Coolify client (DEMO MODE pattern, `coolifyFetch` helper, `createApplication`, `deployApplication`, `listServers`, etc.). I appended to this file rather than rewriting.
- `/home/z/my-project/src/lib/mailcow.ts` — Mailcow client. Used as the reference for the DKIM key format Mailcow returns (the demo-mode fake key emits `v=DKIM1; k=rsa; t=s; s=email; p=<base64>`, which `formatDkimTxtValue` accepts as-is).

## Changes

### 1. Created `/home/z/my-project/src/lib/email-dns.ts` (new, ~415 lines)

Pure, side-effect-free module that produces standard email + hosting DNS records.

**Exported types:**
- `MxRecord`, `TxtRecord`, `EmailDnsRecords`, `HostingRecord`, `DnsRecord`
- `ValidationResult`

**Exported functions:**

| Function | Purpose |
|---|---|
| `generateEmailDnsRecords(domain, mailServerHostname, dkimPublicKey?, dkimSelector='mail', serverIp?)` | Produces the 4 email records: MX (`@` → mailServerHostname, prio 10), SPF (`v=spf1 mx a [ip4:...] -all`), DMARC (`_dmarc` → `v=DMARC1; p=quarantine; rua=mailto:admin@…; ruf=mailto:admin@…; fo=1`), DKIM (`{selector}._domainkey` → `v=DKIM1; k=rsa; t=s; s=email; p=<key>`). `dkimPublicKey` may be either a bare base64 blob OR the full `v=DKIM1;…` string (both forms are normalised — see `formatDkimTxtValue`). When `serverIp` is supplied, the SPF includes the explicit `ip4:` mechanism (spec-required); otherwise it falls back to `v=spf1 mx a -all`. |
| `generateHostingDnsRecords(domain, serverIp)` | Returns the 3 hosting A records: `@`/`www`/`mail` → serverIp. Names are relative (`@`, `www`, `mail`) for direct paste into DNS UIs. |
| `generateAllDnsRecords(opts)` | Combines hosting + email into a single `DnsRecord[]` (A records → MX → SPF → DMARC → DKIM). DKIM is omitted from the array when no public key is supplied. |
| `validateDnsRecords(records, domain, expected?)` | Cross-references a list of resolved DNS records (typically from `getDnsRecords` in `dns.ts`) against the expected set. Returns `{ valid, missing[], present[] }`. TXT records are compared by `v=` tag only (spf1/dkim1/dmarc1) so cosmetic differences (trailing `;`, spaces) don't break validation. A records with a blank expected value match on type+name only — useful when the server IP isn't known ahead of time. |

**Internal helpers:** `formatDkimTxtValue`, `stripTrailingDot`, `normaliseName`, `normaliseValue`.

### 2. Updated `/home/z/my-project/src/lib/coolify.ts` (appended, no existing code touched)

Added a "Multi-stack application support (#20)" section after the existing `getServer` function.

**New exports:**

| Export | Purpose |
|---|---|
| `STACK_DEFINITIONS` | `as const` map of `nodejs`/`php`/`python`/`docker`/`wordpress` → `{ name, dockerfile, buildCommand, startCommand, port, healthCheck }`. `docker` has `dockerfile: null` (uses repo's Dockerfile). The Dockerfiles match the task spec verbatim (Node 20-alpine, PHP 8.2-apache, Python 3.11-slim + gunicorn, WordPress 6.4-php8.2-apache). |
| `StackType` | `keyof typeof STACK_DEFINITIONS` — `'nodejs' \| 'php' \| 'python' \| 'docker' \| 'wordpress'`. |
| `getStackDefinition(stack)` | Returns the definition for a stack id, or `null` if unknown. |
| `listStacks()` | Returns `[{ id, name, description, icon }]` for the stack picker UI. Each description is 1-2 sentences of guidance; `icon` is a Lucide icon name. |
| `createStackApplication(opts)` | The main entry point. |

**`createStackApplication` behaviour:**

- **DEMO MODE** (no `COOLIFY_API_URL`/`COOLIFY_API_TOKEN`): logs `[coolify] DEMO MODE: createStackApplication …` and returns `{ id: 'demo-app-<ts>', url, demoMode: true, databaseId? }`. For WordPress it also logs that a MySQL DB *would* be provisioned and surfaces a fake `databaseId` (`demo-db-<ts>`) so UIs can show the dependency. If `opts.domain` is supplied it logs that the domain + Let's Encrypt SSL *would* be configured, and uses `https://{domain}` as the URL.

- **REAL MODE**: 
  1. Resolves a Coolify server (`opts.serverId` or first available via `listServers()`).
  2. POSTs to `/applications` with `{ name, server_uuid, project_uuid, environment_name: 'production', git_repository, git_branch, build_pack }` where `build_pack` is `dockercompose` for the `docker` stack and `dockerfile` for everything else.
  3. PATCHes the application with the stack's Dockerfile (skipped for `docker`) + `ports_exposes`. Failures here are logged but non-fatal (some Coolify versions don't expose this PATCH shape; the repo's own Dockerfile may still work).
  4. If `opts.domain` is set, PATCHes the application's `domains` field and best-effort POSTs to `/applications/{id}/ssl` with `{ type: 'letsencrypt' }`.
  5. For WordPress: POSTs to `/databases` to provision a `mysql:8.0` DB, then wires `WORDPRESS_DB_HOST/NAME/USER/PASSWORD` env vars into the application via `/applications/{id}/envs`. Returns the database UUID.
  6. Triggers an initial deployment via the existing `deployApplication(appId)`.
  7. Returns `{ id, url, demoMode: false, databaseId? }`. The URL is `https://{domain}` when supplied, otherwise whatever `getApplicationStatus(appId)` reports back.

Every external call in real mode is wrapped in `try/catch` — a partial failure (e.g. Dockerfile PATCH not supported on older Coolify) is logged via `console.warn` but doesn't abort provisioning.

## Notes

- **Backward compatibility:** `createApplication`, `deployApplication`, `getApplicationStatus`, `deleteApplication`, `getDeploymentLogs`, `listServers`, `getServer`, `frameworkToBuildPack`, `coolifyFetch`, `getConfig`, `isCoolifyDemoMode` — all unchanged. Existing callers (e.g. the billing success flow that creates a project/domain/deployment) keep working.
- **Pure module:** `email-dns.ts` imports nothing — no `dns`, no `crypto`, no env. Safe to call from any context.
- **DKIM key flexibility:** `formatDkimTxtValue` handles both the bare base64 form (what a UI would paste from Mailcow's `/get/dkim/{domain}` `public` field) and the pre-formatted form (what `mailcow.ts` demo-mode `fakeDkimPublicKey()` produces). This means a future email panel can pipe Mailcow's DKIM output straight into `generateEmailDnsRecords` without preprocessing.
- **Validation tolerance:** `validateDnsRecords` doesn't insist on exact TXT-string equality — only the `v=` tag is compared. This matches how DNS providers actually format records (extra spaces, trailing semicolons, line-wrapped base64) and avoids false negatives in the "DNS checklist" UI.

## Not done (per task spec)

- Did NOT run `bun run lint` or `bun run build` (per instructions).
- Did NOT add any new API routes, UI components, or Prisma migrations — this task was lib-only.
- Did NOT modify `src/lib/dns.ts` or `src/lib/mailcow.ts` — only read them for reference.
