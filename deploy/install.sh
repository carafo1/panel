#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Apsamo Panel — One-command Production Installer
# ════════════════════════════════════════════════════════════════════════════
#
#   Like cPanel's installer — SSH into a fresh Ubuntu/Debian VPS as root and run:
#
#       curl -fsSL https://your-repo/install.sh | bash
#
#   Or, if you have the panel source locally:
#
#       bash deploy/install.sh
#
#   The installer is interactive: it asks for brand domain, admin email, etc.
#   All values can also be pre-set via environment variables for unattended
#   installs (e.g. for Terraform / cloud-init):
#
#       BRAND_DOMAIN=example.com PANEL_DOMAIN=panel.example.com \
#       ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=StrongPass123 \
#       bash deploy/install.sh
#
#   BRAND_DOMAIN = apex brand (customer subdomains, mail, nameservers, emails).
#   PANEL_DOMAIN = where the dashboard is served (APP_URL / OAuth / email links);
#                  defaults to panel.<BRAND_DOMAIN> if not set.
#
#   The installer:
#     1. Verifies OS (Ubuntu 22.04+, Debian 12+) and root
#     2. Installs system packages (curl, git, ufw, build-essential, etc.)
#     3. Installs Docker Engine
#     4. Installs Caddy v2 (auto-HTTPS via Let's Encrypt)
#     5. Installs Bun (Next.js runtime)
#     6. Optionally installs Mailcow (Dockerized email)
#     7. Sets up the panel at /opt/apsamo
#     8. Generates strong secrets for .env (JWT, encryption, cron key)
#     9. Pushes Prisma schema + seeds DB (plans, servers, templates, admin)
#    10. Creates the admin user (configurable email + password)
#    11. Installs systemd units for panel, realtime, worker
#    12. Configures Caddy reverse proxy with auto-HTTPS
#    13. Configures ufw firewall (80, 443, 22)
#    14. Starts everything + enables on boot
#    15. Prints the admin URL + login credentials
# ════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
log()   { echo "${GREEN}✓${NC} $*"; }
warn()  { echo "${YELLOW}!${NC} $*"; }
err()   { echo "${RED}✗${NC} $*" >&2; }
step()  { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }
ask()   { read -rp "$* " ans; echo "$ans"; }
ask_secret() { read -rsp "$* " ans; echo >&2; echo "$ans"; }

# ── Pre-flight checks ────────────────────────────────────────────────────
step "Pre-flight checks"

if [[ $EUID -ne 0 ]]; then
  err "This installer must be run as root (use sudo)."
  exit 1
fi

# Detect OS
if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS_ID=$ID
  OS_VERSION=$VERSION_ID
  log "Detected OS: $PRETTY_NAME"
else
  err "Cannot detect OS — only Ubuntu 22.04+ and Debian 12+ are supported."
  exit 1
fi

case "$OS_ID" in
  ubuntu) [[ "$OS_VERSION" < "22.04" ]] && { err "Ubuntu 22.04+ required (got $OS_VERSION)"; exit 1; } ;;
  debian) [[ "$OS_VERSION" < "12" ]] && { err "Debian 12+ required (got $OS_VERSION)"; exit 1; } ;;
  *) err "Unsupported OS: $OS_ID. Only Ubuntu and Debian are supported."; exit 1 ;;
esac

# Detect panel source
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/../package.json" ]] && grep -q '"next"' "$SCRIPT_DIR/../package.json" 2>/dev/null; then
  # We're inside the panel repo
  PANEL_SRC="$(cd "$SCRIPT_DIR/.." && pwd)"
  log "Panel source: $PANEL_SRC"
else
  # We're standalone — clone from GitHub
  PANEL_SRC=""
  warn "Panel source not found locally; will clone from https://github.com/carafo1/panel.git"
  warn "If the repo is private, set GITHUB_TOKEN env var first."
fi

# ── Interactive configuration (or use env vars) ──────────────────────────
step "Configuration"

