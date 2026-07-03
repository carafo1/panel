#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# comprehensive-security-scan.sh — Scan ALL API routes for security issues
# ════════════════════════════════════════════════════════════════════════════
#
#   Scans every route.ts under src/app/api/ for:
#     1. Missing auth (no verifyToken / authenticateRequest)
#     2. Missing ownership checks on [id] routes
#     3. Admin-only routes missing admin check
#     4. Error message leaks (err.message / error.message in responses)
#     5. Role check inconsistency (admin without super_admin)
#     6. Hardcoded secrets / fallback values
#     7. Plaintext sensitive data (passwords, tokens, keys in responses)
#
#   Output: grouped report by severity
# ════════════════════════════════════════════════════════════════════════════
set -uo pipefail

cd "$(dirname "$0")/../.."

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'

CRITICAL=0; HIGH=0; MEDIUM=0; LOW=0

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — Comprehensive Security Scan${NC}"
echo "${BOLD}  Scanning all API routes...${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""

# ─── 1. Find routes missing auth ──────────────────────────────────────────
echo "${BLUE}── 1. Routes missing authentication ──${NC}"
MISSING_AUTH=0
while IFS= read -r file; do
  # Skip routes that are intentionally public
  case "$file" in
    */api/route.ts|*/api/docs/route.ts|*/api/contact/route.ts|*/api/billing/webhook/route.ts|*/api/billing/waafi/callback/route.ts|*/api/billing/success/route.ts|*/api/auth/verify-email/route.ts|*/api/auth/reset-password/route.ts|*/api/auth/forgot-password/route.ts|*/api/github/oauth/callback/route.ts)
      # These are intentionally public (or were already fixed)
      ;;
    *)
      if ! grep -qE "verifyToken|authenticateRequest|extractTokenFromHeader" "$file" 2>/dev/null; then
        echo "  ${RED}✗${NC} $file — NO AUTH CHECK"
        MISSING_AUTH=$((MISSING_AUTH + 1))
        CRITICAL=$((CRITICAL + 1))
      fi
      ;;
  esac
done < <(find src/app/api -name "route.ts" -type f)
[[ $MISSING_AUTH -eq 0 ]] && echo "  ${GREEN}✓${NC} All routes have auth checks"
echo ""

# ─── 2. Find [id] routes missing ownership checks ────────────────────────
echo "${BLUE}── 2. [id] routes missing ownership checks ──${NC}"
MISSING_OWN=0
while IFS= read -r file; do
  # Check if the file references userId in a where clause
  if ! grep -qE "userId.*decoded|userId.*user\.|where.*userId" "$file" 2>/dev/null; then
    # Check if it's an admin-only route (those are exempt — admin can access any)
    if ! grep -qE "role.*admin|isAdmin" "$file" 2>/dev/null; then
      echo "  ${YELLOW}!${NC} $file — may be missing ownership check"
      MISSING_OWN=$((MISSING_OWN + 1))
      HIGH=$((HIGH + 1))
    fi
  fi
done < <(find src/app/api -path "*/\[id\]*/route.ts" -o -path "*/\[userId\]*/route.ts" -o -path "*/\[jobId\]*/route.ts" -o -path "*/\[teamId\]*/route.ts" -o -path "*/\[projectId\]*/route.ts" -o -path "*/\[memberId\]*/route.ts" -o -path "*/\[keyId\]*/route.ts" 2>/dev/null | sort -u)
[[ $MISSING_OWN -eq 0 ]] && echo "  ${GREEN}✓${NC} All [id] routes have ownership checks"
echo ""

# ─── 3. Find admin routes missing admin check ─────────────────────────────
echo "${BLUE}── 3. Admin routes missing admin role check ──${NC}"
MISSING_ADMIN=0
while IFS= read -r file; do
  if ! grep -qE "role.*admin|isAdmin|super_admin" "$file" 2>/dev/null; then
    echo "  ${RED}✗${NC} $file — admin route without admin check"
    MISSING_ADMIN=$((MISSING_ADMIN + 1))
    CRITICAL=$((CRITICAL + 1))
  fi
done < <(find src/app/api/admin -name "route.ts" -type f)
[[ $MISSING_ADMIN -eq 0 ]] && echo "  ${GREEN}✓${NC} All admin routes have admin checks"
echo ""

