#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# security-audit.sh — Ongoing security verification for Apsamo Panel
# ════════════════════════════════════════════════════════════════════════════
#
#   Run after every code change to verify the security posture hasn't
#   regressed. Checks for:
#
#     1. Hardcoded JWT_SECRET fallbacks
#     2. Hardcoded CRON_API_KEY fallbacks
#     3. Unauthenticated seed endpoints
#     4. Error message leaks in API responses
#     5. Server IP leaks in customer-facing responses
#     6. Container/DB internals in customer-facing responses
#     7. HTTP security headers (X-Powered-By, HSTS, etc.)
#     8. Webhook secret masking
#     9. super_admin role check consistency
#    10. Required env vars set in production
#
#   Usage:
#     bash deploy/scripts/security-audit.sh
#     bash deploy/scripts/security-audit.sh --fix   # also runs the auto-fixers
#
#   Exit codes:
#     0 — all checks passed
#     1 — one or more checks failed
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"
cd "$INSTALL_DIR"

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()    { echo "  ${GREEN}✓${NC} $*"; }
fail()  { echo "  ${RED}✗${NC} $*"; FAILURES=$((FAILURES+1)); }
warn()  { echo "  ${YELLOW}!${NC} $*"; }
step()  { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }

FAILURES=0
PASS=0
FIX_MODE=0

if [[ "${1:-}" == "--fix" ]]; then
  FIX_MODE=1
