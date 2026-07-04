# Apsamo Panel — Installation Guide

> A cPanel-style hosting control panel. Install on a fresh Ubuntu/Debian VPS
> and you get: domain registration (Dynadot), website deployment (Docker),
> email hosting (Mailcow), billing (Stripe/WaafiPay), DNS management, SSL,
> cron, file management, terminal, and 16 dashboard tabs.

---

## System Requirements

| Resource  | Minimum          | Recommended       |
|-----------|------------------|-------------------|
| OS        | Ubuntu 22.04 LTS / Debian 12 | Ubuntu 24.04 LTS |
| CPU       | 2 vCPU           | 4 vCPU            |
| RAM       | 4 GB             | 8 GB              |
| Disk      | 40 GB SSD        | 100 GB SSD        |
| Network   | Public IPv4 + open ports 22, 80, 443 | Same |
| Access    | Root (or sudo)   | Root              |

If you also want **Mailcow** (email hosting) on the same box: bump RAM to **8 GB minimum** (Mailcow runs ~6 containers).

---

## Quick Start — One-Command Install

SSH into your VPS as root and run:

```bash
# If you have the panel source locally (e.g. cloned from GitHub):
bash deploy/install.sh

# Or, download + run in one line:
curl -fsSL https://your-repo.example.com/install.sh | bash
```

The installer is **interactive** — it asks for:

1. **Brand domain** (e.g. `apsamo.com`) — must already point to your server's IP via DNS A record
2. **Admin email** (e.g. `admin@apsamo.com`)
3. **Admin password** (min 8 chars; will be hidden)
4. **Install Mailcow?** (y/N)
5. Optional: Dynadot API key, Stripe key, SMTP credentials (you can skip and configure later)

The installer handles the rest: installs Docker, Caddy, Bun, Node, sets up `.env`, builds the panel, seeds the database, creates the admin user, installs systemd services, configures the firewall, and starts everything.

**Total install time:** ~10 minutes (without Mailcow), ~25 minutes (with Mailcow).

---

## Step-by-Step Manual Installation

If you prefer to control each step yourself, follow this guide.

### Step 1 — Provision the VPS

Spin up a fresh Ubuntu 22.04+ VPS at your preferred provider (Hetzner, DigitalOcean, Vultr, Netcup, AWS, etc.). Make sure:

- You have root access via SSH
- The server has a public IPv4 address
- Ports 22, 80, 443 are open in your provider's firewall

### Step 2 — Set up DNS

At your domain registrar, create these A records pointing to your server IP:

| Type | Host             | Value            |
|------|------------------|------------------|
| A    | `@` (apex)       | `your.server.ip` |
| A    | `www`            | `your.server.ip` |
| A    | `ns1`            | `your.server.ip` |
| A    | `ns2`            | `your.server.ip` |

If installing Mailcow:
| A    | `mail`          | `your.server.ip` |
| MX   | `@`             | `mail.yourdomain.com` (priority 10) |

Wait 5-10 minutes for DNS to propagate before continuing — Let's Encrypt will fail if DNS doesn't resolve.

### Step 3 — SSH in and update the OS

```bash
ssh root@your.server.ip
apt update && apt upgrade -y
```

### Step 4 — Install Docker

```bash
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker
```

Verify:
```bash
docker --version
docker run --rm hello-world
```

### Step 5 — Install Caddy (auto-HTTPS)

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
systemctl enable --now caddy
```

### Step 6 — Install Bun + Node

```bash
# Bun (Next.js runtime + package manager)
curl -fsSL https://bun.sh/install | bash
ln -sf ~/.bun/bin/bun /usr/local/bin/bun

# Node 22 (for native Next.js deps)
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

### Step 7 — Clone the panel

```bash
git clone https://github.com/carafo1/panel.git /opt/apsamo
cd /opt/apsamo
```

### Step 8 — Configure `.env`

```bash
cp .env.example .env
```

Generate strong secrets:
```bash
echo "JWT_SECRET=$(openssl rand -base64 32)"
echo "ENCRYPTION_KEY=$(openssl rand -hex 32)"
echo "NEXTAUTH_SECRET=$(openssl rand -base64 32)"
echo "CRON_API_KEY=$(openssl rand -hex 32)"
```