# ─── 4. Find error message leaks ──────────────────────────────────────────
echo "${BLUE}── 4. Error message leaks in API responses ──${NC}"
LEAKS=0
while IFS= read -r file; do
  # Look for patterns that return error.message to the client
  if grep -qE "error:\s*(err|error)\.message|details:\s*(err|error)\.message|message:\s*(err|error)\.message" "$file" 2>/dev/null; then
    echo "  ${RED}✗${NC} $file — returns error.message to client"
    LEAKS=$((LEAKS + 1))
    HIGH=$((HIGH + 1))
  fi
done < <(find src/app/api -name "route.ts" -type f)
[[ $LEAKS -eq 0 ]] && echo "  ${GREEN}✓${NC} No error.message leaks in API responses"
echo ""

# ─── 5. Find role check inconsistency (admin without super_admin) ─────────
echo "${BLUE}── 5. Role check inconsistency (admin without super_admin) ──${NC}"
INCONSISTENT=0
while IFS= read -r match; do
  file=$(echo "$match" | cut -d: -f1)
  line=$(echo "$match" | cut -d: -f2)
  content=$(echo "$match" | cut -d: -f3-)
  # Skip if the same line also mentions super_admin
  if ! echo "$content" | grep -q "super_admin"; then
    echo "  ${YELLOW}!${NC} $file:$line — admin check may exclude super_admin"
    INCONSISTENT=$((INCONSISTENT + 1))
    MEDIUM=$((MEDIUM + 1))
  fi
done < <(grep -rn "role\s*===\s*['\"]admin['\"]" src/app/api/ 2>/dev/null | grep -v "super_admin")
[[ $INCONSISTENT -eq 0 ]] && echo "  ${GREEN}✓${NC} All admin checks include super_admin"
echo ""

# ─── 6. Find hardcoded secrets / fallback values ──────────────────────────
echo "${BLUE}── 6. Hardcoded secrets / fallback values ──${NC}"
HARDCODED=0
while IFS= read -r match; do
  echo "  ${RED}✗${NC} $match"
  HARDCODED=$((HARDCODED + 1))
  CRITICAL=$((CRITICAL + 1))
done < <(grep -rn "JWT_SECRET.*\|\|.*['\"]" src/ 2>/dev/null | grep -v node_modules | grep -v "\.bak")
[[ $HARDCODED -eq 0 ]] && echo "  ${GREEN}✓${NC} No hardcoded JWT_SECRET fallbacks"
echo ""

# ─── 7. Find plaintext sensitive data in responses ───────────────────────
echo "${BLUE}── 7. Plaintext sensitive data in responses ──${NC}"
PLAINTEXT=0
while IFS= read -r match; do
  echo "  ${YELLOW}!${NC} $match"
  PLAINTEXT=$((PLAINTEXT + 1))
  MEDIUM=$((MEDIUM + 1))
done < <(grep -rn "password:\|secret:\|apiKey:\|api_key:\|privateKey:" src/app/api/ 2>/dev/null | grep -v "hashedPassword\|encrypt\|maskSecret\|password:\s*null\|password:\s*''" | grep -v "console\|log\|metadata" | head -10)
[[ $PLAINTEXT -eq 0 ]] && echo "  ${GREEN}✓${NC} No plaintext sensitive data in responses"
echo ""

# ─── Summary ──────────────────────────────────────────────────────────────
TOTAL=$((CRITICAL + HIGH + MEDIUM + LOW))
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Scan complete${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  ${RED}CRITICAL${NC}: $CRITICAL"
echo "  ${YELLOW}HIGH${NC}:     $HIGH"
echo "  ${YELLOW}MEDIUM${NC}:   $MEDIUM"
echo "  ${BLUE}LOW${NC}:       $LOW"
echo "  ${BOLD}TOTAL${NC}:     $TOTAL"
echo ""

if [[ $TOTAL -eq 0 ]]; then
  echo "${GREEN}${BOLD}  ✓ NO SECURITY ISSUES FOUND${NC}"
  exit 0
else
  echo "${YELLOW}${BOLD}  ! $TOTAL issue(s) need attention${NC}"
  exit 1
fi
