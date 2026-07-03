#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# health-monitor.sh — Continuous health monitoring + alerting
# ════════════════════════════════════════════════════════════════════════════
#
#   Runs as a cron job (every 5 minutes). Checks:
#     1. Panel HTTP response (port 3000)
#     2. Realtime service (port 3003)
#     3. Worker service (port 3005)
#     4. Database connectivity
#     5. Disk space (alert if < 10% free)
#     6. Memory usage (alert if > 90%)
#     7. SSL cert expiry (alert if < 14 days)
#     8. Backup freshness (alert if no backup in 48h)
#
#   Alerts are sent via:
#     - Email (if SMTP configured)
#     - Webhook (if MONITOR_WEBHOOK_URL set)
#     - Syslog (always)
#
#   Setup:
#     # Add to crontab (every 5 minutes):
#     */5 * * * * /opt/apsamo/deploy/scripts/health-monitor.sh >> /var/log/apsamo-health.log 2>&1
#
#   Environment variables (in /opt/apsamo/.env):
#     MONITOR_WEBHOOK_URL  — Slack/Discord/Teams incoming webhook URL
#     MONITOR_ALERT_EMAIL  — email to alert (defaults to ADMIN_EMAIL)
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"
ENV_FILE="$INSTALL_DIR/.env"
ALERTS_SENT=0

# Load env
if [[ -f "$ENV_FILE" ]]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

# ── Colors (disabled when run by cron) ────────────────────────────────────
if [[ -t 1 ]]; then
  RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; NC=''
fi

log()    { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }
alert()  { echo "${RED}[ALERT]${NC} $*"; ALERTS_SENT=$((ALERTS_SENT + 1)); send_alert "$*"; }
warn()   { echo "${YELLOW}[WARN]${NC} $*"; }
ok()     { echo "${GREEN}[OK]${NC} $*"; }

# ── Alert delivery ────────────────────────────────────────────────────────
send_alert() {
  local message=$1
  local hostname=$(hostname)
  local timestamp=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

  # Syslog (always)
  logger -t apsamo-monitor "$message" 2>/dev/null || true

  # Webhook (Slack/Discord/Teams)
  if [[ -n "${MONITOR_WEBHOOK_URL:-}" ]]; then
    curl -s -X POST "$MONITOR_WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "{\"text\":\"🚨 Apsamo Panel Alert\",\"attachments\":[{\"color\":\"danger\",\"fields\":[{\"title\":\"Host\",\"value\":\"$hostname\",\"short\":true},{\"title\":\"Time\",\"value\":\"$timestamp\",\"short\":true},{\"title\":\"Alert\",\"value\":\"$message\",\"short\":false}]}]}" \
      > /dev/null 2>&1 || true
  fi

  # Email (if SMTP configured)
  if [[ -n "${MONITOR_ALERT_EMAIL:-${ADMIN_EMAIL:-}}" ]] && command -v mail &>/dev/null; then
    echo "$message" | mail -s "🚨 Apsamo Panel Alert: $hostname" "${MONITOR_ALERT_EMAIL:-$ADMIN_EMAIL}" 2>/dev/null || true
  fi
}

# ── Check 1: Panel HTTP ───────────────────────────────────────────────────
check_panel_http() {
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 http://localhost:3000/ 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    ok "Panel HTTP: 200"
  else
    alert "Panel HTTP: $http_code (expected 200) — panel may be down"
  fi
}

# ── Check 2: Realtime service ─────────────────────────────────────────────
check_realtime() {
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3003/health 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    ok "Realtime: 200"
  else
    alert "Realtime: $http_code (expected 200) — Socket.IO service may be down"
  fi
}

# ── Check 3: Worker service ───────────────────────────────────────────────
check_worker() {
  local http_code
  http_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:3005/health 2>/dev/null || echo "000")
  if [[ "$http_code" == "200" ]]; then
    ok "Worker: 200"
  else
    alert "Worker: $http_code (expected 200) — cron job service may be down"
  fi
}