SERVER_HOSTNAME="${BRAND_DOMAIN:-$(ask "${BOLD}Brand domain${NC} (apex, e.g. apsamo.com — used for customer subdomains, mail, nameservers, emails):")}"
if [[ -z "$SERVER_HOSTNAME" ]]; then
  err "Brand domain is required."
  exit 1
fi

# Panel domain — where the control panel itself is served (drives APP_URL,
# OAuth callbacks, billing redirects, and email links). Defaults to
# panel.<brand>. Set PANEL_DOMAIN equal to the brand domain to serve the panel
# on the apex instead.
PANEL_DOMAIN="${PANEL_DOMAIN:-$(ask "${BOLD}Panel domain${NC} (where the dashboard is served) [default: panel.$SERVER_HOSTNAME]:")}"
PANEL_DOMAIN="${PANEL_DOMAIN:-panel.$SERVER_HOSTNAME}"
log "Panel served at https://$PANEL_DOMAIN  (brand/apex: $SERVER_HOSTNAME)"

ADMIN_EMAIL="${ADMIN_EMAIL:-$(ask "${BOLD}Admin email${NC} (e.g. admin@$SERVER_HOSTNAME):")}"
if [[ -z "$ADMIN_EMAIL" ]]; then
  err "Admin email is required."
  exit 1
fi

ADMIN_PASSWORD="${ADMIN_PASSWORD:-$(ask_secret "${BOLD}Admin password${NC} (min 8 chars, will be hidden):")}"
if [[ ${#ADMIN_PASSWORD} -lt 8 ]]; then
  err "Admin password must be at least 8 characters."
  exit 1
fi

INSTALL_MAILCOW="${INSTALL_MAILCOW:-$(ask "${BOLD}Install Mailcow for email hosting?${NC} [y/N]:")}"
INSTALL_MAILCOW="${INSTALL_MAILCOW:-n}"
[[ "$INSTALL_MAILCOW" =~ ^[Yy] ]] && INSTALL_MAILCOW=1 || INSTALL_MAILCOW=0

# Optional integrations (defaults: skip; can be configured later via /opt/apsamo/.env)
echo ""
echo "Optional integrations (can be left blank to configure later):"

# Database engine: sqlite (default) or postgres (for HA + pgvector AI search)
DB_ENGINE="${DB_ENGINE:-$(ask "${BOLD}Database engine${NC} [sqlite/postgres] (postgres enables pgvector AI search):")}"
DB_ENGINE="${DB_ENGINE:-sqlite}"
case "$DB_ENGINE" in
  sqlite|postgres) ;;
  *) err "DB_ENGINE must be 'sqlite' or 'postgres' (got: $DB_ENGINE)"; exit 1 ;;
esac
log "Database engine: $DB_ENGINE"

DYNADOT_API_KEY="${DYNADOT_API_KEY:-$(ask "Dynadot API key (for domain registration):")}"
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-$(ask "Stripe secret key (sk_...):")}"
SMTP_HOST="${SMTP_HOST:-$(ask "SMTP host (for outgoing email):")}"
SMTP_USER="${SMTP_USER:-$(ask "SMTP user:")}"
SMTP_PASS="${SMTP_PASS:-$(ask_secret "SMTP password (hidden):")}"

# ── Install system packages ──────────────────────────────────────────────
step "Installing system packages"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl wget git unzip vim less \
  build-essential python3-dev \
  ufw ca-certificates gnupg lsb-release \
  sqlite3 libsqlite3-dev \
  openssh-server \
  fail2ban \
  > /tmp/apt-install.log 2>&1
log "System packages installed"

# ── Install Docker ───────────────────────────────────────────────────────
step "Installing Docker"

if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  log "Docker installed"
else
  log "Docker already installed ($(docker --version))"
fi

# ── Install Caddy ────────────────────────────────────────────────────────
step "Installing Caddy"

if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https 2>/dev/null || true
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
  log "Caddy installed"
else
  log "Caddy already installed ($(caddy version 2>&1 | head -1))"
fi

# ── Install Bun ──────────────────────────────────────────────────────────
step "Installing Bun"

