#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# deploy.sh — Deploy Apsamo Panel to a fresh VPS from your laptop
# ════════════════════════════════════════════════════════════════════════════
#
#   This script automates the full deployment workflow:
#     1. SSH into a fresh VPS (you provide the IP)
#     2. Copy your local .env.production → /root/apsamo-config.env
#     3. Clone the panel repo
#     4. Run install.sh non-interactively
#     5. Wait for panel to come up
#     6. Verify the deployment
#     7. Print the admin URL + credentials
#
#   Usage:
#     ./deploy.sh <vps-ip> [ssh-key-path]
#
#   Example:
#     ./deploy.sh 203.0.113.5
#     ./deploy.sh 203.0.113.5 ~/.ssh/id_ed25519
#
#   Prerequisites:
#     • A fresh Ubuntu 22.04+ VPS with SSH root access
#     • A `.env.production` file in deploy/ with required vars
#       (copy .env.production.example → .env.production and edit)
#     • DNS A records pointing your brand domain at the VPS IP
#
#   To create a VPS first, use one of:
#     • Hetzner:    terraform apply in deploy/terraform/hetzner/
#     • DigitalOcean: terraform apply in deploy/terraform/digitalocean/
#     • Or any provider's web UI (manual)
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }
step() { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }

# ── Args ──────────────────────────────────────────────────────────────────
VPS_IP="${1:-}"
SSH_KEY="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_PROD="$SCRIPT_DIR/.env.production"

if [[ -z "$VPS_IP" ]]; then
  err "Usage: $0 <vps-ip> [ssh-key-path]"
  echo ""
  echo "Example:"
  echo "  $0 203.0.113.5"
  echo "  $0 203.0.113.5 ~/.ssh/id_ed25519"
  echo ""
  echo "Make sure you have a .env.production file at:"
  echo "  $SCRIPT_DIR/.env.production"
  echo "Copy from: $SCRIPT_DIR/.env.production.example"
  exit 1
fi

if [[ ! -f "$ENV_PROD" ]]; then
  err ".env.production not found at $ENV_PROD"
  echo ""
  echo "Copy the example and edit:"
  echo "  cp $SCRIPT_DIR/.env.production.example $ENV_PROD"
  echo "  nano $ENV_PROD"
  exit 1
fi

# Build SSH options
SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10)
if [[ -n "$SSH_KEY" ]]; then
  [[ -f "$SSH_KEY" ]] || { err "SSH key not found: $SSH_KEY"; exit 1; }
  SSH_OPTS+=(-i "$SSH_KEY")
