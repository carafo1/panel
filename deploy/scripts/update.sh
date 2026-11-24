#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# update.sh — Pull latest code + rebuild + restart (with auto-backup)
# ════════════════════════════════════════════════════════════════════════════
#
#   Usage:
#     apsamo update              # update from current branch
#     apsamo update --branch X   # switch to branch X first
#     apsamo update --tag v1.2   # checkout specific tag
#     apsamo update --no-backup  # skip pre-update backup (faster, risky)
#
#   Billing safety: the worker (which runs the billing sweep) is stopped for
#   the update, and scripts/billing-preview.ts runs against the new code
#   before it starts again. If the sweep would suspend anyone or take a
#   cancelled plan's websites offline, the worker is HELD (left stopped) so
#   the list can be checked first; start it with: systemctl start apsamo-worker
#
#   The script will:
#     1. Create a pre-update backup (DB + .env + storage)
#     2. git pull (or checkout to specified branch/tag)
#     3. bun install (in case deps changed)
#     4. bun run db:push (in case schema changed)
#     5. bun run seed (re-seed plans/servers/templates if missing)
#     6. bun run build (production rebuild)
#     7. Restart services in order: realtime → worker → panel
#
#   The panel will be down for ~30 seconds during restart. For zero-downtime
#   updates, run two panel instances behind Caddy (not yet supported by this
#   script — use blue-green deploy manually if needed).
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="${APSAMO_DIR:-/opt/apsamo}"
BRANCH=""
TAG=""
BACKUP=1

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)     BRANCH="$2"; shift 2 ;;
    --tag)        TAG="$2"; shift 2 ;;
    --no-backup)  BACKUP=0; shift ;;
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

cd "$INSTALL_DIR"

# ── Pause background jobs ─────────────────────────────────────────────────
# The worker drives the billing sweep. Keep it stopped until the new code
# has been checked (see "Billing preview" below), so new billing rules never
# act on customers before anyone has seen what they will do.
step "Pausing background worker"
systemctl stop apsamo-worker 2>/dev/null || true
ok "Worker paused"

# ── Pre-update backup ─────────────────────────────────────────────────────
if [[ "$BACKUP" == "1" ]]; then
  step "Creating pre-update backup"
  bash "$INSTALL_DIR/deploy/scripts/backup.sh" --output "$INSTALL_DIR/backups/pre-update-$(date +%Y%m%d-%H%M%S).tar.gz"
fi

# ── Pull latest code ──────────────────────────────────────────────────────
step "Updating code"

if [[ -n "$TAG" ]]; then
  ok "Checking out tag: $TAG"
  git fetch --tags
  git checkout "$TAG"
elif [[ -n "$BRANCH" ]]; then
  ok "Switching to branch: $BRANCH"
  git fetch origin
  git checkout "$BRANCH"
  git pull origin "$BRANCH"
else
  ok "Pulling latest from current branch"
  git pull
fi

CURRENT=$(git rev-parse --short HEAD)
ok "Now at commit: $CURRENT"

# ── Install dependencies ──────────────────────────────────────────────────
step "Installing dependencies"
bun install --production
ok "Dependencies installed"

# ── Push schema (in case of changes) ──────────────────────────────────────
step "Pushing database schema"
bun run db:push
ok "Schema up to date"

# ── Re-seed (idempotent — only adds missing rows) ─────────────────────────
step "Re-seeding database"
bun run scripts/run-seed.ts 2>/dev/null || warn "seed script (run-seed) failed — continuing"
bun run scripts/seed-templates-and-payment.ts 2>/dev/null || warn "seed script (templates) failed — continuing"
ok "Seed complete"

# ── Build ─────────────────────────────────────────────────────────────────
step "Building production bundle"
bun run build
ok "Build complete"

# ── Restart services ──────────────────────────────────────────────────────
step "Restarting services"

ok "Restarting realtime..."
systemctl restart apsamo-realtime
sleep 2

# ── Billing preview (read only) ───────────────────────────────────────────
HOLD_WORKER=0
if [[ -f scripts/billing-preview.ts ]]; then
  step "Billing preview — what the next sweep would do"
  PREVIEW_JSON="$(mktemp)"
  # --out writes the JSON to the file directly, so log lines printed by the
  # app while it starts or stops can never corrupt it (that used to hold the
  # worker after every update).
  if bun run scripts/billing-preview.ts --json --out "$PREVIEW_JSON" >/dev/null 2>&1; then
    bun run scripts/billing-preview.ts || true
    # Hold only for actions that take websites offline.
    IMPACT=$(bun -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).rows||[];console.log(r.filter(x=>x.action==='suspend'||x.action==='end_cancelled').length)" "$PREVIEW_JSON" 2>/dev/null || echo "?")
    if [[ "$IMPACT" != "0" ]]; then
      HOLD_WORKER=1
      warn "The billing sweep would take websites offline for $IMPACT subscription(s) (listed above)."
    fi
  else
    HOLD_WORKER=1
    warn "Billing preview could not run — holding the worker to be safe."
  fi
  rm -f "$PREVIEW_JSON"
fi

if [[ "$HOLD_WORKER" == "1" ]]; then
  warn "Worker HELD (stopped): no renewals, suspensions, monitors or deploy sweeps until you start it."
else
  ok "Starting worker..."
  systemctl start apsamo-worker
  sleep 2
fi

ok "Restarting panel..."
systemctl restart apsamo-panel
sleep 5

# ── Verify ────────────────────────────────────────────────────────────────
step "Verifying"

SERVICES="apsamo-panel apsamo-realtime"
[[ "$HOLD_WORKER" == "1" ]] || SERVICES="$SERVICES apsamo-worker"
for svc in $SERVICES; do
  status=$(systemctl is-active "$svc")
  if [[ "$status" == "active" ]]; then
    ok "$svc: active"
  else
    err "$svc: $status (check: journalctl -u $svc -n 50)"
  fi
done

# Quick HTTP check
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo "000")
if [[ "$HTTP_CODE" == "200" ]]; then
  ok "Panel HTTP check: 200 OK"
else
  warn "Panel HTTP check: $HTTP_CODE (may still be warming up)"
fi

echo ""
echo "${BOLD}══════════════════════════════════════════════${NC}"
ok "Update complete!"
echo "  Commit:   $CURRENT"
echo "  Backup:   $INSTALL_DIR/backups/pre-update-*.tar.gz"
echo "  Rollback: apsamo restore <pre-update-backup>"
if [[ "$HOLD_WORKER" == "1" ]]; then
  echo ""
  warn "Background worker is HELD. Review the billing preview above; mark any"
  warn "invoice that was actually paid as paid in Admin -> Invoices, re-check with:"
  echo "      cd $INSTALL_DIR && bun run scripts/billing-preview.ts"
  warn "then start it:  systemctl start apsamo-worker"
fi
echo ""
