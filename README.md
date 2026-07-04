# Apsamo Panel

> A cPanel-style hosting control panel built with Next.js 16 — deploy WordPress,
> Laravel, Node.js, PHP, static sites, Python apps, Docker containers, or custom
> stacks; register domains via Dynadot; provision mailboxes via Mailcow; bill
> customers via Stripe or WaafiPay; and manage it all from one dashboard.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Next.js](https://img.shields.io/badge/Next.js-16-black.svg)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)](https://www.typescriptlang.org/)
[![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748.svg)](https://www.prisma.io/)

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Production Deployment](#production-deployment)
- [Project Structure](#project-structure)
- [License](#license)

---

## Features

### 16 Dashboard Tabs

| # | Tab | Description |
|---|-----|-------------|
| 1 | **Overview** | At-a-glance KPIs: projects, deployments, domains, monthly revenue, recent activity feed. |
| 2 | **Hosting** | Full website/project lifecycle: create-from-wizard, deploy, manage (files, terminal, databases, email, cron, FTP, redirects, IP-blocks, SSL, backups, env vars, domains, resources). |
| 3 | **Domains** | Domain search/register/transfer/renew via Dynadot; DNS record management; auto-renew; auth-code retrieval; propagation checker; SSL status. |
| 4 | **Deployments** | Per-deployment logs, stage breakdown, real-time streaming logs (via Socket.IO), rollback. |
| 5 | **Billing** | Plan comparison, Stripe checkout + customer portal, WaafiPay callback flow, invoice history, payment methods. |
| 6 | **Admin** | User management, server management, job queue, CMS/site content editor, payment-method settings, Dynadot domain sync. |
| 7 | **Teams** | Multi-tenant teams: create team, invite members, assign roles, scoped project access. |
| 8 | **Settings** | Profile, password, API keys, 2FA (TOTP + backup codes), audit log, theme toggle. |
| 9 | **Analytics** | Per-project event tracking, page views, visitors, referrers (privacy-friendly, in-house). |
| 10 | **Pipelines** | Multi-stage CI/CD pipelines: build → test → deploy, manual triggers, run history. |
| 11 | **Templates** | One-click starter templates (WordPress, Laravel starter, Next.js, etc.) that pre-fill the create-website wizard. |
| 12 | **Webhooks** | Outbound webhooks with HMAC signing, retry policy, delivery history. |
| 13 | **GitHub** | OAuth connect, repo/branch browser, commit history, deploy-from-git. |
| 14 | **Assistant** | In-dashboard AI assistant powered by `z-ai-web-dev-sdk` — ask about your projects, deployments, DNS, etc. |
| 15 | **Monitoring** | Uptime monitors (HTTP/TCP), per-monitor response-time charts, alerting via in-app notifications. |
| 16 | **Provisioning** | VPS provisioning jobs: provision a fresh VPS (install Docker, Caddy, Mailcow) step-by-step with rollback support. |

### 8 Deployment Methods (Create Website Wizard)

| # | Method | Stack | Notes |
|---|--------|-------|-------|
| 1 | **WordPress** | `wordpress` | One-click managed WP — auto-provisions MySQL, runs `wp core install`, generates admin password. |
| 2 | **Laravel** | `laravel` | PHP-FPM + composer + artisan. Auto-provisions MySQL/MariaDB. Supports `php:8.1/8.2/8.3` runtimes. |
| 3 | **Node.js** | `nodejs` | Node 18/20/22 + npm/pnpm/yarn. Frameworks: Next.js, Express, Fastify, NestJS, custom. |
| 4 | **PHP** | `php` | Plain PHP-FPM (no framework). Choose document root + PHP version. |
| 5 | **Static** | `static` | Static file server (HTML/CSS/JS). Frameworks: Vite, Astro, Gatsby, Hugo, plain HTML. |
| 6 | **Python** | `python` | Python 3.10/3.11/3.12 via gunicorn/uvicorn. Frameworks: Django, Flask, FastAPI. |
| 7 | **Docker** | `docker` | Bring-your-own Dockerfile. Build + run as a container. |
| 8 | **Custom** | `custom` | Escape hatch — define your own build/start commands. |

### 6 cPanel-Style Features (per project)

| # | Feature | Implementation |
|---|---------|----------------|
| 1 | **Databases** | MySQL, MariaDB, PostgreSQL (Docker containers on remote VPS) — OR real SQLite files (`better-sqlite3`) on localhost/sandbox servers. Create / list / delete / view credentials. |
| 2 | **Email** | Mailcow API integration: add domain, generate DKIM, create mailboxes, fetch DNS records (MX/SPF/DKIM/DMARC) with auto-fetched DKIM public key. |
| 3 | **Cron Jobs** | Real `node-cron` scheduler running in-process. Localhost servers run commands directly via `child_process`; remote VPS sync to the container's crontab via `docker cp`. |
| 4 | **FTP Accounts** | FTP account CRUD with chroot isolation. Localhost servers create OS users via `useradd`; remote VPS creates them inside the container. |
| 5 | **Redirects** | Two-layer enforcement: (1) Next.js proxy (middleware) checks DB-cached redirect rules in real-time; (2) Caddyfile generation injects `redir` directives for production with real Caddy. |
| 6 | **IP Blocker** | Same two-layer architecture as redirects: proxy enforces allow/deny + CIDR rules in real-time; Caddyfile generation injects `@blocked { client_ip ... }` matchers for production. |

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| **Framework** | [Next.js 16](https://nextjs.org/) (App Router, Turbopack) |
| **Language** | [TypeScript 5](https://www.typescriptlang.org/) (strict) |
| **Styling** | [Tailwind CSS 4](https://tailwindcss.com/) + [shadcn/ui](https://ui.shadcn.com/) (New York style) |
| **Database ORM** | [Prisma](https://www.prisma.io/) (SQLite client) + Prisma Client |
| **Local DBs** | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — real on-disk SQLite files for localhost servers |
| **State (client)** | [Zustand](https://zustand-demo.pmnd.rs/) for UI state |
| **State (server)** | [TanStack Query](https://tanstack.com/query/latest) for server cache |
| **Reverse proxy** | [Caddy v2](https://caddyserver.com/) — auto-HTTPS via Let's Encrypt, per-project site blocks |
| **Containers** | [Docker](https://www.docker.com/) — per-project containers on remote VPS hosts |
| **Real scheduler** | [node-cron](https://github.com/node-cron/node-cron) — in-process cron scheduler |
| **SSH client** | [ssh2](https://github.com/mscdex/ssh2) — remote VPS management (exec, sftp, docker) |
| **Billing** | [Stripe](https://stripe.com/) (cards) + [WaafiPay](https://www.waafipay.net/) (alternative) |
| **Domain registrar** | [Dynadot](https://www.dynadot.com/) API — register/transfer/renew |
| **Email hosting** | [Mailcow](https://mailcow.email/) — mailbox provisioning + DKIM key retrieval |
| **Realtime** | [Socket.IO](https://socket.io/) — deployment log streaming + terminal |
| **Auth** | JWT (`jsonwebtoken`) + bcrypt + TOTP 2FA (`otplib`) |
| **AI assistant** | `z-ai-web-dev-sdk` (server-side only) |
| **Validation** | [Zod](https://zod.dev/) |
| **Notifications** | `sonner` toasts + in-app notification center |

---

## Architecture

### Dual Execution Model — LocalClient vs SSH

Apsamo Panel talks to "servers" via a single `withConnection(creds, callback)` API
in `src/lib/vps/ssh.ts`. Internally, the connection is routed to one of two
implementations based on the server's `sshHost`:

```
                       ┌──────────────────────────┐
                       │   withConnection(creds)   │
                       └──────────┬───────────────┘
                                  │
                  ┌───────────────┴────────────────┐
                  │                                 │
        sshHost === 'localhost'           sshHost === '<vps-ip>'
                  │                                 │
                  ▼                                 ▼
        ┌─────────────────┐               ┌─────────────────┐
        │  LocalClient    │               │  ssh2 Client    │
        │  (child_process │               │  (real SSH to   │
        │   bash -lc ...) │               │   remote VPS)   │
        └─────────────────┘               └─────────────────┘
                  │                                 │
                  ▼                                 ▼
        Runs commands on the            Runs commands in Docker
        panel host itself (sandbox      containers on the VPS
        / dev / single-box prod)        (production multi-tenant)
```

- **`LocalClient`** (`src/lib/vps/local-exec.ts`) — wraps `child_process.exec`
  and `fs`/`path` for the panel host itself. Used when the DB `Server.sshHost === 'localhost'`.
  This is the sandbox/dev path and ALSO the single-box production path. Files,
  terminal, backups, cron — all run for real against the panel host's filesystem.
- **`ssh2` Client** — opens a real SSH connection to a remote VPS. Used when
  `Server.sshHost` is an IP/hostname. All operations (deploy, file manage,
  terminal, backups, cron, database, proxy) are run inside Docker containers on
  that VPS via `docker exec`.

Both paths go through the SAME `withConnection` callback, so callers don't need
to know which one is active.

### Graceful Fallbacks (no Docker required)

| Feature | Remote VPS (with Docker) | Localhost / sandbox (no Docker) |
|---------|--------------------------|----------------------------------|
| **Databases** | MySQL/MariaDB/PostgreSQL containers | Real SQLite files via `better-sqlite3` (stored under `STORAGE_ROOT/databases/`) |
| **Cron jobs** | Container crontab (`/var/spool/cron/crontabs/root`) synced via `docker cp` | In-process `node-cron` scheduler (runs commands via `child_process`) |
| **Redirects** | Caddyfile `redir` directives + Next.js proxy | Next.js proxy only (Caddyfile write is best-effort no-op) |
| **IP blocks** | Caddyfile `@blocked { client_ip ... }` + Next.js proxy | Next.js proxy only |
| **Files/Terminal/Backups** | SSH + `docker exec` + `docker cp` | Local `bash -lc` + `fs` operations |

The Next.js proxy (`src/proxy.ts`) is the FAST PATH for redirects + IP-blocks:
it queries the DB for active rules (cached 10s in-memory), matches the request
Host against project `customDomain`/`subdomain`, and either returns a 301/302
redirect or a 403 Forbidden — all without ever touching Caddy.

The Caddyfile generator (`src/lib/vps/proxy.ts:generateCaddyBlock`) is the
PRODUCTION source of truth: when a real VPS + Caddy is configured, redirects
become `redir <from> <to> <code>` directives and IP-blocks become
`@blocked { client_ip <ips...> }` + `respond @blocked 403` matchers, both
placed BEFORE the `reverse_proxy` directive so they short-circuit.

### Realtime (Socket.IO)

Deployment log streaming + terminal output use a separate mini-service
(`mini-services/realtime-service/`) running on port 3003. The frontend
connects via `io("/?XTransformPort=3003")` — the Caddyfile gateway routes
the request to the correct port based on the `XTransformPort` query param.

---

## Quick Start

```bash
# 1. Install dependencies
bun install

# 2. Copy env template + fill in real values
cp .env.example .env
# (edit .env — at minimum set JWT_SECRET and ENCRYPTION_KEY)

# 3. Push the Prisma schema to create the SQLite DB
bun run db:push

# 4. Start the dev server (port 3000)
bun run dev
```

Open the **Preview Panel** on the right side of the interface (or click
**"Open in New Tab"**) to view the app. The dev server logs to `dev.log`.

> **Note:** This project runs in a restricted cloud sandbox. Do NOT visit
> `http://localhost:3000` directly — use the Preview Panel.

### Useful Scripts

| Script | Description |
|--------|-------------|
| `bun run dev` | Start Next.js dev server on port 3000 (auto-runs `predev` to restore Dynadot keys). |
| `bun run lint` | Run ESLint to check code quality. |
| `bun run db:push` | Push the Prisma schema to the SQLite DB (creates tables). |
| `bun run db:generate` | Regenerate the Prisma Client after schema changes. |
| `bun run db:migrate` | Create + apply a Prisma migration (dev). |
| `bun run db:reset` | Drop + recreate the DB (destructive!). |
| `bun run build` | Production build (outputs `.next/standalone`). |
| `bun run start` | Start the production server (after `build`). |

---

## Environment Variables

See [`.env.example`](.env.example) for the complete list with descriptions.
Key variables (all `[REQUIRED]` unless marked `[OPTIONAL]`):

### Database
| Var | Description |
|-----|-------------|
| `DATABASE_URL` | SQLite file path (e.g. `file:./db/custom.db`). |

### Auth / Encryption
| Var | Description |
|-----|-------------|
| `JWT_SECRET` | Signs JWTs. Generate with `openssl rand -base64 32`. |
| `ENCRYPTION_KEY` | 64-char hex string for at-rest AES-256-GCM. `openssl rand -hex 32`. |
| `NEXTAUTH_URL` / `NEXTAUTH_SECRET` | Legacy NextAuth.js config (currently unused by main auth flow). |

### Branding
| Var | Description |
|-----|-------------|
| `APP_URL` / `NEXT_PUBLIC_APP_URL` | Public app URL (used for email links + OAuth callbacks). |
| `BRAND_DOMAIN` | Apex domain (default `apsamo.io`). Used to derive other defaults. |
| `MAIL_SERVER_HOSTNAME` | MX target + SMTP/IMAP host. Default `mail.${BRAND_DOMAIN}`. |
| `NS1_HOSTNAME` / `NS2_HOSTNAME` | Nameserver hostnames advertised in WHOIS. |
| `NO_REPLY_EMAIL` / `SUPPORT_EMAIL` / `BILLING_EMAIL` / `ADMIN_EMAIL` | System mailbox addresses. |

### Domains / Dynadot
| Var | Description |
|-----|-------------|
| `DYNADOT_API_KEY` | Dynadot API key (auto-restored by `predev` script). |
| `DYNADOT_SECRET_KEY` | Dynadot secret key (auto-restored by `predev` script). |

### Billing / Stripe
| Var | Description |
|-----|-------------|
| `STRIPE_SECRET_KEY` | Stripe API secret (`sk_live_...` or `sk_test_...`). |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signing secret (`whsec_...`). |
| `STRIPE_PRICE_ID_DEFAULT` | Default Stripe Price ID for new subscriptions. |

### Email / Mailcow / SMTP
| Var | Description |
|-----|-------------|
| `MAILCOW_API_URL` | Base URL of your Mailcow instance. |
| `MAILCOW_API_KEY` | Mailcow API token (admin → Configuration → Access → API). |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Transactional email SMTP. Note: code reads `SMTP_PASS`, not `SMTP_PASSWORD`. |
| `SMTP_FROM_NAME` / `SMTP_FROM_EMAIL` | Display name + sender address for outgoing mail. |
| `LE_EMAIL` | Let's Encrypt account email (used by Caddy for ACME). |

### GitHub OAuth
| Var | Description |
|-----|-------------|
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret. Callback URL: `${NEXT_PUBLIC_APP_URL}/api/github/oauth/callback`. |

### WaafiPay (alternative payment)
| Var | Description |
|-----|-------------|
| `WAAFI_API_URL` / `WAAFI_MERCHANT_ID` / `WAAFI_API_KEY` / `WAAFI_API_USER_ID` | WaafiPay credentials. |

### VPS / Storage / Cron
| Var | Description |
|-----|-------------|
| `STORAGE_ROOT` | Root dir for localhost-mode project files, backups, SQLite DBs. Default `<cwd>/storage`. |
| `VPS_DEMO_MODE` | Force demo mode for ALL servers (`"1"` or `"true"`). |
| `CRON_API_KEY` | Shared secret for `/api/monitors/run` + `/api/admin/jobs/process`. |

---

## Production Deployment

Apsamo Panel is designed for a **single-box production deployment** where the
panel itself runs on the same VPS as the projects it manages (localhost server)
OR for a **split deployment** where the panel runs on one box and manages
projects on remote VPS hosts via SSH.

### Option A — Single-box (panel + projects on the same VPS)

1. **Provision a VPS** (Ubuntu 22.04+, 2 vCPU / 4 GB RAM minimum).

2. **Install Docker + Caddy + Mailcow** on the VPS:
   ```bash
   # Docker
   curl -fsSL https://get.docker.com | sh
   sudo systemctl enable --now docker

   # Caddy
   sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
   curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
   sudo apt update && sudo apt install -y caddy
   sudo systemctl enable --now caddy

   # Mailcow (follow https://docs.mailcow.email/)
   git clone https://github.com/mailcow/mailcow-dockerized /opt/mailcow
   cd /opt/mailcow && ./generate_config.sh && docker compose up -d
   ```

3. **Clone + build Apsamo Panel**:
   ```bash
   git clone <your-fork> /opt/apsamo
   cd /opt/apsamo
   bun install                                          # NOT --production: the build needs devDependencies
   ( cd mini-services/realtime-service && bun install ) # realtime service has its own deps (socket.io)
   cp .env.example .env
   # Edit .env: set DATABASE_URL, JWT_SECRET, ENCRYPTION_KEY,
   # BRAND_DOMAIN, MAIL_SERVER_HOSTNAME, MAILCOW_API_URL, MAILCOW_API_KEY,
   # DYNADOT_API_KEY, STRIPE_SECRET_KEY, etc.
   bun run db:push
   bun run build
   ```

4. **Set the DB server to localhost**: in the admin panel, create a Server
   row with `sshHost='localhost'`. All projects on this server will run via
   `LocalClient` (direct child_process + fs).

5. **Configure DNS**: point your apex domain + `www` + `mail` + `ns1` + `ns2`
   A-records at the VPS IP. Update the Caddyfile (`/etc/caddy/Caddyfile`) to
   reverse-proxy the panel on port 3000 with auto-HTTPS.

6. **Start the panel** (use `systemd` or `pm2`):
   ```bash
   NODE_ENV=production node .next/standalone/server.js
   ```

### Option B — Split (panel on one box, projects on remote VPS hosts)

1. Provision the panel box (steps 1–3 above, but skip Mailcow if you host
   mail elsewhere).

2. For each project VPS: install Docker + Caddy, add the VPS's IP + SSH
   credentials to Apsamo Panel via the **Admin → Servers** tab.

3. Set the project's `serverId` to the remote server. The panel will SSH
   into the VPS and run all operations (deploy, file manage, terminal,
   backups, cron, database, proxy) inside Docker containers on that VPS.

### SSL / HTTPS

Caddy auto-provisions Let's Encrypt certs for any hostname routed through it.
Set `LE_EMAIL` to your admin email so Let's Encrypt can send you expiry
warnings. The `src/lib/vps/proxy.ts:configureProjectProxy` function
regenerates the full Caddyfile (all running projects) and atomically swaps
it in via `putFile` + `mv` + `caddy validate` + `systemctl reload caddy`.

---

## Project Structure

```
apsamo-panel/
├── prisma/
│   └── schema.prisma              # 50+ Prisma models (User, Project, Domain, ...)
├── db/
│   └── custom.db                  # SQLite database (created by `bun run db:push`)
├── storage/                       # Localhost-mode storage (STORAGE_ROOT)
│   ├── projects/<projectId>/      # Project files (file manager + terminal cwd)
│   ├── backups/<projectId>/       # Backup tarballs + SQLite siblings
│   └── databases/<projectId>/     # Live SQLite files (externalRef)
├── mini-services/
│   └── realtime-service/          # Socket.IO service (port 3003)
├── scripts/
│   └── ensure-dynadot-env.ts      # predev hook — restores Dynadot keys
├── src/
│   ├── app/
│   │   ├── page.tsx               # Landing page (the only user-visible route)
│   │   ├── layout.tsx             # Root layout (providers, theme, fonts)
│   │   └── api/                   # 100+ API routes (auth, hosting, domains,
│   │                              # billing, deployments, admin, github, ...)
│   ├── lib/
│   │   ├── auth.ts                # JWT sign/verify + middleware helper
│   │   ├── db.ts                  # Prisma client singleton
│   │   ├── encryption.ts          # AES-256-GCM at-rest encryption
│   │   ├── email-dns.ts           # MX/SPF/DKIM/DMARC record generation
│   │   ├── mailcow.ts             # Mailcow API client (DKIM, mailboxes, ...)
│   │   ├── dynadot.ts             # Dynadot registrar API client
│   │   ├── stripe.ts              # Stripe billing (checkout, portal, webhooks)
│   │   ├── waafi.ts               # WaafiPay alternative payment client
│   │   ├── github.ts              # GitHub OAuth + repo/branch browser
│   │   ├── brand-config.ts        # Env-driven brand/DNS/email defaults
│   │   ├── deployment-methods.ts  # The 8 deployment methods catalog
│   │   └── vps/                   # VPS orchestration layer
│   │       ├── ssh.ts             # withConnection — routes to LocalClient or ssh2
│   │       ├── local-exec.ts      # LocalClient (child_process) for localhost
│   │       ├── deployer.ts        # Per-stack Dockerfile + build pipeline
│   │       ├── database.ts        # MySQL/MariaDB/Postgres containers OR SQLite
│   │       ├── files.ts           # File manager (path-traversal-safe)
│   │       ├── terminal.ts        # Interactive terminal sessions
│   │       ├── backups.ts         # Tar + SQLite-file backups + restore
│   │       ├── cron.ts            # node-cron scheduler + container crontab sync
│   │       ├── ftp.ts             # FTP account CRUD
│   │       ├── redirects.ts       # Redirect rules (proxy + Caddyfile)
│   │       ├── security.ts        # IP-block rules (proxy + Caddyfile)
│   │       ├── proxy.ts           # Caddyfile generation + atomic reload
│   │       ├── ssl.ts             # SSL cert status
│   │       ├── resources.ts       # CPU/RAM/disk usage
│   │       └── provisioner.ts     # VPS provisioning (install Docker, Caddy, etc.)
│   ├── components/
│   │   ├── ui/                    # shadcn/ui components (60+)
│   │   ├── hosting/               # Hosting panel + wizard + management tabs
│   │   ├── dashboard/             # Overview + dashboard layout
│   │   ├── landing/               # Public marketing site (home, pricing, etc.)
│   │   ├── admin/                 # Admin panel sub-tabs
│   │   └── ...                    # All other tab panels (16 total)
│   ├── hooks/                     # React hooks (toast, mobile detection)
│   ├── store/                     # Zustand stores (auth-store, app-store)
│   └── proxy.ts                   # Next.js 16 proxy (was middleware.ts)
├── Caddyfile                      # Gateway reverse proxy config
├── package.json                   # Bun-managed deps + scripts
└── .env.example                   # Complete env-var template
```

---

## License

MIT © Apsamo Technology. See [LICENSE](LICENSE) for details.