fi
SSH_CMD=(ssh "${SSH_OPTS[@]}" root@"$VPS_IP")
SCP_CMD=(scp "${SSH_OPTS[@]}")

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — Remote Deploy${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  VPS IP:      $VPS_IP"
echo "  SSH key:     ${SSH_KEY:-default}"
echo "  Config file: $ENV_PROD"
echo "  Started:     $(date)"
echo ""

# ── Step 1: Test SSH connection ───────────────────────────────────────────
step "Testing SSH connection to root@$VPS_IP"
if "${SSH_CMD[@]}" "echo OK"; then
  ok "SSH connection works"
else
  err "Cannot SSH to root@$VPS_IP — check IP and SSH key"
  exit 1
fi

# ── Step 2: Verify it's a fresh Ubuntu/Debian VPS ─────────────────────────
step "Verifying OS"
OS_INFO=$("${SSH_CMD[@]}" "cat /etc/os-release 2>/dev/null | head -3")
echo "$OS_INFO" | head -3
if ! echo "$OS_INFO" | grep -qE 'ubuntu|debian'; then
  warn "OS doesn't look like Ubuntu/Debian — install may fail"
  read -rp "Continue anyway? [y/N]: " confirm
  [[ "$confirm" =~ ^[Yy] ]] || { echo "Aborted."; exit 0; }
fi

# ── Step 3: Upload .env.production → /root/apsamo-config.env ─────────────
step "Uploading configuration"
"${SCP_CMD[@]}" "$ENV_PROD" root@"$VPS_IP":/root/apsamo-config.env 2>&1 | sed 's/^/  /'
"${SSH_CMD[@]}" "chmod 600 /root/apsamo-config.env"
ok "Configuration uploaded"

# ── Step 4: Source config + check required fields ────────────────────────
step "Validating configuration"
"${SSH_CMD[@]}" '
  set -a && . /root/apsamo-config.env && set +a
  if [ -z "${APSAMO_BRAND_DOMAIN}" ] || [ -z "${APSAMO_ADMIN_EMAIL}" ] || [ -z "${APSAMO_ADMIN_PASS}" ]; then
    echo "FATAL: APSAMO_BRAND_DOMAIN, APSAMO_ADMIN_EMAIL, APSAMO_ADMIN_PASS are all required"
    exit 1
  fi
  if [ ${#APSAMO_ADMIN_PASS} -lt 8 ]; then
    echo "FATAL: APSAMO_ADMIN_PASS must be at least 8 characters"
    exit 1
  fi
  echo "Brand domain: $APSAMO_BRAND_DOMAIN"
  echo "Admin email:  $APSAMO_ADMIN_EMAIL"
  echo "Admin pass:   (hidden, ${#APSAMO_ADMIN_PASS} chars)"
' 2>&1 | sed 's/^/  /'

if [[ $? -ne 0 ]]; then
  err "Configuration validation failed"
  exit 1
fi
ok "Configuration valid"

# ── Step 5: Check DNS is pointing at this VPS ────────────────────────────
step "Checking DNS resolution"
BRAND_DOMAIN=$("${SSH_CMD[@]}" '. /root/apsamo-config.env && echo $APSAMO_BRAND_DOMAIN')
DNS_IP=$(dig +short "$BRAND_DOMAIN" 2>/dev/null || nslookup "$BRAND_DOMAIN" 2>/dev/null | awk '/Address: / {print $2}' | tail -1)

if [[ -z "$DNS_IP" ]]; then
  warn "Cannot resolve $BRAND_DOMAIN — DNS not configured yet"
  warn "SSL will fail to provision. Set up DNS A record → $VPS_IP and re-run."
  read -rp "Continue anyway? [y/N]: " confirm
  [[ "$confirm" =~ ^[Yy] ]] || { echo "Aborted."; exit 0; }
elif [[ "$DNS_IP" != "$VPS_IP" ]]; then
  warn "DNS for $BRAND_DOMAIN resolves to $DNS_IP (expected $VPS_IP)"
  warn "SSL will fail to provision. Update the A record and re-run."
  read -rp "Continue anyway? [y/N]: " confirm
  [[ "$confirm" =~ ^[Yy] ]] || { echo "Aborted."; exit 0; }
else
  ok "DNS: $BRAND_DOMAIN → $VPS_IP ✓"
fi

# ── Step 6: Run installer remotely ────────────────────────────────────────
step "Running installer on VPS (this takes ~10 minutes)"

# Install dig if missing (for DNS check)
"${SSH_CMD[@]}" "command -v dnsutils >/dev/null 2>&1 || apt-get install -y -qq dnsutils 2>/dev/null || true" 2>&1 | sed 's/^/  /'

# Clone the panel repo (skip if already present)
"${SSH_CMD[@]}" '
  set -a && . /root/apsamo-config.env && set +a
  if [ ! -d /opt/apsamo ]; then
    echo "[deploy] cloning panel repo..."
    REPO_URL="${APSAMO_REPO_URL:-https://github.com/carafo1/panel.git}"
    if [ -n "${APSAMO_GITHUB_TOKEN}" ]; then
      REPO_URL=$(echo "${REPO_URL}" | sed "s|https://github.com|https://${APSAMO_GITHUB_TOKEN}@github.com|")
    fi
    BRANCH="${APSAMO_REPO_BRANCH:-main}"
    git clone -b "$BRANCH" "$REPO_URL" /opt/apsamo
  fi
' 2>&1 | sed 's/^/  /'
ok "Panel repo ready at /opt/apsamo"

# Run install.sh non-interactively
"${SSH_CMD[@]}" '
  set -a && . /root/apsamo-config.env && set +a
  cd /opt/apsamo

  echo "[deploy] running install.sh..."
  BRAND_DOMAIN="${APSAMO_BRAND_DOMAIN}" \
  ADMIN_EMAIL="${APSAMO_ADMIN_EMAIL}" \
  ADMIN_PASSWORD="${APSAMO_ADMIN_PASS}" \
  INSTALL_MAILCOW=$([ "${APSAMO_INSTALL_MAILCOW}" = "true" ] && echo "y" || echo "n") \
  DYNADOT_API_KEY="${APSAMO_DYNADOT_API_KEY}" \
  STRIPE_SECRET_KEY="${APSAMO_STRIPE_SECRET_KEY}" \
  SMTP_HOST="${APSAMO_SMTP_HOST}" \
  SMTP_USER="${APSAMO_SMTP_USER}" \
  SMTP_PASS="${APSAMO_SMTP_PASS}" \
  bash /opt/apsamo/deploy/install.sh
' 2>&1 | sed 's/^/  /'

if [[ $? -ne 0 ]]; then
  err "Installer failed. SSH in and check /var/log/apsamo-install.log"
  exit 1
fi
ok "Installer completed"

# ── Step 7: Apply optional credentials ────────────────────────────────────
step "Applying optional credentials"
"${SSH_CMD[@]}" '
  set -a && . /root/apsamo-config.env && set +a
  ENV=/opt/apsamo/.env
  [ -n "${APSAMO_DYNADOT_SECRET_KEY}" ]      && sed -i "s|^DYNADOT_SECRET_KEY=.*|DYNADOT_SECRET_KEY=\"${APSAMO_DYNADOT_SECRET_KEY}\"|" $ENV
  [ -n "${APSAMO_STRIPE_WEBHOOK_SECRET}" ]   && sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=\"${APSAMO_STRIPE_WEBHOOK_SECRET}\"|" $ENV
  [ -n "${APSAMO_STRIPE_PRICE_ID_DEFAULT}" ] && sed -i "s|^STRIPE_PRICE_ID_DEFAULT=.*|STRIPE_PRICE_ID_DEFAULT=\"${APSAMO_STRIPE_PRICE_ID_DEFAULT}\"|" $ENV
  [ -n "${APSAMO_MAILCOW_API_URL}" ]         && sed -i "s|^MAILCOW_API_URL=.*|MAILCOW_API_URL=\"${APSAMO_MAILCOW_API_URL}\"|" $ENV
  [ -n "${APSAMO_MAILCOW_API_KEY}" ]         && sed -i "s|^MAILCOW_API_KEY=.*|MAILCOW_API_KEY=\"${APSAMO_MAILCOW_API_KEY}\"|" $ENV
  [ -n "${APSAMO_GITHUB_CLIENT_ID}" ]        && sed -i "s|^GITHUB_CLIENT_ID=.*|GITHUB_CLIENT_ID=\"${APSAMO_GITHUB_CLIENT_ID}\"|" $ENV
  [ -n "${APSAMO_GITHUB_CLIENT_SECRET}" ]    && sed -i "s|^GITHUB_CLIENT_SECRET=.*|GITHUB_CLIENT_SECRET=\"${APSAMO_GITHUB_CLIENT_SECRET}\"|" $ENV
  [ -n "${APSAMO_SMTP_PORT}" ]               && sed -i "s|^SMTP_PORT=.*|SMTP_PORT=\"${APSAMO_SMTP_PORT}\"|" $ENV
  systemctl restart apsamo-panel apsamo-realtime apsamo-worker
' 2>&1 | sed 's/^/  /'
ok "Credentials applied"

# ── Step 8: Create localhost server ──────────────────────────────────────
step "Creating localhost server (for single-box deployment)"
"${SSH_CMD[@]}" '
  cd /opt/apsamo
  bun -e "
  const { db } = require(\"./src/lib/db\");
  (async () => {
    const existing = await db.server.findFirst({ where: { sshHost: \"localhost\" } });
    if (existing) { console.log(\"localhost server already exists\"); process.exit(0); }
    await db.server.create({
      data: {
        name: \"Localhost (this server)\",
        ip: \"127.0.0.1\",
        provider: \"local\",
        status: \"active\",
        cpuCores: $(nproc),
        ramGB: $(awk \"/MemTotal/ {printf \\\"%d\\\", \\\$2/1024/1024}\" /proc/meminfo),
        storageGB: $(df -BG / | awk \"NR==2 {gsub(/G/, \\\"\\\", \\\$2); print \\\$2}\"),
        bandwidthGB: 1000,
        usedRamGB: 0,
        usedStorageGB: 0,
        region: \"local\",
        sshHost: \"localhost\",
        sshPort: 22,
        sshUser: \"root\",
        dockerInstalled: true,
        caddyInstalled: true,
        healthStatus: \"healthy\",
      },
    });
    console.log(\"localhost server created\");
    process.exit(0);
  })();
  "
' 2>&1 | sed 's/^/  /'
ok "Localhost server ready"

# ── Step 9: Wait for panel to come up ────────────────────────────────────
step "Waiting for panel to come up"
for i in 1 2 3 4 5 6 7 8 9 10; do
  HTTP_CODE=$("${SSH_CMD[@]}" "curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    ok "Panel is up (HTTP 200)"
    break
  fi
  echo "  attempt $i: HTTP $HTTP_CODE — waiting 5s..."
  sleep 5
done

# ── Step 10: Verify with HTTPS (let Caddy provision SSL) ─────────────────
step "Triggering SSL cert provisioning"
HTTPS_CODE=$(curl -s -o /dev/null -w '%{http_code}' "https://$BRAND_DOMAIN/" 2>/dev/null || echo "000")
if [[ "$HTTPS_CODE" == "200" ]] || [[ "$HTTPS_CODE" == "301" ]] || [[ "$HTTPS_CODE" == "302" ]]; then
  ok "HTTPS working (HTTP $HTTPS_CODE) — SSL cert provisioned"
elif [[ "$HTTPS_CODE" == "000" ]]; then
  warn "HTTPS not yet reachable — SSL cert may still be provisioning (takes ~30s)"
  warn "Try again in a minute: curl -I https://$BRAND_DOMAIN"
else
  warn "HTTPS returned HTTP $HTTPS_CODE — check Caddy: ssh root@$VPS_IP 'journalctl -u caddy -n 50'"
fi

# ── Step 11: Run remote doctor ────────────────────────────────────────────
step "Remote doctor check"
"${SSH_CMD[@]}" "apsamo doctor" 2>&1 | sed 's/^/  /' | tail -40

# ── Step 12: Print summary ────────────────────────────────────────────────
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${GREEN}${BOLD}  ✓ Deploy complete!${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  ${BOLD}Panel URL:${NC}      https://$BRAND_DOMAIN"
echo "  ${BOLD}Admin email:${NC}    $(grep '^APSAMO_ADMIN_EMAIL=' "$ENV_PROD" | cut -d'"' -f2)"
echo "  ${BOLD}Admin password:${NC} (from your .env.production)"
echo ""
echo "  ${BOLD}Server IP:${NC}      $VPS_IP"
echo "  ${BOLD}SSH:${NC}            ssh root@$VPS_IP"
echo "  ${BOLD}Logs:${NC}           ssh root@$VPS_IP 'apsamo logs panel'"
echo "  ${BOLD}Status:${NC}         ssh root@$VPS_IP 'apsamo status'"
echo "  ${BOLD}Doctor:${NC}         ssh root@$VPS_IP 'apsamo doctor'"
echo ""
echo "  ${BOLD}Next steps:${NC}"
echo "    1. Open https://$BRAND_DOMAIN in your browser"
echo "    2. Log in with the admin credentials"
echo "    3. Set up Stripe webhooks: https://$BRAND_DOMAIN/api/billing/webhook"
echo "    4. Configure GitHub OAuth callback: https://$BRAND_DOMAIN/api/github/oauth/callback"
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