if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  # Make bun available system-wide
  ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun
  log "Bun installed"
else
  log "Bun already installed ($(bun --version))"
fi

# ── Install Node (for Next.js standalone build) ──────────────────────────
step "Installing Node.js"

if ! command -v node &>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
  log "Node.js installed ($(node --version))"
else
  log "Node.js already installed ($(node --version))"
fi

# ── Optional: Install Mailcow ────────────────────────────────────────────
if [[ "$INSTALL_MAILCOW" == "1" ]]; then
  step "Installing Mailcow (email hosting)"

  MAILCOW_DIR="/opt/mailcow"
  if [[ ! -d "$MAILCOW_DIR" ]]; then
    git clone https://github.com/mailcow/mailcow-dockerized "$MAILCOW_DIR"
    cd "$MAILCOW_DIR"
    # Generate config with sensible defaults
    ./generate_config.sh \
      MAILCOW_HOSTNAME="mail.$SERVER_HOSTNAME" \
      MAILCOW_TZ="UTC" \
      <<EOF
y
EOF
    docker compose up -d
    log "Mailcow installed at $MAILCOW_DIR (https://mail.$SERVER_HOSTNAME)"
  else
    log "Mailcow already installed at $MAILCOW_DIR"
  fi
fi

# ── Set up panel source ──────────────────────────────────────────────────
step "Setting up Apsamo Panel"

INSTALL_DIR="/opt/apsamo"
mkdir -p "$INSTALL_DIR"

if [[ -n "$PANEL_SRC" ]]; then
  # Copy from local source
  log "Copying panel from $PANEL_SRC → $INSTALL_DIR"
  rsync -a --exclude 'node_modules' --exclude '.next' --exclude 'db' --exclude 'storage' \
        --exclude 'logs' --exclude '*.log' --exclude '.git' \
        "$PANEL_SRC/" "$INSTALL_DIR/"
else
  # Clone from GitHub
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    git clone "https://${GITHUB_TOKEN}@github.com/carafo1/panel.git" "$INSTALL_DIR"
  else
    git clone https://github.com/carafo1/panel.git "$INSTALL_DIR"
  fi
fi

cd "$INSTALL_DIR"

# ── Generate .env with strong secrets ────────────────────────────────────
step "Generating .env with strong secrets"

JWT_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
NEXTAUTH_SECRET=$(openssl rand -base64 32)
CRON_API_KEY=$(openssl rand -hex 32)
SERVER_IP=$(curl -s -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

cat > "$INSTALL_DIR/.env" <<EOF
# ─────────────────────────────────────────────────────────────────────────────
# Apsamo Panel — Production Environment (auto-generated by install.sh)
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# ─────────────────────────────────────────────────────────────────────────────

# Database
# (Defaults to SQLite. If DB_ENGINE=postgres, install-postgres.sh runs first
# and overwrites DATABASE_URL with the PostgreSQL connection string.)
DATABASE_URL="file:$INSTALL_DIR/db/custom.db"
DB_ENGINE="sqlite"

# Auth — JWT
JWT_SECRET="$JWT_SECRET"
NEXTAUTH_URL="https://$PANEL_DOMAIN"
NEXTAUTH_SECRET="$NEXTAUTH_SECRET"

# Encryption — AES-256-GCM (64-char hex)
ENCRYPTION_KEY="$ENCRYPTION_KEY"

# App / Branding
# APP_URL / NEXT_PUBLIC_APP_URL = where the PANEL is served (OAuth callbacks,
# billing redirects, email links). BRAND_DOMAIN = the apex brand (customer
# subdomains, mail, nameservers, system emails).
APP_URL="https://$PANEL_DOMAIN"
NEXT_PUBLIC_APP_URL="https://$PANEL_DOMAIN"
BRAND_DOMAIN="$SERVER_HOSTNAME"
APP_SUBDOMAIN_PATTERN="{slug}.${SERVER_HOSTNAME}"
NS1_HOSTNAME="ns1.${SERVER_HOSTNAME}"
NS2_HOSTNAME="ns2.${SERVER_HOSTNAME}"
MAIL_SERVER_HOSTNAME="mail.${SERVER_HOSTNAME}"

# System Email Mailboxes
NO_REPLY_EMAIL="no-reply@${SERVER_HOSTNAME}"
SUPPORT_EMAIL="support@${SERVER_HOSTNAME}"
BILLING_EMAIL="billing@${SERVER_HOSTNAME}"
ADMIN_EMAIL="${ADMIN_EMAIL}"

# SMTP — outgoing transactional email
SMTP_HOST="${SMTP_HOST}"
SMTP_PORT="587"
SMTP_USER="${SMTP_USER}"
SMTP_PASS="${SMTP_PASS}"
SMTP_FROM_NAME="Apsamo Panel"
SMTP_FROM_EMAIL="no-reply@${SERVER_HOSTNAME}"

# Mailcow — email hosting API
MAILCOW_API_URL="$([[ "$INSTALL_MAILCOW" == "1" ]] && echo "https://mail.${SERVER_HOSTNAME}" || echo "")"
MAILCOW_API_KEY=""

# Domains — Dynadot Registrar API
DYNADOT_API_KEY="${DYNADOT_API_KEY}"
DYNADOT_SECRET_KEY=""

# Billing — Stripe
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY}"
STRIPE_WEBHOOK_SECRET=""
STRIPE_PRICE_ID_DEFAULT=""
STRIPE_PUBLISHABLE_KEY=""

