#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# repair.sh — Fix broken systemd units + restart all services
# ════════════════════════════════════════════════════════════════════════════
#
#   Fixes the most common install issues:
#     1. __INSTALL_DIR__ placeholder not replaced in systemd units
#     2. apsamo CLI has __INSTALL_DIR__ placeholder
#     3. Missing logs directory
#     4. Missing database
#     5. Services not started
#
#   Usage (on your VPS as root):
#     curl -fsSL https://raw.githubusercontent.com/carafo1/panel/main/deploy/scripts/repair.sh | bash
#   Or:
#     bash /opt/apsamo/deploy/scripts/repair.sh
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }
step() { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — Repair Script${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"

if [[ $EUID -ne 0 ]]; then
  err "Run as root: sudo bash $0"
  exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  err "Install dir $INSTALL_DIR not found. Is the panel installed?"
  exit 1
fi

cd "$INSTALL_DIR"

# ── Step 1: Fix systemd unit files ────────────────────────────────────────
step "1/6: Fixing systemd unit files"

FIXED_UNITS=0
for unit in apsamo-panel apsamo-realtime apsamo-worker; do
  FILE="/etc/systemd/system/${unit}.service"
  if [[ -f "$FILE" ]]; then
    if grep -q "__INSTALL_DIR__" "$FILE"; then
      sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$FILE"
      ok "Fixed: $unit.service"
      FIXED_UNITS=$((FIXED_UNITS + 1))
    else
      ok "Already OK: $unit.service"
    fi
  else
    # Unit file missing — copy from repo
    if [[ -f "$INSTALL_DIR/deploy/systemd/${unit}.service" ]]; then
      cp "$INSTALL_DIR/deploy/systemd/${unit}.service" "$FILE"
      sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$FILE"
      ok "Created: $unit.service (from repo)"
      FIXED_UNITS=$((FIXED_UNITS + 1))
    else
      warn "Missing: $unit.service (not in repo either)"
    fi
  fi
done

systemctl daemon-reload
ok "systemd reloaded ($FIXED_UNITS units fixed)"

# ── Step 2: Fix apsamo CLI ────────────────────────────────────────────────
step "2/6: Fixing apsamo CLI"

CLI_PATH="/usr/local/bin/apsamo"
if [[ -f "$CLI_PATH" ]]; then
  if grep -q "__INSTALL_DIR__" "$CLI_PATH"; then
    sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$CLI_PATH"
    chmod +x "$CLI_PATH"
    ok "Fixed: apsamo CLI"
  else
    ok "apsamo CLI already OK"
  fi
else
  if [[ -f "$INSTALL_DIR/deploy/bin/apsamo" ]]; then
    cp "$INSTALL_DIR/deploy/bin/apsamo" "$CLI_PATH"
    sed -i "s|__INSTALL_DIR__|$INSTALL_DIR|g" "$CLI_PATH"
    chmod +x "$CLI_PATH"
    ok "Installed: apsamo CLI"
  else
    warn "apsamo CLI not found in repo"
  fi
fi

# ── Step 3: Create missing directories ────────────────────────────────────
step "3/6: Creating missing directories"

mkdir -p "$INSTALL_DIR/logs"
mkdir -p "$INSTALL_DIR/db"
mkdir -p "$INSTALL_DIR/storage"
mkdir -p "$INSTALL_DIR/backups"
ok "Directories ready (logs, db, storage, backups)"

# ── Step 4: Fix database if missing ───────────────────────────────────────
step "4/6: Checking database"

DB_URL=$(grep '^DATABASE_URL=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'"' -f2)
DB_PATH="${DB_URL#file:}"
DB_PATH="${DB_PATH:-$INSTALL_DIR/db/custom.db}"

if [[ ! -f "$DB_PATH" ]]; then
  warn "Database not found at $DB_PATH — creating..."
  mkdir -p "$(dirname "$DB_PATH")"

  # Check if bun is available
  if command -v bun &>/dev/null; then
    ok "Running db:push..."
    bun run db:push 2>&1 | tail -5 || err "db:push failed"

    ok "Seeding database..."
    bun run scripts/run-seed.ts 2>&1 | tail -5 || warn "run-seed failed"
    bun run scripts/seed-templates-and-payment.ts 2>&1 | tail -5 || warn "seed-templates failed"
    ok "Database created + seeded"
  else
    err "bun not found — install it: curl -fsSL https://bun.sh/install | bash"
  fi
else
  DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
  ok "Database exists: $DB_PATH ($DB_SIZE)"
fi

# ── Step 5: Verify .env has required secrets ──────────────────────────────
step "5/6: Verifying .env"

ENV_OK=true
for key in JWT_SECRET ENCRYPTION_KEY CRON_API_KEY; do
  val=$(grep "^${key}=" "$INSTALL_DIR/.env" 2>/dev/null | cut -d'"' -f2)
  if [[ -z "$val" ]] || [[ "$val" == *"replace-with"* ]]; then
    err "$key is missing or placeholder"
    ENV_OK=false
  fi
done

if [[ "$ENV_OK" == "true" ]]; then
  ok "All required secrets present"
else
  warn "Some secrets missing — generating..."
  JWT_SECRET=$(openssl rand -base64 32)
  ENCRYPTION_KEY=$(openssl rand -hex 32)
  CRON_API_KEY=$(openssl rand -hex 32)

  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=\"$JWT_SECRET\"|" "$INSTALL_DIR/.env"
  sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=\"$ENCRYPTION_KEY\"|" "$INSTALL_DIR/.env"
  sed -i "s|^CRON_API_KEY=.*|CRON_API_KEY=\"$CRON_API_KEY\"|" "$INSTALL_DIR/.env"
  ok "Secrets generated + written to .env"
fi

chmod 600 "$INSTALL_DIR/.env"
ok ".env permissions: 600"

# ── Step 6: Restart all services ──────────────────────────────────────────
step "6/6: Restarting services"

# Enable on boot
systemctl enable apsamo-panel apsamo-realtime apsamo-worker 2>/dev/null || true

# Start in order: realtime → worker → panel
systemctl restart apsamo-realtime 2>/dev/null && ok "Started: apsamo-realtime" || err "Failed: apsamo-realtime"
sleep 2
systemctl restart apsamo-worker 2>/dev/null && ok "Started: apsamo-worker" || err "Failed: apsamo-worker"
sleep 2
systemctl restart apsamo-panel 2>/dev/null && ok "Started: apsamo-panel" || err "Failed: apsamo-panel"
sleep 5

# ── Verify ────────────────────────────────────────────────────────────────
step "Verification"

PANEL_STATUS=$(systemctl is-active apsamo-panel 2>/dev/null || echo "unknown")
REALTIME_STATUS=$(systemctl is-active apsamo-realtime 2>/dev/null || echo "unknown")
WORKER_STATUS=$(systemctl is-active apsamo-worker 2>/dev/null || echo "unknown")

echo "  apsamo-panel:    $PANEL_STATUS"
echo "  apsamo-realtime: $REALTIME_STATUS"
echo "  apsamo-worker:   $WORKER_STATUS"

# HTTP checks
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
  echo "${GREEN}${BOLD}  ✓ Repair complete — panel is running!${NC}"
  echo "${GREEN}${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Run full verification:  apsamo verify"
  echo "  Open in browser:        https://$(grep '^BRAND_DOMAIN=' $INSTALL_DIR/.env | cut -d'"' -f2)"
  echo ""
else
  echo "${RED}${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
  echo "${RED}${BOLD}  ✗ Some services still failing${NC}"
  echo "${RED}${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
  echo ""
  echo "  Check logs:"
  echo "    journalctl -u apsamo-panel -n 30 --no-pager"
  echo "    journalctl -u apsamo-realtime -n 30 --no-pager"
  echo "    journalctl -u apsamo-worker -n 30 --no-pager"
  echo ""
  echo "  Or run: apsamo doctor"
fi