Edit `.env` and set at minimum:
```bash
DATABASE_URL="file:/opt/apsamo/db/custom.db"
JWT_SECRET="<from above>"
ENCRYPTION_KEY="<from above>"
CRON_API_KEY="<from above>"
BRAND_DOMAIN="yourdomain.com"
APP_URL="https://yourdomain.com"
NEXT_PUBLIC_APP_URL="https://yourdomain.com"
ADMIN_EMAIL="admin@yourdomain.com"
DYNADOT_API_KEY="<your Dynadot key>"
DYNADOT_SECRET_KEY="<your Dynadot secret>"
STORAGE_ROOT="/opt/apsamo/storage"
```

Set permissions: `chmod 600 .env`

### Step 9 — Install dependencies

```bash
# Do NOT use --production — the build needs devDependencies (typescript,
# tailwindcss, eslint-config-next, ...). Also install the realtime
# mini-service's own deps (socket.io) so apsamo-realtime can start.
bun install
( cd mini-services/realtime-service && bun install )
```

### Step 10 — Initialize the database + build

```bash
mkdir -p db storage logs
bun run db:push          # creates tables AND generates the Prisma client
bun run build            # must come AFTER db:push — the build imports the client
bun run scripts/run-seed.ts
bun run scripts/seed-templates-and-payment.ts
```

### Step 11 — Create the admin user

```bash
bun -e "
const { db } = require('./src/lib/db');
const bcrypt = require('bcryptjs');
(async () => {
  const hashed = await bcrypt.hash('YOUR_STRONG_PASSWORD', 12);
  await db.user.create({
    data: {
      email: 'admin@yourdomain.com',
      name: 'Administrator',
      password: hashed,
      role: 'super_admin',
      emailVerified: true,
    },
  });
  console.log('Admin created');
  process.exit(0);
})();
"
```

### Step 12 — Install systemd services

```bash
cp deploy/systemd/apsamo-panel.service   /etc/systemd/system/
cp deploy/systemd/apsamo-realtime.service /etc/systemd/system/
cp deploy/systemd/apsamo-worker.service   /etc/systemd/system/

# Substitute install dir
sed -i 's|__INSTALL_DIR__|/opt/apsamo|g' /etc/systemd/system/apsamo-*.service

systemctl daemon-reload
systemctl enable --now apsamo-realtime apsamo-worker apsamo-panel
```

### Step 13 — Configure Caddy

```bash
cp deploy/caddy/Caddyfile.prod /etc/caddy/Caddyfile
sed -i 's/YOUR_DOMAIN/yourdomain.com/g' /etc/caddy/Caddyfile
sed -i 's/LE_EMAIL/admin@yourdomain.com/g' /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

### Step 14 — Configure firewall

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

### Step 15 — Open in browser

Visit `https://yourdomain.com` — you should see the landing page. Log in with the admin credentials from Step 11.

SSL cert will be auto-provisioned by Caddy on first HTTPS request (takes ~10 seconds).

---

## Install the `apsamo` CLI

```bash
cp deploy/bin/apsamo /usr/local/bin/apsamo
chmod +x /usr/local/bin/apsamo
sed -i 's|__INSTALL_DIR__|/opt/apsamo|g' /usr/local/bin/apsamo
```

Now you can manage the panel:

```bash
apsamo status              # show service status + disk usage
apsamo logs panel          # tail panel logs
apsamo restart             # restart all services
apsamo backup              # create a backup now
apsamo create-admin        # create or reset admin user
apsamo update              # git pull + rebuild + restart
apsamo doctor              # diagnose issues
apsamo help                # show all commands
```

---

## Post-Install Configuration

After install, configure the integrations you need:

### Domain Registration (Dynadot)

Get API keys at https://www.dynadot.com/account/api/apikey.html:

```bash
apsamo env
# Set:
#   DYNADOT_API_KEY=...
#   DYNADOT_SECRET_KEY=...
apsamo restart
```

### Billing (Stripe)

Get keys at https://dashboard.stripe.com/apikeys:

```bash
apsamo env
# Set:
#   STRIPE_SECRET_KEY=sk_live_...
#   STRIPE_WEBHOOK_SECRET=whsec_...
#   STRIPE_PRICE_ID_DEFAULT=price_...
apsamo restart
```

