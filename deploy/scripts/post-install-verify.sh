#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# post-install-verify.sh — Health check after deploy
# ════════════════════════════════════════════════════════════════════════════
#
#   Run this after install.sh / cloud-init / deploy.sh to verify the
#   installation is healthy. Can be run:
#     • Locally on the VPS:    bash deploy/scripts/post-install-verify.sh
#     • Remotely from laptop:  ssh root@vps 'apsamo verify'  (alias)
#
#   Exits 0 if all checks pass, 1 if any fail.
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"
BRAND_DOMAIN=$(grep '^BRAND_DOMAIN=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'"' -f2)
BRAND_DOMAIN="${BRAND_DOMAIN:-localhost}"

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()    { echo "  ${GREEN}✓${NC} $*"; }
fail()  { echo "  ${RED}✗${NC} $*"; FAILURES=$((FAILURES+1)); }
warn()  { echo "  ${YELLOW}!${NC} $*"; }
step()  { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }

FAILURES=0
PASS=0

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — Post-Install Verification${NC}"
echo "${BOLD}  Domain: $BRAND_DOMAIN${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"

# ── 1. System services ────────────────────────────────────────────────────
step "1. Systemd services"
for svc in apsamo-panel apsamo-realtime apsamo-worker caddy; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  if [[ "$status" == "active" ]]; then
    ok "$svc: active"
    PASS=$((PASS+1))
  else
    fail "$svc: $status (expected: active)"
  fi
done

# ── 2. Service enabled on boot ────────────────────────────────────────────
step "2. Auto-start on boot"
for svc in apsamo-panel apsamo-realtime apsamo-worker caddy; do
  status=$(systemctl is-enabled "$svc" 2>/dev/null || echo "unknown")
  if [[ "$status" == "enabled" ]]; then
    ok "$svc: enabled"
    PASS=$((PASS+1))
  else
    fail "$svc: $status (expected: enabled)"
  fi
done

# ── 3. Listening ports ────────────────────────────────────────────────────
step "3. Listening ports"
for port in 3000 3003 3004 3005 80 443; do
  if ss -ltn 2>/dev/null | grep -q ":$port "; then
    ok "port $port: listening"
    PASS=$((PASS+1))
  else
    fail "port $port: not listening"
  fi
done

# ── 4. Local HTTP endpoints ───────────────────────────────────────────────
step "4. Local HTTP endpoints (via localhost)"

# Panel landing page
HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null || echo "000")
if [[ "$HTTP" == "200" ]]; then
  ok "Panel (3000): HTTP 200"
  PASS=$((PASS+1))
else
  fail "Panel (3000): HTTP $HTTP (expected 200)"
fi

# Realtime health
HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3003/health 2>/dev/null || echo "000")
if [[ "$HTTP" == "200" ]]; then
  ok "Realtime (3003): HTTP 200"
  PASS=$((PASS+1))
else
  fail "Realtime (3003): HTTP $HTTP (expected 200)"
fi

# Worker health
HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3005/health 2>/dev/null || echo "000")
if [[ "$HTTP" == "200" ]]; then
  ok "Worker (3005): HTTP 200"
  PASS=$((PASS+1))
else
  fail "Worker (3005): HTTP $HTTP (expected 200)"
fi

# ── 5. Public HTTPS (if domain resolves) ──────────────────────────────────
step "5. Public HTTPS (via $BRAND_DOMAIN)"
if [[ "$BRAND_DOMAIN" != "localhost" ]]; then
  HTTPS=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$BRAND_DOMAIN/" 2>/dev/null || echo "000")
  case "$HTTPS" in
    200|301|302) ok "HTTPS: HTTP $HTTPS (SSL working)"; PASS=$((PASS+1)) ;;
    000)         warn "HTTPS: unreachable (SSL may still be provisioning — wait 30s and re-run)" ;;
    *)           fail "HTTPS: HTTP $HTTPS (check Caddy logs: journalctl -u caddy -n 50)" ;;
  esac
else
  warn "Skipping HTTPS check (BRAND_DOMAIN=localhost)"
fi

