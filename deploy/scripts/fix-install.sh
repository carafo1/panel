#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# fix-install.sh — Diagnose + fix incomplete Apsamo Panel install
# ════════════════════════════════════════════════════════════════════════════
#
#   When `apsamo verify` shows everything failing, run this script.
#   It diagnoses what's missing + fixes it step by step.
#
#   Usage (on your VPS as root):
#     bash /opt/apsamo/deploy/scripts/fix-install.sh
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

INSTALL_DIR="/opt/apsamo"
ENV_FILE="$INSTALL_DIR/.env"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }
step() { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — Fix Incomplete Install${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"

if [[ $EUID -ne 0 ]]; then
  err "Run as root: sudo bash $0"
  exit 1
fi

# ── DIAGNOSE: What's missing? ─────────────────────────────────────────────
step "Diagnosis"

ISSUES=()

# Check 1: /opt/apsamo exists?
if [[ ! -d "$INSTALL_DIR" ]]; then
  err "ISSUE 1: $INSTALL_DIR does not exist — panel not cloned"
  ISSUES+=("clone")
else
  ok "/opt/apsamo exists"
fi

# Check 2: .env exists?
if [[ ! -f "$ENV_FILE" ]]; then
  err "ISSUE 2: .env missing — secrets not configured"
  ISSUES+=("env")
else
  ok ".env exists"
fi

# Check 3: Dependencies installed?
if [[ -d "$INSTALL_DIR" ]] && [[ ! -d "$INSTALL_DIR/node_modules" ]]; then
  err "ISSUE 3: node_modules missing — dependencies not installed"
  ISSUES+=("deps")
else
  ok "node_modules exists"
fi

# Check 4: Build output exists?
if [[ -d "$INSTALL_DIR" ]] && [[ ! -f "$INSTALL_DIR/.next/standalone/server.js" ]]; then
  err "ISSUE 4: Build output missing — production build not run"
  ISSUES+=("build")
else
  ok "Build output exists"
fi

# Check 5: Database exists?
DB_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" 2>/dev/null | cut -d'"' -f2)
DB_PATH="${DB_URL#file:}"
DB_PATH="${DB_PATH:-$INSTALL_DIR/db/custom.db}"
if [[ ! -f "$DB_PATH" ]]; then
  err "ISSUE 5: Database not found at $DB_PATH"
  ISSUES+=("db")
else
  ok "Database exists"
fi

# Check 6: Systemd units exist?
for unit in apsamo-panel apsamo-realtime apsamo-worker; do
  if [[ ! -f "/etc/systemd/system/${unit}.service" ]]; then
    err "ISSUE 6: ${unit}.service missing"
    ISSUES+=("systemd")
    break
  fi
done
if [[ -f /etc/systemd/system/apsamo-panel.service ]]; then
  ok "Systemd units exist"
fi

# Check 7: Bun installed?
if ! command -v bun &>/dev/null; then
  err "ISSUE 7: bun not installed"
  ISSUES+=("bun")
else
  ok "bun installed: $(bun --version)"
fi

# Check 8: Required secrets in .env?
SECRETS_OK=true
for key in JWT_SECRET ENCRYPTION_KEY CRON_API_KEY; do
  val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | cut -d'"' -f2)
  if [[ -z "$val" ]] || [[ "$val" == *"replace-with"* ]]; then
    err "ISSUE 8: $key missing or placeholder"
    SECRETS_OK=false
  fi
done
if [[ "$SECRETS_OK" == "true" ]]; then
  ok "Required secrets present"
else
  ISSUES+=("secrets")
fi

echo ""
echo "${BOLD}Found ${#ISSUES[@]} issue(s): ${ISSUES[*]}${NC}"
echo ""

# ── FIX: Address each issue ───────────────────────────────────────────────

# ── FIX: Clone if missing ─────────────────────────────────────────────────
if [[ " ${ISSUES[@]} " =~ " clone " ]]; then
  step "Fix: Cloning panel from GitHub"
  git clone https://github.com/carafo1/panel.git "$INSTALL_DIR"
  ok "Cloned to $INSTALL_DIR"
fi

cd "$INSTALL_DIR" || { err "Cannot cd to $INSTALL_DIR"; exit 1; }

# ── FIX: Install bun if missing ───────────────────────────────────────────
if [[ " ${ISSUES[@]} " =~ " bun " ]]; then
  step "Fix: Installing Bun"
  curl -fsSL https://bun.sh/install | bash
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
  export PATH="/root/.bun/bin:$PATH"
  ok "Bun installed: $(bun --version)"
fi

# ── FIX: Create .env if missing ───────────────────────────────────────────
if [[ " ${ISSUES[@]} " =~ " env " ]]; then
  step "Fix: Creating .env"

  # Generate secrets
  JWT_SECRET=$(openssl rand -base64 32)
  ENCRYPTION_KEY=$(openssl rand -hex 32)
  CRON_API_KEY=$(openssl rand -hex 32)

  # Ask for brand domain + admin creds
  echo ""
  read -rp "  Brand domain (e.g. apsamo.io): " BRAND_DOMAIN
  BRAND_DOMAIN="${BRAND_DOMAIN:-apsamo.io}"
  read -rp "  Admin email: " ADMIN_EMAIL
  ADMIN_EMAIL="${ADMIN_EMAIL:-admin@$BRAND_DOMAIN}"
  read -rsp "  Admin password (min 8 chars): " ADMIN_PASSWORD
  echo
  if [[ ${#ADMIN_PASSWORD} -lt 8 ]]; then
    err "Password too short — using default"
    ADMIN_PASSWORD="ChangeMe!$(openssl rand -hex 4)"
  fi

  SERVER_IP=$(curl -s -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

  cat > "$ENV_FILE" <<EOF
DATABASE_URL="file:$INSTALL_DIR/db/custom.db"
JWT_SECRET="$JWT_SECRET"
NEXTAUTH_URL="https://$BRAND_DOMAIN"
NEXTAUTH_SECRET="$(openssl rand -base64 32)"
ENCRYPTION_KEY="$ENCRYPTION_KEY"
APP_URL="https://$BRAND_DOMAIN"
NEXT_PUBLIC_APP_URL="https://$BRAND_DOMAIN"
BRAND_DOMAIN="$BRAND_DOMAIN"
APP_SUBDOMAIN_PATTERN="{slug}.\${BRAND_DOMAIN}"
NS1_HOSTNAME="ns1.$BRAND_DOMAIN"
NS2_HOSTNAME="ns2.$BRAND_DOMAIN"
MAIL_SERVER_HOSTNAME="mail.$BRAND_DOMAIN"
NO_REPLY_EMAIL="no-reply@$BRAND_DOMAIN"
SUPPORT_EMAIL="support@$BRAND_DOMAIN"
BILLING_EMAIL="billing@$BRAND_DOMAIN"
ADMIN_EMAIL="$ADMIN_EMAIL"
SMTP_HOST=""
SMTP_PORT="587"
SMTP_USER=""
SMTP_PASS=""
SMTP_FROM_NAME="Apsamo Panel"
SMTP_FROM_EMAIL="no-reply@$BRAND_DOMAIN"
MAILCOW_API_URL=""
MAILCOW_API_KEY=""
DYNADOT_API_KEY=""
DYNADOT_SECRET_KEY=""
STRIPE_SECRET_KEY=""
STRIPE_WEBHOOK_SECRET=""
STRIPE_PRICE_ID_DEFAULT=""
STRIPE_PUBLISHABLE_KEY=""
WAAFI_API_URL="https://api.waafipay.net"
WAAFI_MERCHANT_ID=""
WAAFI_API_KEY=""
WAAFI_API_USER_ID=""
GITHUB_CLIENT_ID=""
GITHUB_CLIENT_SECRET=""
STORAGE_ROOT="$INSTALL_DIR/storage"
VPS_DEMO_MODE="0"
LE_EMAIL="$ADMIN_EMAIL"
CRON_API_KEY="$CRON_API_KEY"
NODE_ENV="production"
PORT="3000"
EOF
  chmod 600 "$ENV_FILE"
  ok ".env created (brand: $BRAND_DOMAIN, admin: $ADMIN_EMAIL)"
  echo ""
  warn "Admin password: $ADMIN_PASSWORD (save this!)"
fi

# ── FIX: Install dependencies ─────────────────────────────────────────────
if [[ " ${ISSUES[@]} " =~ " deps " ]]; then
  step "Fix: Installing dependencies (this takes 1-2 min)"
  bun install --production 2>&1 | tail -5
  ok "Dependencies installed"
fi

# ── FIX: Build ────────────────────────────────────────────────────────────
if [[ " ${ISSUES[@]} " =~ " build " ]]; then
  step "Fix: Building production bundle (this takes 3-5 min)"
  bun run build 2>&1 | tail -10
  if [[ -f .next/standalone/server.js ]]; then
    ok "Build complete"
  else
    err "Build failed — check errors above"
    exit 1
  fi
fi

# ── FIX: Database ─────────────────────────────────────────────────────────
if [[ " ${ISSUES[@]} " =~ " db " ]]; then
  step "Fix: Creating database"
  mkdir -p "$INSTALL_DIR/db" "$INSTALL_DIR/storage" "$INSTALL_DIR/logs" "$INSTALL_DIR/backups"

  # Re-read DB path (in case .env was just created)
  DB_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d'"' -f2)
  DB_PATH="${DB_URL#file:}"

  bun run db:push 2>&1 | tail -5
  ok "Schema pushed"

  bun run scripts/run-seed.ts 2>&1 | tail -5
  bun run scripts/seed-templates-and-payment.ts 2>&1 | tail -5
  ok "Database seeded (plans, servers, templates, payment methods)"

  # Create admin user
  ADMIN_EMAIL=$(grep '^ADMIN_EMAIL=' "$ENV_FILE" | cut -d'"' -f2)
  if [[ -n "$ADMIN_EMAIL" ]]; then
    ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | head -c 20)
    bun -e "
const { db } = require('./src/lib/db');
const bcrypt = require('bcryptjs');
(async () => {
  const existing = await db.user.findFirst({ where: { role: { in: ['admin', 'super_admin'] } } });
  if (existing) { console.log('Admin already exists:', existing.email); process.exit(0); }
  const hashed = await bcrypt.hash('${ADMIN_PASSWORD}', 12);
  await db.user.create({
    data: {
      email: '${ADMIN_EMAIL}',
      name: 'Administrator',
      password: hashed,
      role: 'super_admin',
      emailVerified: true,
    },
  });
  console.log('Admin created:', '${ADMIN_EMAIL}');
  process.exit(0);
})();
" 2>&1 | tail -3
    echo ""
    warn "Admin email:    $ADMIN_EMAIL"
    warn "Admin password: $ADMIN_PASSWORD"
    echo ""
    echo "  (Save this password! You'll need it to log in.)"
  fi
fi

# ── FIX: Systemd units ────────────────────────────────────────────────────
if [[ " ${ISSUES[@]} " =~ " systemd " ]]; then
  step "Fix: Installing systemd units"

  for unit in apsamo-panel apsamo-realtime apsamo-worker; do
    src="$INSTALL_DIR/deploy/systemd/${unit}.service"
    dst="/etc/systemd/system/${unit}.service"
    if [[ -f "$src" ]]; then
      cp "$src" "$dst"
      sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$dst"
      # Verify replacement worked
      if grep -q "__INSTALL_DIR__" "$dst"; then
        err "Failed to replace __INSTALL_DIR__ in ${unit}.service"
        sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$dst"
      fi
      ok "Installed: ${unit}.service"
    else
      err "Source not found: $src"
    fi
  done

  systemctl daemon-reload
  ok "systemd reloaded"
fi

# ── FIX: Secrets ──────────────────────────────────────────────────────────
if [[ " ${ISSUES[@]} " =~ " secrets " ]]; then
  step "Fix: Generating missing secrets"

  JWT_SECRET=$(openssl rand -base64 32)
  ENCRYPTION_KEY=$(openssl rand -hex 32)
  CRON_API_KEY=$(openssl rand -hex 32)

  # Update .env with missing secrets
  for key_val in "JWT_SECRET=$JWT_SECRET" "ENCRYPTION_KEY=$ENCRYPTION_KEY" "CRON_API_KEY=$CRON_API_KEY"; do
    key="${key_val%%=*}"
    val="${key_val#*=}"
    if grep -q "^${key}=" "$ENV_FILE"; then
      sed -i "s|^${key}=.*|${key}=\"$val\"|" "$ENV_FILE"
    else
      echo "${key}=\"$val\"" >> "$ENV_FILE"
    fi
  done
  ok "Secrets generated + written to .env"
fi

# ── FIX: Install apsamo CLI if missing ────────────────────────────────────
if ! command -v apsamo &>/dev/null; then
  step "Fix: Installing apsamo CLI"
  cp "$INSTALL_DIR/deploy/bin/apsamo" /usr/local/bin/apsamo
  sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" /usr/local/bin/apsamo
  chmod +x /usr/local/bin/apsamo
  ok "apsamo CLI installed"
fi

# ── FINAL: Start all services ─────────────────────────────────────────────
step "Starting services"

systemctl daemon-reload
systemctl enable apsamo-panel apsamo-realtime apsamo-worker 2>/dev/null || true

# Start in order: realtime → worker → panel
systemctl restart apsamo-realtime 2>/dev/null && ok "Started: apsamo-realtime" || err "Failed: apsamo-realtime"
sleep 2
systemctl restart apsamo-worker 2>/dev/null && ok "Started: apsamo-worker" || err "Failed: apsamo-worker"
sleep 2
systemctl restart apsamo-panel 2>/dev/null && ok "Started: apsamo-panel" || err "Failed: apsamo-panel"
sleep 5

# ── VERIFY ────────────────────────────────────────────────────────────────
step "Verification"

PANEL_STATUS=$(systemctl is-active apsamo-panel 2>/dev/null || echo "unknown")
REALTIME_STATUS=$(systemctl is-active apsamo-realtime 2>/dev/null || echo "unknown")
WORKER_STATUS=$(systemctl is-active apsamo-worker 2>/dev/null || echo "unknown")

echo "  apsamo-panel:    $PANEL_STATUS"
echo "  apsamo-realtime: $REALTIME_STATUS"
echo "  apsamo-worker:   $WORKER_STATUS"

sleep 3
PANEL_HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null || echo "000")
REALTIME_HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3003/health 2>/dev/null || echo "000")
WORKER_HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3005/health 2>/dev/null || echo "000")