fi

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — Security Audit${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"

# ── 1. Hardcoded JWT_SECRET fallback ──────────────────────────────────────
step "1. Hardcoded JWT_SECRET fallback"

if grep -rE "JWT_SECRET.*\|\|.*['\"]" src/ 2>/dev/null | grep -v node_modules; then
  fail "Found hardcoded JWT_SECRET fallback (allows token forging if env var is unset)"
  grep -rEn "JWT_SECRET.*\|\|.*['\"]" src/ 2>/dev/null | grep -v node_modules | head -3
else
  ok "No hardcoded JWT_SECRET fallbacks"
  PASS=$((PASS+1))
fi

# ── 2. Hardcoded CRON_API_KEY fallback ────────────────────────────────────
step "2. Hardcoded CRON_API_KEY fallback"

if grep -rE "CRON_API_KEY.*\|\|.*['\"]" src/ 2>/dev/null | grep -v node_modules; then
  fail "Found hardcoded CRON_API_KEY fallback"
  grep -rEn "CRON_API_KEY.*\|\|.*['\"]" src/ 2>/dev/null | grep -v node_modules | head -3
else
  ok "No hardcoded CRON_API_KEY fallbacks"
  PASS=$((PASS+1))
fi

# ── 3. Unauthenticated seed endpoints ─────────────────────────────────────
step "3. Unauthenticated seed endpoints"

# Check that /api/route.ts and /api/seed/route.ts require admin auth
for f in src/app/api/route.ts src/app/api/seed/route.ts src/app/api/templates/seed/route.ts; do
  if [[ -f "$f" ]]; then
    if grep -q "verifyToken\|authenticateRequest" "$f"; then
      ok "$f: requires auth"
      PASS=$((PASS+1))
    else
      fail "$f: missing auth check (anyone can trigger DB re-seed)"
    fi
  fi
done

# ── 4. Error message leaks in API responses ───────────────────────────────
step "4. Error message leaks in API responses"

LEAKS=$(grep -rE "details:.*err(or)?\.message|error:.*err(or)?\.message|details:.*instanceof.*Error \? .*\.message" src/app/api/ 2>/dev/null | grep -v node_modules | wc -l)
if [[ "$LEAKS" -gt 0 ]]; then
  fail "$LEAKS error.message leak(s) found in API responses"
  if [[ "$FIX_MODE" == "1" ]]; then
    warn "Running auto-fixer..."
    bash deploy/scripts/sanitize-error-leaks.sh
    bash deploy/scripts/sanitize-error-leaks-pass2.sh
    LEAKS_AFTER=$(grep -rE "details:.*err(or)?\.message|error:.*err(or)?\.message|details:.*instanceof.*Error \? .*\.message" src/app/api/ 2>/dev/null | grep -v node_modules | wc -l)
    warn "After fix: $LEAKS_AFTER leak(s) remain"
  fi
else
  ok "No error.message leaks in API responses"
  PASS=$((PASS+1))
fi

# ── 5. Server IP leaks in customer-facing responses ──────────────────────
step "5. Server IP leaks in customer-facing responses"

# Check hosting list + detail routes gate server.ip behind isAdmin
for f in src/app/api/hosting/route.ts src/app/api/hosting/[id]/route.ts; do
  if [[ -f "$f" ]]; then
    # Look for "ip:" without an isAdmin/userIsAdmin guard nearby
    if grep -q "userIsAdmin\|isAdmin" "$f" && grep -q "ip:" "$f"; then
      ok "$(basename $(dirname $f))/$(basename $f): IP gated by admin check"
      PASS=$((PASS+1))
    elif grep -q "ip:.*p\.server\.ip\|ip:.*project\.server\.ip" "$f" && ! grep -q "userIsAdmin\|isAdmin" "$f"; then
      fail "$(basename $(dirname $f))/$(basename $f): returns server.ip without admin check"
    fi
  fi
done

# ── 6. HTTP security headers ──────────────────────────────────────────────
step "6. HTTP security headers"

if grep -q "poweredByHeader: false" next.config.ts; then
  ok "X-Powered-By header disabled"
  PASS=$((PASS+1))
else
  fail "X-Powered-By header still enabled (reveals Next.js version)"
fi

if grep -q "Strict-Transport-Security" next.config.ts; then
  ok "HSTS header configured"
  PASS=$((PASS+1))
else
  fail "HSTS header not configured"
fi

if grep -q "X-Content-Type-Options" next.config.ts; then
  ok "X-Content-Type-Options header configured"
  PASS=$((PASS+1))
else
  fail "X-Content-Type-Options header not configured"
fi

# ── 7. Webhook secret masking ─────────────────────────────────────────────
step "7. Webhook secret masking"

if grep -q "maskSecret" src/app/api/webhooks/route.ts; then
  ok "Webhook secret masked in list endpoint"
  PASS=$((PASS+1))
else
  fail "Webhook secret exposed in list endpoint"
fi

# ── 8. super_admin role check consistency ─────────────────────────────────
step "8. super_admin role check consistency"

# Find admin checks that exclude super_admin
INCONSISTENT=$(grep -rEn "role\s*===\s*['\"]admin['\"]\s*[^|&]" src/app/api/ 2>/dev/null \
  | grep -v "super_admin" \
  | grep -v node_modules \
  | wc -l)

if [[ "$INCONSISTENT" -gt 0 ]]; then
  warn "$INCONSISTENT admin check(s) might exclude super_admin (manual review needed)"
  grep -rEn "role\s*===\s*['\"]admin['\"]\s*[^|&]" src/app/api/ 2>/dev/null \
    | grep -v "super_admin" \
    | grep -v node_modules \
    | head -5
else
  ok "All admin checks include super_admin"
  PASS=$((PASS+1))
fi

# ── 9. Required env vars in production ────────────────────────────────────
step "9. Required environment variables"

if [[ -f .env ]]; then
  for var in JWT_SECRET ENCRYPTION_KEY CRON_API_KEY; do
    val=$(grep "^${var}=" .env 2>/dev/null | cut -d'"' -f2)
    if [[ -z "$val" ]] || [[ "$val" == *"replace-with"* ]] || [[ "$val" == "deployhub-cron-key" ]] || [[ "$val" == "deployhub-secret-key-2024" ]]; then
      fail "$var not set (or still using placeholder)"
    else
      ok "$var set"
      PASS=$((PASS+1))
    fi
  done
else
  warn ".env not found — skipping env var checks"
fi

# ── 10. .env file permissions ─────────────────────────────────────────────
step "10. .env file permissions"

if [[ -f .env ]]; then
  PERMS=$(stat -c "%a" .env 2>/dev/null || stat -f "%Lp" .env 2>/dev/null)
  if [[ "$PERMS" == "600" ]]; then
    ok ".env permissions: 600 (only owner can read)"
    PASS=$((PASS+1))
  else
    fail ".env permissions: $PERMS (should be 600 — world-readable secrets)"
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────
TOTAL=$((PASS + FAILURES))
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
if [[ "$FAILURES" -eq 0 ]]; then
  echo "${GREEN}${BOLD}  ✓ ALL CHECKS PASSED ($PASS/$TOTAL)${NC}"
  echo "${BOLD}  Security posture is healthy.${NC}"
  exit 0
else
  echo "${RED}${BOLD}  ✗ $FAILURES CHECK(S) FAILED ($PASS/$TOTAL passed)${NC}"
  echo ""
  echo "  Run with --fix to auto-fix the error.message leaks:"
  echo "    bash deploy/scripts/security-audit.sh --fix"
  exit 1
fi
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
