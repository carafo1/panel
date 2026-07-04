#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# reset.sh — COMPLETE server reset (wipe + reinstall)
# ════════════════════════════════════════════════════════════════════════════
#
#   Wipes the entire Apsamo Panel installation and reinstalls from scratch.
#   Use this when the install is broken beyond repair.
#
#   What it does:
#     1. Stops + disables all services
#     2. Optionally backs up .env (so you don't lose credentials)
#     3. Removes: /opt/apsamo, systemd units, Caddy config, logs, DB
#     4. Re-clones from GitHub
#     5. Runs install.sh fresh
#
#   ⚠️  WARNING: This deletes ALL data (database, projects, backups, storage).
#       Cannot be undone. The .env backup is the only thing preserved.
#
#   Usage:
#     bash deploy/scripts/reset.sh              # interactive
#     bash deploy/scripts/reset.sh --force      # no confirmation
#     bash deploy/scripts/reset.sh --keep-env   # preserve .env (default)
#     bash deploy/scripts/reset.sh --wipe-env   # also delete .env
#
#   After reset:
#     bash deploy/scripts/repair.sh   # fix any remaining issues
#     apsamo verify                    # verify everything works
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="/opt/apsamo"
REPO_URL="https://github.com/carafo1/panel.git"
BRANCH="main"
FORCE=0
KEEP_ENV=1

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force)      FORCE=1; shift ;;
    --keep-env)   KEEP_ENV=1; shift ;;
    --wipe-env)   KEEP_ENV=0; shift ;;
    --help|-h)    grep '^#' "$0" | head -25; exit 0 ;;
    *)            echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }
step() { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  ⚠️  APSAMO PANEL — COMPLETE SERVER RESET  ⚠️${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  This will DELETE:"
echo "    • All services (panel, realtime, worker)"
echo "    • The entire /opt/apsamo directory"
echo "    • The database (all users, projects, domains, payments)"
echo "    • All project files in storage/"
echo "    • All backups"
echo "    • Caddy config"
echo "    • systemd unit files"
echo ""

if [[ "$FORCE" == "0" ]]; then
  echo "${RED}${BOLD}  This cannot be undone. Type 'RESET' to confirm:${NC}"
  read -rp "  > " confirm
  if [[ "$confirm" != "RESET" ]]; then
    echo "  Aborted."
    exit 0
  fi
fi

if [[ $EUID -ne 0 ]]; then
  err "Run as root: sudo bash $0"
  exit 1
fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
ENV_BACKUP="/root/apsamo-env-backup-$TIMESTAMP.env"

# ════════════════════════════════════════════════════════════════════════════
# STEP 1: Back up .env (if it exists + user wants to keep it)
# ════════════════════════════════════════════════════════════════════════════
step "1/7: Backing up .env"

if [[ "$KEEP_ENV" == "1" ]] && [[ -f "$INSTALL_DIR/.env" ]]; then
  cp "$INSTALL_DIR/.env" "$ENV_BACKUP"
  chmod 600 "$ENV_BACKUP"
  ok ".env backed up to: $ENV_BACKUP"
  echo "  (contains your secrets: JWT_SECRET, ENCRYPTION_KEY, Dynadot keys, etc.)"
else
  ENV_BACKUP=""
  warn ".env will NOT be preserved (fresh secrets will be generated)"
fi

# ════════════════════════════════════════════════════════════════════════════
# STEP 2: Stop + disable all services
# ════════════════════════════════════════════════════════════════════════════
step "2/7: Stopping services"

for svc in apsamo-panel apsamo-realtime apsamo-worker; do
  systemctl stop "$svc" 2>/dev/null && ok "Stopped: $svc" || warn "$svc not running"
  systemctl disable "$svc" 2>/dev/null && ok "Disabled: $svc" || true
done

# Kill any stray processes
pkill -f "next-server" 2>/dev/null && ok "Killed: next-server" || true
pkill -f "apsamo.*index.ts" 2>/dev/null && ok "Killed: apsamo processes" || true
sleep 2

# ════════════════════════════════════════════════════════════════════════════
# STEP 3: Remove systemd units
# ════════════════════════════════════════════════════════════════════════════
step "3/7: Removing systemd units"

for unit in apsamo-panel apsamo-realtime apsamo-worker; do
  rm -f "/etc/systemd/system/${unit}.service"
done
systemctl daemon-reload
ok "Systemd units removed"

# Remove apsamo CLI
rm -f /usr/local/bin/apsamo
ok "apsamo CLI removed"

# ════════════════════════════════════════════════════════════════════════════
# STEP 4: Remove /opt/apsamo
# ════════════════════════════════════════════════════════════════════════════
step "4/7: Removing $INSTALL_DIR"

if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  ok "Removed: $INSTALL_DIR"
else
  warn "$INSTALL_DIR doesn't exist"
fi

# Also remove the DB if it's outside /opt/apsamo
rm -f /home/z/my-project/db/custom.db 2>/dev/null || true
rm -rf /home/z/my-project/db 2>/dev/null || true

# Remove logs
rm -rf /var/log/apsamo* 2>/dev/null || true
rm -f /var/log/caddy/apsamo* 2>/dev/null || true

# Remove any backup cron entries
crontab -l 2>/dev/null | grep -v "apsamo\|backup.sh\|health-monitor" | crontab - 2>/dev/null || true
ok "Removed: logs, cron entries"

# ════════════════════════════════════════════════════════════════════════════
# STEP 5: Reset Caddy config
# ════════════════════════════════════════════════════════════════════════════
step "5/7: Resetting Caddy"

if command -v caddy &>/dev/null; then
  # Back up current Caddyfile
  if [[ -f /etc/caddy/Caddyfile ]]; then
    cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.reset-backup-$TIMESTAMP"
    ok "Backed up: /etc/caddy/Caddyfile → Caddyfile.reset-backup-$TIMESTAMP"
  fi
  # Reset to empty (will be reconfigured by install.sh)
  echo "# Apsamo Panel — Caddy will be reconfigured by install.sh" > /etc/caddy/Caddyfile
  systemctl restart caddy 2>/dev/null || true
  ok "Caddy reset (will be reconfigured during install)"
else
  warn "Caddy not installed — install.sh will install it"
fi

# ════════════════════════════════════════════════════════════════════════════
# STEP 6: Re-clone from GitHub
# ════════════════════════════════════════════════════════════════════════════
step "6/7: Cloning fresh from GitHub"

echo "  Cloning: $REPO_URL (branch: $BRANCH)"
git clone -b "$BRANCH" "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/  /'

if [[ ! -d "$INSTALL_DIR" ]]; then
  err "Clone failed!"
  exit 1
fi

ok "Cloned to: $INSTALL_DIR"

# ════════════════════════════════════════════════════════════════════════════
# STEP 7: Restore .env + run install.sh
# ════════════════════════════════════════════════════════════════════════════
step "7/7: Restoring .env + running installer"

cd "$INSTALL_DIR"

# Restore .env if we backed it up
if [[ -n "$ENV_BACKUP" ]] && [[ -f "$ENV_BACKUP" ]]; then
  cp "$ENV_BACKUP" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  ok ".env restored from backup"
  echo ""
  echo "  Your existing credentials will be reused:"
  echo "    • Dynadot API keys"
  echo "    • Stripe keys (if set)"
  echo "    • SMTP settings (if set)"
  echo "    • JWT_SECRET + ENCRYPTION_KEY (existing sessions stay valid)"
  echo ""
  echo "  You'll need to provide:"
  echo "    • Brand domain"
  echo "    • Admin email + password"
  echo ""
else
  # Copy .env.example as a starting point
  cp .env.example .env
  chmod 600 .env
  ok "Fresh .env created from template"
fi

echo ""
echo "${BOLD}  ── Running install.sh ──${NC}"
echo "  (interactive — it will ask for brand domain, admin email, password)"
echo ""

# Run the installer
bash "$INSTALL_DIR/deploy/install.sh"

# ════════════════════════════════════════════════════════════════════════════
# Done
# ════════════════════════════════════════════════════════════════════════════
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${GREEN}${BOLD}  ✓ Server reset complete!${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  ${BOLD}Next steps:${NC}"
echo ""
echo "  1. Verify the install:"
echo "       apsamo verify"
echo ""
echo "  2. If any checks fail, run repair:"
echo "       bash /opt/apsamo/deploy/scripts/repair.sh"
echo ""
echo "  3. Open in browser:"
echo "       https://your-domain.com"
echo ""
if [[ -n "$ENV_BACKUP" ]]; then
  echo "  ${BOLD}.env backup:${NC} $ENV_BACKUP"
  echo "  (delete it once everything works: rm $ENV_BACKUP)"
fi
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
