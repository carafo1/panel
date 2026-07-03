#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# first-run-setup.sh — Interactive first-run setup wizard
# ════════════════════════════════════════════════════════════════════════════
#
#   Run this after install.sh if you want to:
#     • Reconfigure the brand domain (changes all DNS hostnames + emails)
#     • Change the admin email/password
#     • Set Dynadot / Stripe / SMTP / Mailcow / GitHub credentials
#     • Configure the local "localhost" server for single-box deployment
#
#   This script is idempotent — safe to run multiple times.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="/opt/apsamo"
ENV_FILE="$INSTALL_DIR/.env"

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }
step() { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }
ask()   { read -rp "$* " ans; echo "$ans"; }
ask_secret() { read -rsp "$* " ans; echo >&2; echo "$ans"; }

if [[ ! -f "$ENV_FILE" ]]; then
  err ".env not found at $ENV_FILE — run install.sh first."
  exit 1
fi

cd "$INSTALL_DIR"

# ── Helper: update or append a key in .env ────────────────────────────────
env_set() {
  local key=$1 val=$2
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=\"${val}\"|" "$ENV_FILE"
  else
    echo "${key}=\"${val}\"" >> "$ENV_FILE"
  fi
}

env_get() {
  local key=$1
  grep "^${key}=" "$ENV_FILE" | head -1 | cut -d'"' -f2
}

# ── Show current config ───────────────────────────────────────────────────
step "Current configuration"
echo "  Brand domain:     $(env_get BRAND_DOMAIN)"
echo "  Admin email:      $(env_get ADMIN_EMAIL)"
echo "  Mail server:      $(env_get MAIL_SERVER_HOSTNAME)"
echo "  NS1:              $(env_get NS1_HOSTNAME)"
echo "  NS2:              $(env_get NS2_HOSTNAME)"
echo "  SMTP host:        $(env_get SMTP_HOST)"
echo "  Mailcow URL:      $(env_get MAILCOW_API_URL)"
echo "  Dynadot key:      $(env_get DYNADOT_API_KEY | head -c 12)..."
echo "  Stripe key:       $(env_get STRIPE_SECRET_KEY | head -c 12)..."
echo "  GitHub client ID: $(env_get GITHUB_CLIENT_ID)"
echo ""

read -rp "${BOLD}Reconfigure? [y/N]:${NC} " confirm
[[ "$confirm" =~ ^[Yy] ]] || { echo "Aborted."; exit 0; }

# ── Brand domain ──────────────────────────────────────────────────────────
step "Brand domain"
CURRENT=$(env_get BRAND_DOMAIN)
NEW=$(ask "${BOLD}Brand domain${NC} [current: $CURRENT]:")
if [[ -n "$NEW" ]] && [[ "$NEW" != "$CURRENT" ]]; then
  env_set BRAND_DOMAIN "$NEW"
  env_set APP_URL "https://$NEW"
  env_set NEXT_PUBLIC_APP_URL "https://$NEW"
  env_set NEXTAUTH_URL "https://$NEW"
  env_set APP_SUBDOMAIN_PATTERN "{slug}.$NEW"
  env_set NS1_HOSTNAME "ns1.$NEW"
  env_set NS2_HOSTNAME "ns2.$NEW"
  env_set MAIL_SERVER_HOSTNAME "mail.$NEW"
  env_set NO_REPLY_EMAIL "no-reply@$NEW"
  env_set SUPPORT_EMAIL "support@$NEW"
  env_set BILLING_EMAIL "billing@$NEW"
  ok "Brand domain updated → $NEW (all derived hostnames/emails updated too)"
fi

# ── Admin user ────────────────────────────────────────────────────────────
step "Admin user"
CURRENT=$(env_get ADMIN_EMAIL)
NEW=$(ask "${BOLD}Admin email${NC} [current: $CURRENT]:")