echo "  Panel HTTP:      $PANEL_HTTP"
echo "  Realtime HTTP:   $REALTIME_HTTP"
echo "  Worker HTTP:     $WORKER_HTTP"

echo ""
if [[ "$PANEL_STATUS" == "active" ]] && [[ "$PANEL_HTTP" == "200" ]]; then
  echo "${GREEN}${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
  echo "${GREEN}${BOLD}  ✓ FIXED — Panel is running!${NC}"
  echo "${GREEN}${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
  echo ""
  BRAND_DOMAIN=$(grep '^BRAND_DOMAIN=' "$ENV_FILE" | cut -d'"' -f2)
  echo "  ${BOLD}URL:${NC}      https://$BRAND_DOMAIN"
  echo "  ${BOLD}Verify:${NC}   apsamo verify"
  echo "  ${BOLD}Logs:${NC}     apsamo logs panel"
  echo ""
else
  echo "${RED}${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
  echo "${RED}${BOLD}  ✗ Still failing — check the error:${NC}"
  echo "${RED}${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Run the panel manually to see the error:"
  echo "    cd /opt/apsamo && bun .next/standalone/server.js"
  echo ""
  echo "  Check service logs:"
  echo "    journalctl -u apsamo-panel -n 30 --no-pager"
  echo "    journalctl -u apsamo-realtime -n 30 --no-pager"
  echo "    journalctl -u apsamo-worker -n 30 --no-pager"
fi