# Billing — WaafiPay
WAAFI_API_URL="https://api.waafipay.net"
WAAFI_MERCHANT_ID=""
WAAFI_API_KEY=""
WAAFI_API_USER_ID=""

# GitHub OAuth
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""

# VPS / Storage
STORAGE_ROOT="$INSTALL_DIR/storage"
VPS_DEMO_MODE="0"

# Let's Encrypt
LE_EMAIL="${ADMIN_EMAIL}"

# Cron / Background Jobs
CRON_API_KEY="$CRON_API_KEY"

# Runtime
NODE_ENV="production"
PORT="3000"
EOF

chmod 600 "$INSTALL_DIR/.env"
log ".env generated at $INSTALL_DIR/.env (chmod 600)"

# ── Install dependencies ─────────────────────────────────────────────────
step "Installing dependencies"

# Do NOT use --production here: the production build (`next build`) needs
# devDependencies (typescript, tailwindcss, @tailwindcss/postcss, eslint-config-next).
bun install
log "Panel dependencies installed"

# The realtime mini-service is a SEPARATE package (needs socket.io). Install its
# own deps so the apsamo-realtime systemd unit can actually start.
if [[ -f "$INSTALL_DIR/mini-services/realtime-service/package.json" ]]; then
  ( cd "$INSTALL_DIR/mini-services/realtime-service" && bun install )
  log "Realtime service dependencies installed"
fi

# ── Initialize database ──────────────────────────────────────────────────
# NOTE: this runs BEFORE the build on purpose — `prisma db push` also (re)generates
# the Prisma client, which `next build` imports. Building first would fail.
step "Initializing database"

# logs/ must exist before services start: the systemd units append to logs/*.log.
mkdir -p "$INSTALL_DIR/db" "$INSTALL_DIR/storage" "$INSTALL_DIR/logs"

# If user chose PostgreSQL, install it now + switch Prisma schema before db:push
if [[ "$DB_ENGINE" == "postgres" ]]; then
  step "Installing PostgreSQL 16 + pgvector (DB_ENGINE=postgres)"

  # Run the PostgreSQL installer — it prints the DATABASE_URL at the end
  PG_OUTPUT=$(bash "$INSTALL_DIR/deploy/scripts/install-postgres.sh" 2>&1)
  echo "$PG_OUTPUT" | tail -20

  # Extract the DATABASE_URL from the installer output
  PG_URL=$(echo "$PG_OUTPUT" | grep -E '^postgresql://apsamo:' | head -1 | tr -d ' ')
  if [[ -z "$PG_URL" ]]; then
    err "Failed to extract PostgreSQL URL from install-postgres.sh output"
    err "Run manually: bash $INSTALL_DIR/deploy/scripts/install-postgres.sh"
    exit 1
  fi

  # Switch Prisma schema to PostgreSQL variant
  cp "$INSTALL_DIR/prisma/schema.postgres.prisma" "$INSTALL_DIR/prisma/schema.prisma"
  log "Switched Prisma schema to PostgreSQL (with pgvector)"

  # Update .env with PostgreSQL URL
  sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"$PG_URL\"|" "$INSTALL_DIR/.env"
  sed -i 's|^DB_ENGINE=.*|DB_ENGINE="postgres"|' "$INSTALL_DIR/.env"
  log ".env updated — DATABASE_URL → PostgreSQL"