Set up the Stripe webhook endpoint:
- URL: `https://yourdomain.com/api/billing/webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`

### Email (SMTP)

For outgoing transactional email (verification links, password resets):

```bash
apsamo env
# Set:
#   SMTP_HOST=smtp.yourprovider.com
#   SMTP_PORT=587
#   SMTP_USER=postmaster@yourdomain.com
#   SMTP_PASS=...
apsamo restart
```

### Email Hosting (Mailcow)

If you didn't install Mailcow via the installer:

```bash
git clone https://github.com/mailcow/mailcow-dockerized /opt/mailcow
cd /opt/mailcow
./generate_config.sh   # use hostname: mail.yourdomain.com
docker compose up -d
```

Then get the Mailcow API key (Mailcow admin → Configuration → Access → API) and set:

```bash
apsamo env
# Set:
#   MAILCOW_API_URL=https://mail.yourdomain.com
#   MAILCOW_API_KEY=...
apsamo restart
```

### GitHub OAuth

Create an OAuth app at https://github.com/settings/developers:
- Homepage URL: `https://yourdomain.com`
- Authorization callback URL: `https://yourdomain.com/api/github/oauth/callback`

Then:

```bash
apsamo env
# Set:
#   GITHUB_CLIENT_ID=...
#   GITHUB_CLIENT_SECRET=...
apsamo restart
```

### Set up the localhost server (single-box deployment)

For the panel to deploy projects to itself (localhost), create a `localhost` server in the DB:

```bash
apsamo db-shell
```

```sql
INSERT INTO Server (id, name, ip, provider, status, cpuCores, ramGB, storageGB,
                    bandwidthGB, usedRamGB, usedStorageGB, region, sshHost, sshPort,
                    sshUser, dockerInstalled, caddyInstalled, healthStatus,
                    createdAt, updatedAt)
VALUES (
  lower(hex(randomblob(12))),
  'Localhost (this server)',
  '127.0.0.1', 'local', 'active',
  4, 8, 100, 1000, 0, 0, 'local',
  'localhost', 22, 'root',
  1, 1, 'healthy',
  datetime('now'), datetime('now')
);
```

Now any project you deploy on this server will use `LocalClient` — runs directly on the panel host (no Docker needed for the panel itself, only for project containers).

---

## Backups

### Automatic backups

The installer schedules a daily backup at 3 AM via cron:

```bash
crontab -l
# 0 3 * * * /opt/apsamo/deploy/scripts/backup.sh >> /opt/apsamo/logs/backup.log 2>&1
```

Backups go to `/opt/apsamo/backups/apsamo-backup-YYYYMMDD-HHMMSS.tar.gz` and include:
- SQLite database (after VACUUM)
- All storage (project files, SQLite DBs for hosted projects)
- `.env` (contains secrets!)
- Caddyfile
- Systemd unit files

### Manual backup

```bash
apsamo backup                   # full backup
apsamo backup --keep 7          # full backup, keep only last 7
apsamo backup --no-storage      # skip storage (faster, smaller)
apsamo backup --output /tmp/snapshot.tar.gz
```

### Restore

```bash
apsamo restore /opt/apsamo/backups/apsamo-backup-20251201-030000.tar.gz
```

The script will:
1. Stop services
2. Back up the current state (with `.pre-restore-<timestamp>` suffix)
3. Restore everything from the tarball
4. Restart services

---

## Updates

```bash
apsamo update                # full update: backup → git pull → build → restart
apsamo update --branch dev   # switch to dev branch first
apsamo update --tag v1.2.3   # checkout specific tag
apsamo update --no-backup    # skip pre-update backup (risky!)
```

Each update:
1. Creates a pre-update backup
2. Pulls the latest code
3. Reinstalls dependencies
4. Pushes any new DB schema
5. Rebuilds the production bundle
6. Restarts services in order: realtime → worker → panel

Expected downtime: ~30 seconds during restart.

---

## Troubleshooting

### Run the doctor

```bash
apsamo doctor
```

Checks OS, dependencies, install dir, services, network, disk space, and recent errors.

### View logs

