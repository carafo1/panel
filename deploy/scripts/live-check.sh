#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Apsamo live checks — READ-ONLY tests against a running production install.
#
#   bash deploy/scripts/live-check.sh [brand-domain]        (default apsamo.com)
#
# From any machine: the public surface (HTTPS, certificates, security headers,
# auth on every sensitive API, public domain search, webhooks, mail ports).
# As root on the server (/opt/apsamo present): also services, database
# integrity, Caddy config, Docker containers, listening ports, secrets file
# permissions, backups, worker activity and recent errors.
#
# Never buys, registers, pays, signs in, or changes data. The domain searches
# are registrar READ lookups. Exit code = number of failed checks.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BRAND="${1:-apsamo.com}"
PANEL="panel.$BRAND"
MAIL="mail.$BRAND"
APP_DIR="${APP_DIR:-/opt/apsamo}"
PASS=0; FAIL=0; WARN=0
FAILED=()

if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; B=$'\e[1m'; N=$'\e[0m'; else G=; R=; Y=; B=; N=; fi
ok()   { PASS=$((PASS+1)); echo "  ${G}PASS${N} $1"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); echo "  ${R}FAIL${N} $1${2:+ — $2}"; }
warn() { WARN=$((WARN+1)); echo "  ${Y}WARN${N} $1${2:+ — $2}"; }
section() { echo; echo "${B}── $1 ──${N}"; }

code() { curl -s -o /dev/null -m 20 -w '%{http_code}' "$@" 2>/dev/null || echo 000; }
expect_code() { # name expected-codes(regex) curl-args...
  local name="$1" want="$2"; shift 2
  local c; c=$(code "$@")
  if [[ "$c" =~ ^($want)$ ]]; then ok "$name ($c)"; else bad "$name" "got $c, want $want"; fi
}

# ── 1. Sites ────────────────────────────────────────────────────────────────
section "Sites over HTTPS"
for h in "$BRAND" "www.$BRAND" "$PANEL" "$MAIL"; do
  expect_code "https://$h" "200" "https://$h/"
done
c=$(code "http://$BRAND/")
[[ "$c" =~ ^(301|302|307|308)$ ]] && ok "http://$BRAND redirects to HTTPS ($c)" || bad "http://$BRAND redirects to HTTPS" "got $c"