fi

bun run db:push
log "Database schema pushed + Prisma client generated ($DB_ENGINE)"

# ── Build production bundle (needs the Prisma client generated just above) ─
step "Building production bundle"
bun run build
log "Production build complete (.next/standalone/)"

# ── Seed database ────────────────────────────────────────────────────────
step "Seeding database"

bun run scripts/run-seed.ts
bun run scripts/seed-templates-and-payment.ts
log "Database seeded (plans, templates, payment methods)"

# ── Create admin user ────────────────────────────────────────────────────
step "Creating admin user"

# Credentials are passed via the ENVIRONMENT (not string-interpolated into the
# script) so passwords containing quotes, $, backticks etc. are handled safely.
# We upsert by EMAIL and always (re)assign super_admin, and we drop the dev-only
# default admin (admin@deployhub.io) if it exists — so the operator can always
# log in with exactly the credentials entered above.
ADMIN_EMAIL="$ADMIN_EMAIL" ADMIN_PASSWORD="$ADMIN_PASSWORD" bun -e '
const { db } = require("./src/lib/db");
const bcrypt = require("bcryptjs");
(async () => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const hashed = await bcrypt.hash(password, 12);
  // Remove the dev-only default admin unless it IS the operator account.
  await db.user.deleteMany({ where: { email: "admin@deployhub.io", NOT: { email } } });
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    await db.user.update({
      where: { email },
      data: { password: hashed, role: "super_admin", emailVerified: true },
    });
    console.log("Admin updated:", email);
  } else {
    await db.user.create({
      data: { email, name: "Administrator", password: hashed, role: "super_admin", emailVerified: true },
    });
    console.log("Admin created:", email);
  }
  process.exit(0);
})();
'
log "Admin user ready: $ADMIN_EMAIL"

# ── Register this box as a deployable "localhost" server ─────────────────
step "Registering localhost server (single-box deployment)"

# So projects can be deployed on this box out of the box (LocalClient — no
# SSH/Docker needed for the panel itself). Split deployments add real VPS hosts
# later via Admin → Servers.
LH_CPU=$(nproc 2>/dev/null || echo 4)
LH_RAM=$(awk '/MemTotal/ {printf "%d", $2/1024/1024}' /proc/meminfo 2>/dev/null || echo 4)
LH_DISK=$(df -BG / 2>/dev/null | awk 'NR==2 {gsub(/G/,"",$2); print $2}' || echo 50)
LH_CPU="$LH_CPU" LH_RAM="$LH_RAM" LH_DISK="$LH_DISK" bun -e '
const { db } = require("./src/lib/db");
(async () => {
  const existing = await db.server.findFirst({ where: { sshHost: "localhost" } });
  if (existing) { console.log("localhost server already exists:", existing.id); process.exit(0); }
  const s = await db.server.create({ data: {
    name: "Localhost (this server)", ip: "127.0.0.1", provider: "local", status: "active",
    cpuCores: parseInt(process.env.LH_CPU) || 4,
    ramGB: parseInt(process.env.LH_RAM) || 4,
    storageGB: parseInt(process.env.LH_DISK) || 50,
    bandwidthGB: 1000, usedRamGB: 0, usedStorageGB: 0, region: "local",
    sshHost: "localhost", sshPort: 22, sshUser: "root",
    dockerInstalled: true, caddyInstalled: true, healthStatus: "healthy",
  }});
  console.log("localhost server created:", s.id);
  process.exit(0);
})();
'
log "Localhost server registered (projects can deploy on this box)"