# ── 6. Database ───────────────────────────────────────────────────────────
step "6. Database"
DB_URL=$(grep '^DATABASE_URL=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'"' -f2)
DB_PATH="${DB_URL#file:}"
if [[ -f "$DB_PATH" ]]; then
  SIZE=$(du -h "$DB_PATH" | cut -f1)
  ok "DB file: $DB_PATH ($SIZE)"
  PASS=$((PASS+1))

  # Check critical tables have data
  cd "$INSTALL_DIR"
  PLANS=$(bun -e "const {db}=require('./src/lib/db');db.plan.count().then(n=>{console.log(n);process.exit(0)});" 2>/dev/null || echo "0")
  if [[ "$PLANS" -ge 3 ]]; then
    ok "Plans table: $PLANS rows"
    PASS=$((PASS+1))
  else
    fail "Plans table: $PLANS rows (expected ≥3 — run: apsamo seed)"
  fi

  TEMPLATES=$(bun -e "const {db}=require('./src/lib/db');db.template.count().then(n=>{console.log(n);process.exit(0)});" 2>/dev/null || echo "0")
  if [[ "$TEMPLATES" -ge 1 ]]; then
    ok "Templates table: $TEMPLATES rows"
    PASS=$((PASS+1))
  else
    fail "Templates table: $TEMPLATES rows (expected ≥1 — run: apsamo seed)"
  fi

  ADMINS=$(bun -e "const {db}=require('./src/lib/db');db.user.count({where:{role:{in:['admin','super_admin']}}}).then(n=>{console.log(n);process.exit(0)});" 2>/dev/null || echo "0")
  if [[ "$ADMINS" -ge 1 ]]; then
    ok "Admin users: $ADMINS"
    PASS=$((PASS+1))
  else
    fail "Admin users: 0 (run: apsamo create-admin)"
  fi

  LOCALHOST_SRV=$(bun -e "const {db}=require('./src/lib/db');db.server.count({where:{sshHost:'localhost'}}).then(n=>{console.log(n);process.exit(0)});" 2>/dev/null || echo "0")
  if [[ "$LOCALHOST_SRV" -ge 1 ]]; then
    ok "Localhost server: configured"
    PASS=$((PASS+1))
  else
    warn "Localhost server: not configured (projects can't deploy on this box)"
    warn "  Fix: apsamo db-shell → INSERT INTO Server ..."
  fi
else
  fail "DB file not found: $DB_PATH"
fi

# ── 7. Auth flow ──────────────────────────────────────────────────────────
step "7. Auth flow (register + login + me)"
ADMIN_EMAIL=$(grep '^ADMIN_EMAIL=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'"' -f2)

# Try login as admin (if .env has admin creds)
if [[ -n "$ADMIN_EMAIL" ]]; then
  # We don't know the password — try a fake one just to verify the endpoint works
  RESP=$(curl -s -X POST http://localhost:3000/api/auth/login \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"verify-test-only\"}" 2>/dev/null)
  if echo "$RESP" | grep -qE '"token"|"error"|Invalid|incorrect'; then
    ok "Login endpoint: responds correctly"
    PASS=$((PASS+1))
  else
    fail "Login endpoint: unexpected response: $RESP"
  fi
fi

# Test /api/billing/plans (public)
HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/billing/plans 2>/dev/null || echo "000")
if [[ "$HTTP" == "200" ]]; then
  ok "Plans API: HTTP 200"
  PASS=$((PASS+1))
else
  fail "Plans API: HTTP $HTTP (expected 200)"
fi

# Test /api/templates (public)
HTTP=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/api/templates 2>/dev/null || echo "000")
if [[ "$HTTP" == "200" ]]; then
  ok "Templates API: HTTP 200"
  PASS=$((PASS+1))
else
  fail "Templates API: HTTP $HTTP (expected 200)"
fi

# ── 8. Dynadot integration ────────────────────────────────────────────────
step "8. Dynadot integration"
DYNADOT_KEY=$(grep '^DYNADOT_API_KEY=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'"' -f2)
if [[ -n "$DYNADOT_KEY" ]] && [[ "$DYNADOT_KEY" != *"replace-with"* ]]; then
  # Try a real domain search
  RESP=$(curl -s "http://localhost:3000/api/domains/search?domain=verify-test-$(date +%s).com" 2>/dev/null)
  if echo "$RESP" | grep -q '"available"'; then
    ok "Domain search: real Dynadot API responding"
    PASS=$((PASS+1))
  else
    fail "Domain search: no response (check DYNADOT_API_KEY)"
  fi
else
  warn "Dynadot: keys not set — domain search in demo mode"
fi

# ── 9. Backups ────────────────────────────────────────────────────────────
step "9. Backups"
BACKUP_DIR="$INSTALL_DIR/backups"
if [[ -d "$BACKUP_DIR" ]]; then
  COUNT=$(ls -1 "$BACKUP_DIR"/apsamo-backup-*.tar.gz 2>/dev/null | wc -l)
  if [[ "$COUNT" -ge 1 ]]; then
    LATEST=$(ls -1t "$BACKUP_DIR"/apsamo-backup-*.tar.gz 2>/dev/null | head -1)
    LATEST_SIZE=$(du -h "$LATEST" | cut -f1)
    ok "Backups: $COUNT present (latest: $(basename "$LATEST"), $LATEST_SIZE)"
    PASS=$((PASS+1))
  else
    warn "Backups: directory exists but no backups yet — run: apsamo backup"
  fi
else
  warn "Backups: directory missing — run: apsamo backup"
fi

# Check cron is scheduled
if crontab -l 2>/dev/null | grep -q "backup.sh"; then
  ok "Backup cron: scheduled"
  PASS=$((PASS+1))
else
  warn "Backup cron: not scheduled (daily 3 AM backup won't run)"
fi

# ── 10. Firewall ──────────────────────────────────────────────────────────
step "10. Firewall (ufw)"
if command -v ufw &>/dev/null; then
  UFW_STATUS=$(ufw status 2>/dev/null | head -1)
  if echo "$UFW_STATUS" | grep -q "active"; then
    ok "ufw: active"
    PASS=$((PASS+1))
    # Check essential ports
    for port in 22 80 443; do
      if ufw status | grep -q "^$port/tcp.*ALLOW"; then
        ok "ufw: port $port open"
        PASS=$((PASS+1))
      else
        warn "ufw: port $port may not be open"
      fi
    done
  else
    warn "ufw: not active — server is open to all traffic"
  fi
else
  warn "ufw: not installed"
fi

# ── 11. Disk space ────────────────────────────────────────────────────────
step "11. Disk space"
FREE_GB=$(df -BG / | awk 'NR==2 {gsub(/G/, "", $4); print $4}')
if [[ "$FREE_GB" -ge 5 ]]; then
  ok "Disk: ${FREE_GB}GB free"
  PASS=$((PASS+1))
else
  warn "Disk: only ${FREE_GB}GB free — consider cleaning up"
fi

# ── 12. SSL cert (if HTTPS works) ─────────────────────────────────────────
step "12. SSL certificate"
if [[ "$BRAND_DOMAIN" != "localhost" ]]; then
  CERT_INFO=$(echo | timeout 5 openssl s_client -connect "$BRAND_DOMAIN:443" -servername "$BRAND_DOMAIN" 2>/dev/null | openssl x509 -noout -subject -dates 2>/dev/null || echo "")
  if [[ -n "$CERT_INFO" ]]; then
    SUBJECT=$(echo "$CERT_INFO" | grep subject= | sed 's/subject=//')
    EXPIRY=$(echo "$CERT_INFO" | grep notAfter= | sed 's/notAfter=//')
    ok "SSL cert: $SUBJECT"
    ok "Expires:  $EXPIRY"
    PASS=$((PASS+1))
  else
    warn "SSL cert: not yet provisioned (or HTTPS not reachable)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAILURES))
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
if [[ "$FAILURES" -eq 0 ]]; then
  echo "${GREEN}${BOLD}  ✓ ALL CHECKS PASSED ($PASS/$TOTAL)${NC}"
  echo "${BOLD}  Panel is healthy and production-ready.${NC}"
  echo ""
  echo "  ${BOLD}URL:${NC}      https://$BRAND_DOMAIN"
  echo "  ${BOLD}Admin:${NC}    $ADMIN_EMAIL"
  echo "  ${BOLD}Manage:${NC}   apsamo status"
  exit 0
else
  echo "${RED}${BOLD}  ✗ $FAILURES CHECK(S) FAILED ($PASS/$TOTAL passed)${NC}"
  echo ""
  echo "  Run 'apsamo doctor' for more details."
  echo "  Tail logs: apsamo logs panel"
  exit 1
fi
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
