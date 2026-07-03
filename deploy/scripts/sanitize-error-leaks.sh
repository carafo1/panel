#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# sanitize-error-leaks.sh — Bulk-fix error.message leaks in API routes
# ════════════════════════════════════════════════════════════════════════════
#
#   Replaces patterns that leak internal error details to clients:
#
#     details: error instanceof Error ? error.message : String(error)
#     details: err instanceof Error ? err.message : String(error)
#     error: err.message
#     error: error.message
#
#   With safe equivalents that return generic messages. The full error is
#   already logged server-side via console.error before these lines.
#
#   Usage: bash deploy/scripts/sanitize-error-leaks.sh
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/../.."
COUNT=0
FIXED=0

# Pattern 1: "details: error instanceof Error ? error.message : String(error)"
# Replace with: "details: 'Internal server error'"
PATTERN1='details:\s*error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*String\(error\)'
# Pattern 2: "details: err instanceof Error ? err.message : String(err)"
PATTERN2='details:\s*err\s+instanceof\s+Error\s*\?\s*err\.message\s*:\s*String\(err\)'

# Process every route file
while IFS= read -r file; do
  COUNT=$((COUNT + 1))

  # Skip if no error-leak pattern
  if ! grep -qE "$PATTERN1|$PATTERN2" "$file" 2>/dev/null; then
    continue
  fi

  # Make the replacement
  sed -i -E \
    -e "s|details:\s*error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*String\(error\)|details: 'Internal server error'|g" \
    -e "s|details:\s*err\s+instanceof\s+Error\s*\?\s*err\.message\s*:\s*String\(err\)|details: 'Internal server error'|g" \
    "$file"

  FIXED=$((FIXED + 1))
  echo "  ✓ $(basename $(dirname $file))/$(basename $file)"

done < <(find src/app/api -name "route.ts" -type f)

echo ""
echo "─────────────────────────────────────────"
echo "  Scanned:  $COUNT route files"
echo "  Fixed:    $FIXED files"
echo "─────────────────────────────────────────"