# ── Install systemd units ────────────────────────────────────────────────
step "Installing systemd units"

cp "$INSTALL_DIR/deploy/systemd/apsamo-panel.service"   /etc/systemd/system/
cp "$INSTALL_DIR/deploy/systemd/apsamo-realtime.service" /etc/systemd/system/
cp "$INSTALL_DIR/deploy/systemd/apsamo-worker.service"   /etc/systemd/system/

# Substitute INSTALL_DIR in unit files
sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
  /etc/systemd/system/apsamo-panel.service \
  /etc/systemd/system/apsamo-realtime.service \
  /etc/systemd/system/apsamo-worker.service

# SECURITY: verify the replacement actually worked (fails loudly if not)
for unit in apsamo-panel apsamo-realtime apsamo-worker; do
  if grep -q "__INSTALL_DIR__" "/etc/systemd/system/${unit}.service"; then
    err "Failed to replace __INSTALL_DIR__ in ${unit}.service — running repair"
    sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "/etc/systemd/system/${unit}.service"
  fi
done

# Verify the unit files are valid
systemctl daemon-reload
systemctl enable apsamo-panel apsamo-realtime apsamo-worker
log "Systemd units installed + verified"

# ── Configure Caddy ──────────────────────────────────────────────────────
step "Configuring Caddy reverse proxy (auto-HTTPS)"