NEW_PASS=""
if [[ -n "$NEW" ]] && [[ "$NEW" != "$CURRENT" ]]; then
  env_set ADMIN_EMAIL "$NEW"
  NEW_PASS=$(ask_secret "${BOLD}Admin password${NC} (min 8 chars):")
  if [[ ${#NEW_PASS} -lt 8 ]]; then
    err "Password too short — skipping admin user update"
  else
    ok "Will create/reset admin user"
  fi
else
  read -rp "${BOLD}Reset admin password?${NC} [y/N]: " reset_pw
  if [[ "$reset_pw" =~ ^[Yy] ]]; then
    NEW_PASS=$(ask_secret "${BOLD}New admin password${NC}:")
    if [[ ${#NEW_PASS} -ge 8 ]]; then
      ok "Will reset admin password"
    else
      err "Password too short — skipping"
      NEW_PASS=""
    fi
  fi
fi

# ── Dynadot ───────────────────────────────────────────────────────────────
step "Dynadot (domain registrar)"
CURRENT=$(env_get DYNADOT_API_KEY)
NEW=$(ask "${BOLD}Dynadot API key${NC} [current: ${CURRENT:0:12}...]:")
[[ -n "$NEW" ]] && env_set DYNADOT_API_KEY "$NEW" && ok "Dynadot API key set"

CURRENT=$(env_get DYNADOT_SECRET_KEY)
NEW=$(ask "${BOLD}Dynadot secret key${NC} [current: ${CURRENT:0:12}...]:")
[[ -n "$NEW" ]] && env_set DYNADOT_SECRET_KEY "$NEW" && ok "Dynadot secret key set"

# ── Stripe ────────────────────────────────────────────────────────────────
step "Stripe (billing)"
NEW=$(ask "${BOLD}Stripe secret key${NC} (sk_...):")
[[ -n "$NEW" ]] && env_set STRIPE_SECRET_KEY "$NEW" && ok "Stripe secret key set"

NEW=$(ask "${BOLD}Stripe webhook secret${NC} (whsec_...):")
[[ -n "$NEW" ]] && env_set STRIPE_WEBHOOK_SECRET "$NEW" && ok "Stripe webhook secret set"

NEW=$(ask "${BOLD}Stripe default price ID${NC} (price_...):")
[[ -n "$NEW" ]] && env_set STRIPE_PRICE_ID_DEFAULT "$NEW" && ok "Stripe default price ID set"

# ── SMTP ──────────────────────────────────────────────────────────────────
step "SMTP (outgoing email)"
NEW=$(ask "${BOLD}SMTP host${NC} [current: $(env_get SMTP_HOST)]:")
[[ -n "$NEW" ]] && env_set SMTP_HOST "$NEW" && ok "SMTP host set"

NEW=$(ask "${BOLD}SMTP port${NC} [current: $(env_get SMTP_PORT)]:")
[[ -n "$NEW" ]] && env_set SMTP_PORT "$NEW" && ok "SMTP port set"

NEW=$(ask "${BOLD}SMTP user${NC} [current: $(env_get SMTP_USER)]:")
[[ -n "$NEW" ]] && env_set SMTP_USER "$NEW" && ok "SMTP user set"

NEW=$(ask_secret "${BOLD}SMTP password${NC} (hidden):")
[[ -n "$NEW" ]] && env_set SMTP_PASS "$NEW" && ok "SMTP password set"

# ── Mailcow ───────────────────────────────────────────────────────────────
step "Mailcow (email hosting)"
NEW=$(ask "${BOLD}Mailcow API URL${NC} [current: $(env_get MAILCOW_API_URL)]:")
[[ -n "$NEW" ]] && env_set MAILCOW_API_URL "$NEW" && ok "Mailcow URL set"

NEW=$(ask "${BOLD}Mailcow API key${NC}:")
[[ -n "$NEW" ]] && env_set MAILCOW_API_KEY "$NEW" && ok "Mailcow API key set"

# ── GitHub OAuth ──────────────────────────────────────────────────────────
step "GitHub OAuth"
NEW=$(ask "${BOLD}GitHub client ID${NC} [current: $(env_get GITHUB_CLIENT_ID)]:")
[[ -n "$NEW" ]] && env_set GITHUB_CLIENT_ID "$NEW" && ok "GitHub client ID set"

NEW=$(ask_secret "${BOLD}GitHub client secret${NC} (hidden):")
[[ -n "$NEW" ]] && env_set GITHUB_CLIENT_SECRET "$NEW" && ok "GitHub client secret set"

# ── Configure localhost server for single-box deployment ─────────────────
step "Localhost server (single-box deployment)"
read -rp "${BOLD}Set up localhost server for single-box deployment?${NC} [Y/n]: " setup_local
setup_local="${setup_local:-y}"
if [[ "$setup_local" =~ ^[Yy] ]]; then
  bun -e "
const { db } = require('./src/lib/db');
(async () => {
  const existing = await db.server.findFirst({ where: { sshHost: 'localhost' } });
  if (existing) {
    console.log('localhost server already exists:', existing.id);
    process.exit(0);
  }
  const s = await db.server.create({
    data: {
      name: 'Localhost (this server)',
      ip: '127.0.0.1',
      provider: 'local',
      status: 'active',
      cpuCores: $(nproc 2>/dev/null || echo 4),
      ramGB: $(awk '/MemTotal/ {printf "%d", \$2/1024/1024}' /proc/meminfo 2>/dev/null || echo 4),
      storageGB: $(df -BG / | awk 'NR==2 {print \$2}' | tr -d 'G' || echo 50),
      bandwidthGB: 1000,
      usedRamGB: 0,
      usedStorageGB: 0,
      region: 'local',
      sshHost: 'localhost',
      sshPort: 22,
      sshUser: 'root',
      dockerInstalled: true,
      caddyInstalled: true,
      healthStatus: 'healthy',
    },
  });
  console.log('localhost server created:', s.id);
  process.exit(0);
})();
"
  ok "Localhost server configured — projects deployed here will use LocalClient (no SSH/Docker required)"
fi

# ── Apply: create/reset admin user ────────────────────────────────────────
if [[ -n "$NEW_PASS" ]]; then
  step "Applying admin user changes"
  ADMIN_EMAIL=$(env_get ADMIN_EMAIL)
  bash "$INSTALL_DIR/deploy/bin/apsamo" create-admin "$ADMIN_EMAIL" "$NEW_PASS"
fi

# ── Restart services ──────────────────────────────────────────────────────
step "Restarting services"
for svc in apsamo-realtime apsamo-worker apsamo-panel; do
  systemctl restart "$svc" && ok "$svc restarted"
done

echo ""
echo "${BOLD}══════════════════════════════════════════════${NC}"
ok "Setup complete!"
echo ""
echo "  Admin URL:   $(env_get APP_URL)"
echo "  Admin email: $(env_get ADMIN_EMAIL)"
echo ""
echo "  Test domain search:  apsamo db-shell"
echo "                       (then run: SELECT * FROM Domain; )"
echo ""
echo "  Open the panel and verify everything works."