# ── Check 4: Database connectivity ────────────────────────────────────────
check_db() {
  cd "$INSTALL_DIR"
  local result
  result=$(bun -e "
const { db } = require('./src/lib/db');
db.\$queryRaw\`SELECT 1 as ok\`.then(() => { console.log('OK'); process.exit(0); }).catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
" 2>&1 || echo "FAIL")

  if echo "$result" | grep -q "OK"; then
    ok "Database: connected"
  else
    alert "Database: connection failed — $result"
  fi
}

# ── Check 5: Disk space ───────────────────────────────────────────────────
check_disk() {
  local free_pct
  free_pct=$(df / | awk 'NR==2 {printf "%.0f", $4 / $2 * 100}')
  if [[ "$free_pct" -lt 10 ]]; then
    alert "Disk: only ${free_pct}% free — immediate action required"
  elif [[ "$free_pct" -lt 20 ]]; then
    warn "Disk: ${free_pct}% free — cleanup recommended"
  else
    ok "Disk: ${free_pct}% free"
  fi
}

# ── Check 6: Memory ───────────────────────────────────────────────────────
check_memory() {
  local used_pct
  used_pct=$(free | awk '/Mem:/ {printf "%.0f", $3 / $2 * 100}')
  if [[ "$used_pct" -gt 95 ]]; then
    alert "Memory: ${used_pct}% used — OOM risk"
  elif [[ "$used_pct" -gt 85 ]]; then
    warn "Memory: ${used_pct}% used"
  else
    ok "Memory: ${used_pct}% used"
  fi
}

# ── Check 7: SSL cert expiry ──────────────────────────────────────────────
check_ssl() {
  local domain="${BRAND_DOMAIN:-}"
  if [[ -z "$domain" ]] || [[ "$domain" == "apsamo.io" ]]; then
    return  # skip if no real domain configured
  fi

  local expiry
  expiry=$(echo | timeout 5 openssl s_client -connect "$domain:443" -servername "$domain" 2>/dev/null \
    | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)

  if [[ -z "$expiry" ]]; then
    warn "SSL: cannot retrieve cert for $domain"
    return
  fi

  local expiry_epoch=$(date -d "$expiry" +%s 2>/dev/null || date -j -f "%b %d %T %Y %Z" "$expiry" +%s 2>/dev/null)
  local now_epoch=$(date +%s)
  local days_left=$(( (expiry_epoch - now_epoch) / 86400 ))

  if [[ "$days_left" -lt 7 ]]; then
    alert "SSL: cert expires in ${days_left} days — renewal needed"
  elif [[ "$days_left" -lt 14 ]]; then
    warn "SSL: cert expires in ${days_left} days"
  else
    ok "SSL: ${days_left} days remaining"
  fi
}

# ── Check 8: Backup freshness ─────────────────────────────────────────────
check_backups() {
  local backup_dir="$INSTALL_DIR/backups"
  if [[ ! -d "$backup_dir" ]]; then
    warn "Backups: directory missing"
    return
  fi

  local latest_backup
  latest_backup=$(ls -1t "$backup_dir"/apsamo-backup-*.tar.gz 2>/dev/null | head -1)
  if [[ -z "$latest_backup" ]]; then
    warn "Backups: no backups found — run: apsamo backup"
    return
  fi

  local backup_time
  backup_time=$(stat -c %Y "$latest_backup" 2>/dev/null || stat -f %m "$latest_backup" 2>/dev/null)
  local now=$(date +%s)
  local hours_old=$(( (now - backup_time) / 3600 ))

  if [[ "$hours_old" -gt 48 ]]; then
    alert "Backups: latest is ${hours_old}h old — cron may be broken"
  elif [[ "$hours_old" -gt 30 ]]; then
    warn "Backups: latest is ${hours_old}h old"
  else
    ok "Backups: ${hours_old}h old"
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════════════"
log "Apsamo Panel — Health Monitor"
echo "═══════════════════════════════════════════════════════════════════════════"

check_panel_http
check_realtime
check_worker
check_db
check_disk
check_memory
check_ssl
check_backups

echo ""
if [[ "$ALERTS_SENT" -eq 0 ]]; then
  log "✓ All checks passed"
else
  log "✗ $ALERTS_SENT alert(s) sent"
fi
echo ""

exit 0