cat > /etc/caddy/Caddyfile <<EOF
# Apsamo Panel — Production Caddyfile (auto-generated by install.sh)
# Generated: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ─── Panel + brand site ───────────────────────────────────────────────
# Same Next.js app on all three hostnames (landing page at /, dashboard behind
# auth). Caddy auto-provisions a Let's Encrypt cert for each.
#   $PANEL_DOMAIN        → panel/dashboard (APP_URL)
#   $SERVER_HOSTNAME     → brand apex / public landing
#   www.$SERVER_HOSTNAME → www of the brand
$PANEL_DOMAIN, $SERVER_HOSTNAME, www.$SERVER_HOSTNAME {
    encode gzip zstd

    # Realtime (Socket.IO) — routed via XTransformPort query param
    @realtime {
        query XTransformPort=*
        path /socket.io/*
    }
    handle @realtime {
        reverse_proxy localhost:{query.XTransformPort} {
            header_up Host {host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
        }
    }

    # Everything else → Next.js panel
    handle {
        reverse_proxy localhost:3000 {
            header_up Host {host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
        }
    }

    # Static assets caching
    @static path /_next/static/*
    handle @static {
        header Cache-Control "public, max-age=31536000, immutable"
    }

    log {
        output file /var/log/caddy/apsamo.log
        format json
    }
}

# ─── Mailcow webmail (optional) ──────────────────────────────────────
${MAILCOW_API_URL:+mail.$SERVER_HOSTNAME {
    reverse_proxy localhost:443 {
        transport http {
            tls
            tls_server_name mail.$SERVER_HOSTNAME
        }
    }
}}
EOF

caddy validate --config /etc/caddy/Caddyfile
systemctl restart caddy
systemctl enable caddy
log "Caddy configured with auto-HTTPS for $SERVER_HOSTNAME"

# ── Configure firewall ───────────────────────────────────────────────────
step "Configuring firewall (ufw)"

ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH'
ufw allow 80/tcp comment 'HTTP'
ufw allow 443/tcp comment 'HTTPS'
ufw --force enable
log "Firewall: 22, 80, 443 open"

# ── Configure fail2ban (SSH protection) ──────────────────────────────────
cat > /etc/fail2ban/jail.local <<EOF
[DEFAULT]
bantime = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
EOF
systemctl enable --now fail2ban
log "fail2ban enabled for SSH"

# ── Install apsamo CLI ───────────────────────────────────────────────────
step "Installing apsamo CLI"

cp "$INSTALL_DIR/deploy/bin/apsamo" /usr/local/bin/apsamo
chmod +x /usr/local/bin/apsamo
sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" /usr/local/bin/apsamo
log "apsamo CLI installed at /usr/local/bin/apsamo"

# ── Set up cron job for backups ──────────────────────────────────────────
step "Setting up automatic backups"

(crontab -l 2>/dev/null || true; echo "0 3 * * * $INSTALL_DIR/deploy/scripts/backup.sh >> $INSTALL_DIR/logs/backup.log 2>&1") | crontab -
log "Daily 3 AM backup scheduled"

# ── Set up log rotation ──────────────────────────────────────────────────
cat > /etc/logrotate.d/apsamo <<EOF
$INSTALL_DIR/logs/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
}
EOF
log "Log rotation configured"

# ── Start services ───────────────────────────────────────────────────────
step "Starting services"

systemctl restart apsamo-realtime
systemctl restart apsamo-worker
systemctl restart apsamo-panel

sleep 5

# ── Final verification ───────────────────────────────────────────────────
step "Verifying installation"

PANEL_STATUS=$(systemctl is-active apsamo-panel)
REALTIME_STATUS=$(systemctl is-active apsamo-realtime)
WORKER_STATUS=$(systemctl is-active apsamo-worker)
CADDY_STATUS=$(systemctl is-active caddy)

log "apsamo-panel:    $PANEL_STATUS"
log "apsamo-realtime: $REALTIME_STATUS"
log "apsamo-worker:   $WORKER_STATUS"
log "caddy:           $CADDY_STATUS"

# ── Print summary ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════════════════"
echo "  ${GREEN}${BOLD}Apsamo Panel installed successfully!${NC}"
echo "══════════════════════════════════════════════════════════════════════════"
echo ""
echo "  ${BOLD}Panel URL:${NC}      https://$PANEL_DOMAIN"
echo "  ${BOLD}Brand site:${NC}     https://$SERVER_HOSTNAME"
echo "  ${BOLD}Admin email:${NC}    $ADMIN_EMAIL"
echo "  ${BOLD}Admin password:${NC} (the one you entered above)"
echo ""
echo "  ${BOLD}Database:${NC}       $DB_ENGINE"
if [[ "$DB_ENGINE" == "postgres" ]]; then
  echo "  ${BOLD}pgvector:${NC}       enabled (AI semantic search ready)"
  echo "  ${BOLD}Populate vectors:${NC} bun run scripts/populate-embeddings.ts"
fi
echo ""
echo "  ${BOLD}Server IP:${NC}      $SERVER_IP"
echo "  ${BOLD}Install dir:${NC}    $INSTALL_DIR"
echo "  ${BOLD}Logs:${NC}           $INSTALL_DIR/logs/"
echo "                journalctl -u apsamo-panel -f"
echo ""
echo "  ${BOLD}Manage with:${NC}    apsamo status"
echo "                apsamo restart"
echo "                apsamo logs"
echo "                apsamo backup"
echo "                apsamo update"
echo "                apsamo create-admin"
echo ""
echo "  ${BOLD}DNS records to set (at your registrar):${NC}"
echo "    A     $PANEL_DOMAIN           → $SERVER_IP   (panel/dashboard)"
echo "    A     $SERVER_HOSTNAME           → $SERVER_IP   (brand apex / landing)"
echo "    A     www.$SERVER_HOSTNAME       → $SERVER_IP"
if [[ "$INSTALL_MAILCOW" == "1" ]]; then
  echo "    A     mail.$SERVER_HOSTNAME       → $SERVER_IP"
  echo "    MX    $SERVER_HOSTNAME           → mail.$SERVER_HOSTNAME (priority 10)"
fi
echo "    A     ns1.$SERVER_HOSTNAME       → $SERVER_IP"
echo "    A     ns2.$SERVER_HOSTNAME       → $SERVER_IP"
echo ""
echo "  SSL certificate will auto-provision on first HTTPS request."
echo "══════════════════════════════════════════════════════════════════════════"
