#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# setup-monitoring.sh — Configure health monitoring + alerting
# ════════════════════════════════════════════════════════════════════════════
#
#   Sets up:
#     1. Cron job running health-monitor.sh every 5 minutes
#     2. Log rotation for health logs
#     3. Optional: Slack/Discord webhook alerts
#     4. Optional: Email alerts (requires mailx + SMTP)
#
#   Usage:
#     bash deploy/scripts/setup-monitoring.sh
#     bash deploy/scripts/setup-monitoring.sh --webhook https://hooks.slack.com/...
#     bash deploy/scripts/setup-monitoring.sh --email admin@yourdomain.com
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"
ENV_FILE="$INSTALL_DIR/.env"
WEBHOOK_URL=""
ALERT_EMAIL=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --webhook) WEBHOOK_URL="$2"; shift 2 ;;
    --email)   ALERT_EMAIL="$2"; shift 2 ;;
    --help|-h) grep '^#' "$0" | head -20; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Colors ────────────────────────────────────────────────────────────────
GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
step() { echo ""; echo "${BOLD}── $* ──${NC}"; }

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — Monitoring Setup${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"

if [[ $EUID -ne 0 ]]; then
  warn "Not running as root — cron setup may fail. Run with sudo."
fi

# ── Step 1: Add webhook/email to .env ─────────────────────────────────────
step "Configuring alert destinations"

if [[ -n "$WEBHOOK_URL" ]] || [[ -n "$ALERT_EMAIL" ]]; then
  if [[ -f "$ENV_FILE" ]]; then
    # Remove existing monitor vars
    sed -i '/^MONITOR_/d' "$ENV_FILE"
    # Add new ones
    echo "" >> "$ENV_FILE"
    echo "# Monitoring (auto-configured by setup-monitoring.sh)" >> "$ENV_FILE"
    [[ -n "$WEBHOOK_URL" ]] && echo "MONITOR_WEBHOOK_URL=\"$WEBHOOK_URL\"" >> "$ENV_FILE"
    [[ -n "$ALERT_EMAIL" ]] && echo "MONITOR_ALERT_EMAIL=\"$ALERT_EMAIL\"" >> "$ENV_FILE"
    ok "Alert destinations added to .env"
  else
    warn ".env not found at $ENV_FILE — skip"
  fi
else
  warn "No webhook/email provided — alerts will be syslog-only"
  warn "Re-run with: --webhook <url> or --email <addr>"
fi

# ── Step 2: Install mailx (for email alerts) ──────────────────────────────
step "Installing mailx (for email alerts)"

if [[ -n "$ALERT_EMAIL" ]] && ! command -v mail &>/dev/null; then
  apt-get install -y -qq mailutils 2>/dev/null && ok "mailutils installed" || warn "mailutils install failed — email alerts won't work"
else
  ok "mail already available (or email not configured)"
fi

# ── Step 3: Set up cron job ───────────────────────────────────────────────
step "Setting up cron job (every 5 minutes)"

CRON_CMD="*/5 * * * * $INSTALL_DIR/deploy/scripts/health-monitor.sh >> /var/log/apsamo-health.log 2>&1"

# Remove existing entry
( crontab -l 2>/dev/null | grep -v "health-monitor.sh" || true ) | crontab -

# Add new entry
( crontab -l 2>/dev/null; echo "$CRON_CMD" ) | crontab -
ok "Cron job installed — health checks run every 5 minutes"

# ── Step 4: Log rotation ──────────────────────────────────────────────────
step "Configuring log rotation"

cat > /etc/logrotate.d/apsamo-health <<EOF
/var/log/apsamo-health.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    create 0644 root root
}
EOF
ok "Log rotation configured (daily, keep 14 days)"

# ── Step 5: Run first health check ────────────────────────────────────────
step "Running first health check"

bash "$INSTALL_DIR/deploy/scripts/health-monitor.sh" 2>&1 | tail -20

echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
ok "Monitoring setup complete!"
echo ""
echo "  Health check runs: every 5 minutes (cron)"
echo "  Health log:        /var/log/apsamo-health.log"
echo "  Run manually:      bash $INSTALL_DIR/deploy/scripts/health-monitor.sh"
echo ""
if [[ -n "$WEBHOOK_URL" ]]; then
  echo "  Webhook alerts:    $WEBHOOK_URL"
fi
if [[ -n "$ALERT_EMAIL" ]]; then
  echo "  Email alerts:      $ALERT_EMAIL"
fi
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