```bash
apsamo logs panel        # panel logs (Next.js)
apsamo logs realtime     # Socket.IO service
apsamo logs worker       # cron/worker service
apsamo logs caddy        # Caddy reverse proxy
journalctl -u apsamo-panel -f    # systemd journal (panel)
```

### Common issues

**502 Bad Gateway from Caddy**
- Panel not running: `systemctl status apsamo-panel`
- Check `apsamo logs panel` for errors
- Common cause: `.env` is missing required vars (run `apsamo env`)

**SSL cert not provisioning**
- DNS not pointing to server yet (check: `dig yourdomain.com`)
- Let's Encrypt rate limit (wait 1 hour, retry)
- Port 443 blocked at provider firewall
- Check Caddy logs: `journalctl -u caddy -f`

**Database locked / "SQLITE_BUSY"**
- Worker and panel both writing — increase `db.connections` (not yet exposed in .env)
- Restart panel: `apsamo restart panel`
- If persistent: `apsamo db-shell` then `VACUUM;`

**Domain search returns 401 / "Invalid API key"**
- Dynadot keys missing: `apsamo env` and set `DYNADOT_API_KEY` / `DYNADOT_SECRET_KEY`
- Restart: `apsamo restart panel`

**Stripe checkout returns "demo"**
- `STRIPE_SECRET_KEY` is empty in `.env` — set it and `apsamo restart panel`

**Worker returns 401**
- Worker's `CRON_API_KEY` doesn't match panel's
- Fix: edit `/etc/systemd/system/apsamo-worker.service`, add `Environment=CRON_API_KEY=<value from .env>` to `[Service]`, then `systemctl daemon-reload && systemctl restart apsamo-worker`

---

## Architecture Reference

```
                    ┌──────────────────┐
                    │   Your Browser   │
                    └────────┬─────────┘
                             │
                             ▼
                    ┌──────────────────┐
                    │   Caddy (443)    │  ← auto-HTTPS via Let's Encrypt
                    │   Reverse Proxy  │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
    ┌────────────────┐ ┌───────────┐ ┌────────────┐
    │ apsamo-panel   │ │ realtime  │ │  worker    │
    │  (port 3000)   │ │  (3003)   │ │  (3005)    │
    │  Next.js 16    │ │ Socket.IO │ │  cron jobs │
    └────────┬───────┘ └───────────┘ └────────────┘
             │
             ▼
    ┌────────────────┐
    │  SQLite DB     │  ← /opt/apsamo/db/custom.db
    │  (Prisma ORM)  │
    └────────────────┘
             │
             ▼
    ┌────────────────────────────────────┐
    │       Storage (/opt/apsamo/storage)│
    │  ├── projects/<projectId>/         │  ← project files
    │  ├── backups/<projectId>/          │  ← project backups
    │  └── databases/<projectId>/        │  ← SQLite DBs for projects
    └────────────────────────────────────┘
             │
             ▼ (when server.sshHost != 'localhost')
    ┌────────────────────────────────────┐
    │  Remote VPS via SSH (ssh2)         │
    │  ├── Docker (project containers)   │
    │  ├── Caddy (per-project site blocks)│
    │  └── Mailcow (email hosting)       │
    └────────────────────────────────────┘
```

---

## Production Hardening Checklist

After install, consider:

- [ ] Set up off-server DB replication (not built-in; use Litestream)
- [ ] Move backups off-server (e.g. `rclone` to S3/B2 — add to `crontab`)
- [ ] Enable Caddy's `rate_limit` module for stricter API throttling
- [ ] Set up UFW brute-force protection (already enabled: fail2ban on SSH)
- [ ] Rotate `JWT_SECRET` quarterly (forces all sessions to log out)
- [ ] Monitor Let's Encrypt cert expiry (Caddy does this automatically)
- [ ] Set up server-level monitoring (Prometheus/Grafana or Uptime Kuma)
- [ ] Configure SMTP for outgoing email (else email verification won't work)
- [ ] Set up Stripe webhook signing (already supported via `STRIPE_WEBHOOK_SECRET`)
- [ ] Review `ufw status` and lock down to only essential ports

---

## License

MIT © Apsamo Technology. See [LICENSE](../LICENSE).