# ── 2. Certificates ─────────────────────────────────────────────────────────
section "TLS certificates"
if command -v openssl >/dev/null 2>&1; then
  for h in "$BRAND" "www.$BRAND" "$PANEL" "$MAIL" "autodiscover.$BRAND"; do
    end=$(echo | openssl s_client -servername "$h" -connect "$h:443" -verify_hostname "$h" -verify_return_error 2>/dev/null \
      | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
    if [ -z "$end" ]; then bad "certificate for $h" "no verified certificate served"; continue; fi
    days=$(( ( $(date -d "$end" +%s 2>/dev/null || echo 0) - $(date +%s) ) / 86400 ))
    if [ "$days" -ge 14 ]; then ok "certificate for $h ($days days left)"
    elif [ "$days" -ge 0 ]; then warn "certificate for $h" "only $days days left (Caddy should have renewed)"
    else bad "certificate for $h" "expired"; fi
  done
else
  warn "certificates" "openssl not installed here; skipped"
fi

# ── 3. Security headers ─────────────────────────────────────────────────────
section "Security headers (panel)"
hdrs=$(curl -s -I -m 20 "https://$PANEL/" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z')
for hname in "strict-transport-security" "x-content-type-options" "x-frame-options\|content-security-policy" "referrer-policy"; do
  echo "$hdrs" | grep -q "^\($hname\):" && ok "header ${hname//\\|/ or }" || bad "header ${hname//\\|/ or }" "missing"
done
echo "$hdrs" | grep -q "^x-powered-by:" && warn "x-powered-by header" "reveals the framework" || ok "no x-powered-by header"

# ── 4. Health ───────────────────────────────────────────────────────────────
section "Health"
expect_code "public status endpoint" "200" "https://$PANEL/api/status"
expect_code "internal health check refuses anonymous callers" "401|403" -X POST "https://$PANEL/api/health/check"

# ── 5. Auth on sensitive APIs (no token → 401, bad token → 401/403) ─────────
section "Authentication required"
for p in /api/hosting /api/domains /api/invoices /api/user/api-keys /api/notifications \
         /api/automation/jobs /api/audit-logs /api/teams /api/deployments \
         /api/admin/provisioning /api/admin/users /api/admin/servers /api/admin/payments \
         /api/admin/stats /api/admin/jobs /api/admin/infrastructure /api/admin/subscriptions; do
  expect_code "GET $p without a token" "401|403" "https://$PANEL$p"
done
expect_code "GET /api/hosting with a forged token" "401|403" -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4Iiwicm9sZSI6ImFkbWluIn0.invalid" "https://$PANEL/api/hosting"
expect_code "POST /api/seed without a token" "401|403|405" -X POST "https://$PANEL/api/seed"
expect_code "POST /api/admin/provisioning without a token" "401|403" -X POST "https://$PANEL/api/admin/provisioning"
expect_code "POST /api/billing/sweep without the cron key" "401|403|404|405" -X POST "https://$PANEL/api/billing/sweep"
expect_code "POST /api/cron/auto-deploy without the cron key" "401|403|404|405" -X POST "https://$PANEL/api/cron/auto-deploy"
expect_code "POST /api/hosting/create without a token" "401|403" -X POST -H 'Content-Type: application/json' -d '{}' "https://$PANEL/api/hosting/create"
expect_code "POST /api/billing/checkout without a token" "401|403" -X POST -H 'Content-Type: application/json' -d '{"type":"hosting"}' "https://$PANEL/api/billing/checkout"
expect_code "POST /api/domains/checkout without a token" "401|403" -X POST -H 'Content-Type: application/json' -d '{}' "https://$PANEL/api/domains/checkout"

# ── 6. Payment webhooks refuse unsigned events ──────────────────────────────
section "Payment webhooks"
expect_code "Stripe webhook without a signature" "400|401|403|404|503" -X POST -H 'Content-Type: application/json' -d '{"type":"checkout.session.completed"}' "https://$PANEL/api/billing/webhook"

# ── 7. Public domain search (registrar read lookups only) ───────────────────
section "Domain search (read-only registrar lookups)"
taken=$(curl -s -m 30 "https://$PANEL/api/domains/search?domain=google.com" 2>/dev/null)
echo "$taken" | grep -q '"available":false' && ok "google.com reported as taken" || bad "google.com reported as taken" "$(echo "$taken" | head -c 160)"
echo "$taken" | grep -q '"registrationPrice":[0-9]' && bad "taken domain shows no price" "a price was returned" || ok "taken domain shows no price"
free_name="apsamo-livecheck-$(date +%s | tail -c 6)-zq.com"
free=$(curl -s -m 30 "https://$PANEL/api/domains/search?domain=$free_name" 2>/dev/null)
if echo "$free" | grep -q '"available":true' && echo "$free" | grep -q '"registrationPrice":[0-9]'; then
  ok "unregistered name reported available with a real price"
elif echo "$free" | grep -q 'availability_unknown\|"status":"unknown"'; then
  warn "unregistered name" "registrar could not be reached (reported as unknown, never as available)"
else
  bad "unregistered name reported available with a price" "$(echo "$free" | head -c 160)"
fi
expect_code "invalid domain name rejected" "400|422" "https://$PANEL/api/domains/search?domain=not%20a%20domain"

# ── 8. Mail ─────────────────────────────────────────────────────────────────
section "Mail"
port_open() { timeout 8 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }
for p in 25 465 587 993; do
  port_open "$MAIL" "$p" && ok "$MAIL port $p reachable" || bad "$MAIL port $p reachable" "closed or filtered"
done

# ── Server-side checks (only as root on the server) ─────────────────────────
if [ -d "$APP_DIR" ] && [ "$(id -u)" = "0" ]; then
  section "Services"
  for s in apsamo-panel apsamo-worker apsamo-realtime caddy pdns docker; do
    if systemctl is-active --quiet "$s"; then ok "$s active"; else bad "$s active" "$(systemctl is-active "$s" 2>&1)"; fi
    systemctl is-enabled --quiet "$s" 2>/dev/null || warn "$s enabled at boot" "not enabled"
  done

  section "Database"
  DB="$APP_DIR/db/custom.db"
  if [ -f "$DB" ] && command -v sqlite3 >/dev/null; then
    ic=$(sqlite3 "file:$DB?mode=ro" "pragma integrity_check;" 2>&1 | head -1)
    [ "$ic" = "ok" ] && ok "integrity_check" || bad "integrity_check" "$ic"
    fk=$(sqlite3 "file:$DB?mode=ro" "pragma foreign_key_check;" 2>&1 | wc -l)
    [ "$fk" = "0" ] && ok "foreign keys consistent" || bad "foreign keys consistent" "$fk violations"
    stuck=$(sqlite3 "file:$DB?mode=ro" "select count(*) from Payment where status='completed' and provisionStatus in ('claimed','provisioning') and provisionLeaseUntil < strftime('%s','now')*1000;" 2>/dev/null || echo "?")
    [ "$stuck" = "0" ] && ok "no abandoned provisioning claims" || warn "abandoned provisioning claims" "$stuck (the 5-minute sweep re-drives them)"
    review=$(sqlite3 "file:$DB?mode=ro" "select count(*) from Payment where provisionStatus in ('failed','manual_review');" 2>/dev/null || echo "?")
    [ "$review" = "0" ] && ok "no paid orders waiting for manual review" || warn "paid orders needing a human" "$review"
    orders=$(sqlite3 "file:$DB?mode=ro" "select count(*) from DomainOrder where status='manual_review' or (registrarCalledAt is not null and registrarConfirmedAt is null);" 2>/dev/null || echo "?")
    [ "$orders" = "0" ] && ok "no domain orders with an unconfirmed registrar outcome" || warn "domain orders to reconcile" "$orders"
    jobs=$(sqlite3 "file:$DB?mode=ro" "select count(*) from JobQueue where status='processing' and updatedAt < (strftime('%s','now')-3600)*1000;" 2>/dev/null || echo "?")
    [ "$jobs" = "0" ] && ok "no jobs stuck in processing for over an hour" || warn "jobs stuck in processing" "$jobs"
  else
    warn "database checks" "sqlite3 or $DB not found"
  fi

  section "Caddy"
  caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && ok "Caddyfile valid" || bad "Caddyfile valid"
  for h in "$BRAND" "www.$BRAND" "$PANEL" "$MAIL" "autodiscover.$BRAND"; do
    grep -q "$h" /etc/caddy/Caddyfile && ok "Caddyfile serves $h" || bad "Caddyfile serves $h"
  done

  section "Docker"
  unhealthy=$(docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null)
  [ -z "$unhealthy" ] && ok "no unhealthy containers" || bad "no unhealthy containers" "$(echo $unhealthy)"
  restarting=$(docker ps --filter status=restarting --format '{{.Names}}' 2>/dev/null)
  [ -z "$restarting" ] && ok "no containers in a restart loop" || bad "no containers in a restart loop" "$(echo $restarting)"

  section "Network exposure"
  # Internal services must listen on loopback only.
  for p in 3000 3003 2019 8081; do
    exposed=$(ss -Hltn "sport = :$p" 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.0\.0\.1|\[::1\]|::1):' | head -1)
    if [ -z "$exposed" ]; then
      ok "port $p not exposed publicly"
    elif ufw status 2>/dev/null | grep -q '^Status: active' && ! ufw status 2>/dev/null | grep -qE "^$p(/tcp)?[[:space:]]+ALLOW"; then
      ok "port $p blocked by the firewall (listens on $exposed)"
    else
      bad "port $p not exposed publicly" "listening on $exposed and allowed by the firewall"
    fi
  done
  for p in 3306 5432 6379 11211; do
    exposed=$(ss -Hltn "sport = :$p" 2>/dev/null | awk '{print $4}' | grep -vE '^(127\.|\[::1\]|::1|172\.|10\.)' | head -1)
    [ -z "$exposed" ] && ok "database/cache port $p not exposed publicly" || bad "database/cache port $p not exposed publicly" "listening on $exposed"
  done

  section "Secrets and backups"
  perm=$(stat -c %a "$APP_DIR/.env" 2>/dev/null)
  [[ "$perm" =~ ^(600|400|640)$ ]] && ok ".env permissions ($perm)" || bad ".env permissions" "${perm:-missing}"
  git -C "$APP_DIR" ls-files --error-unmatch .env >/dev/null 2>&1 && bad ".env not tracked by git" || ok ".env not tracked by git"
  latest=$(ls -t "$APP_DIR"/backups/*.tar.gz 2>/dev/null | head -1)
  if [ -n "$latest" ]; then
    age=$(( ( $(date +%s) - $(stat -c %Y "$latest") ) / 3600 ))
    [ "$age" -le 48 ] && ok "recent panel backup ($age h old)" || warn "recent panel backup" "newest is $age h old"
    gzip -t "$latest" 2>/dev/null && ok "newest backup archive is readable" || bad "newest backup archive is readable"
  else
    bad "panel backups exist" "none in $APP_DIR/backups"
  fi

  section "Logs (last hour)"
  errs=$(journalctl -u apsamo-panel -u apsamo-worker -u apsamo-realtime --since "-60 min" -p err --no-pager 2>/dev/null | grep -vc '^-- ')
  [ "$errs" = "0" ] && ok "no errors from panel, worker or realtime" || warn "errors logged in the last hour" "$errs lines (journalctl -u apsamo-worker -p err)"
  restarts=$(systemctl show apsamo-worker -p NRestarts --value 2>/dev/null || echo 0)
  if systemctl is-active --quiet apsamo-worker && [ "${restarts:-0}" -lt 5 ]; then
    ok "worker running (automatic restarts: ${restarts:-0})"
  else
    bad "worker running" "inactive, or restarted ${restarts:-?} times"
  fi
  df_root=$(df -P / | awk 'NR==2 {print $5}' | tr -d %)
  [ "$df_root" -lt 85 ] && ok "disk usage ${df_root}%" || bad "disk usage" "${df_root}% used"
  mem=$(free | awk '/Mem:/ {printf "%d", $7/$2*100}')
  [ "$mem" -ge 10 ] && ok "available memory ${mem}%" || warn "available memory" "${mem}%"
fi

echo
echo "${B}Result:${N} ${G}$PASS passed${N}, ${R}$FAIL failed${N}, ${Y}$WARN warnings${N}"
for f in "${FAILED[@]}"; do echo "  - $f"; done
exit "$FAIL"
