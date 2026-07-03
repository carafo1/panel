#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# sanitize-error-leaks-pass2.sh — Fix remaining error.message leak patterns
# ════════════════════════════════════════════════════════════════════════════
#
#   Catches patterns missed by the first pass:
#     const msg = err instanceof Error ? err.message : String(err)
#     const msg = error instanceof Error ? error.message : 'Internal server error'
#     const errMsg = ...
#     return NextResponse.json({ error: msg }, ...)
#
#   Replaces with generic 'Internal server error' / 'Bad request' messages.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/../.."
FIXED=0

# For each file with err.message / error.message, replace the leaky pattern
while IFS= read -r file; do
  changed=0

  # Pattern: "const msg = err instanceof Error ? err.message : String(err)"
  if grep -qE "const msg = err instanceof Error \? err\.message : String\(err\)" "$file" 2>/dev/null; then
    sed -i -E \
      "s|const msg = err instanceof Error \? err\.message : String\(err\)|const msg = 'Invalid request'|g" \
      "$file"
    changed=1
  fi

  # Pattern: "const msg = error instanceof Error ? error.message : 'Internal server error'"
  if grep -qE "const msg = error instanceof Error \? error\.message : 'Internal server error'" "$file" 2>/dev/null; then
    sed -i -E \
      "s|const msg = error instanceof Error \? error\.message : 'Internal server error'|const msg = 'Internal server error'|g" \
      "$file"
    changed=1
  fi

  # Pattern: "const errMsg = err instanceof Error ? err.message : '...'"
  if grep -qE "const errMsg = (err|error) instanceof Error" "$file" 2>/dev/null; then
    # Use perl for more complex regex
    perl -i -pe 's|const errMsg = (err\|error) instanceof Error \? (err\|error)\.message : [^;]+;|const errMsg = "Internal server error";|g' "$file"
    changed=1
  fi

  # Pattern: "{ error: err.message }" / "{ error: error.message }"
  if grep -qE "error:\s*(err|error)\.message" "$file" 2>/dev/null; then
    perl -i -pe 's|error:\s*(err\|error)\.message|error: "Internal server error"|g' "$file"
    changed=1
  fi

  # Pattern: "error: String(err)" / "error: String(error)"
  if grep -qE "error:\s*String\((err|error)\)" "$file" 2>/dev/null; then
    perl -i -pe 's|error:\s*String\((err\|error)\)|error: "Internal server error"|g' "$file"
    changed=1
  fi

  if [[ $changed -eq 1 ]]; then
    FIXED=$((FIXED + 1))
    echo "  ✓ $(basename $(dirname $file))/$(basename $file)"
  fi

done < <(find src/app/api -name "route.ts" -type f)

echo ""
echo "─────────────────────────────────────────"
echo "  Fixed: $FIXED files"
echo "─────────────────────────────────────────"
