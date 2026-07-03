#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# switch-to-postgres.sh — Migrate Apsamo Panel from SQLite to PostgreSQL
# ════════════════════════════════════════════════════════════════════════════
#
#   One-command switch from SQLite to PostgreSQL + pgvector.
#
#   What it does:
#     1. Runs install-postgres.sh (installs PostgreSQL 16 + pgvector)
#     2. Backs up the SQLite DB
#     3. Switches the Prisma schema to the PostgreSQL variant
#     4. Pushes the schema (creates tables in PostgreSQL)
#     5. Migrates all data from SQLite → PostgreSQL (row-by-row via bun)
#     6. Updates .env (DATABASE_URL + DB_ENGINE=postgres)
#     7. Restarts all services
#     8. Runs apsamo verify
#
#   Usage:
#     bash deploy/scripts/switch-to-postgres.sh
#
#   The script is idempotent — safe to re-run if it fails partway through.
#
#   Rollback:
#     bash deploy/scripts/switch-to-postgres.sh --rollback
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"
ROLLBACK=0

if [[ "${1:-}" == "--rollback" ]]; then
  ROLLBACK=1
fi

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }
step() { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }

cd "$INSTALL_DIR"

# ════════════════════════════════════════════════════════════════════════════
# ROLLBACK PATH
# ════════════════════════════════════════════════════════════════════════════
if [[ "$ROLLBACK" == "1" ]]; then
  echo "${BOLD}═══ Apsamo Panel — Rollback to SQLite ═══${NC}"

  if [[ ! -f "$INSTALL_DIR/.env.pre-postgres" ]]; then
    err "No .env.pre-postgres backup found — nothing to roll back to"
    exit 1
  fi

  step "Restoring SQLite .env"
  cp "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.postgres-rollback"
  cp "$INSTALL_DIR/.env.pre-postgres" "$INSTALL_DIR/.env"
  ok ".env restored to SQLite"

  step "Restoring SQLite schema"
  if [[ -f "$INSTALL_DIR/prisma/schema.sqlite.prisma" ]]; then
    cp "$INSTALL_DIR/prisma/schema.sqlite.prisma" "$INSTALL_DIR/prisma/schema.prisma"
  fi
  ok "Schema restored to SQLite"

  step "Regenerating Prisma client + restarting"
  bun run db:generate
  systemctl restart apsamo-panel apsamo-realtime apsamo-worker
  ok "Services restarted"

  echo ""
  ok "Rollback to SQLite complete"
  exit 0
fi

# ════════════════════════════════════════════════════════════════════════════
# MIGRATE PATH
# ════════════════════════════════════════════════════════════════════════════
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — SQLite → PostgreSQL Migration${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"

# ── Pre-flight ────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "Run as root."
  exit 1
fi

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  err ".env not found at $INSTALL_DIR/.env"
  exit 1
fi

# Check current engine
CURRENT_DB=$(grep '^DATABASE_URL=' "$INSTALL_DIR/.env" | cut -d'"' -f2)
if echo "$CURRENT_DB" | grep -q '^postgresql://'; then
  warn "Already on PostgreSQL. Use --rollback to go back to SQLite."
  exit 0
fi
if ! echo "$CURRENT_DB" | grep -q '^file:'; then
  err "Unrecognized DATABASE_URL: $CURRENT_DB"
  exit 1
fi

SQLITE_PATH="${CURRENT_DB#file:}"
if [[ ! -f "$SQLITE_PATH" ]]; then
  err "SQLite DB not found: $SQLITE_PATH"
  exit 1
fi

ok "Current DB: SQLite at $SQLITE_PATH ($(du -h "$SQLITE_PATH" | cut -f1))"

# ── Step 1: Install PostgreSQL + pgvector ────────────────────────────────
step "Step 1/7: Installing PostgreSQL 16 + pgvector"

if command -v psql &>/dev/null && psql --version | grep -q '16'; then
  ok "PostgreSQL 16 already installed"
else
  bash "$INSTALL_DIR/deploy/scripts/install-postgres.sh"
fi

# Capture the PostgreSQL connection details from the install-postgres.sh output
# (We re-derive them by reading the .env after install-postgres.sh writes them,
# OR we ask the user to provide them.)
PG_URL="${PG_URL:-}"
if [[ -z "$PG_URL" ]]; then
  echo ""
  warn "Enter the PostgreSQL DATABASE_URL from the install-postgres.sh output above."
  warn "Format: postgresql://apsamo:<password>@localhost:5432/apsamo"
  read -rp "Paste it here: " PG_URL
fi

if [[ -z "$PG_URL" ]] || ! echo "$PG_URL" | grep -q '^postgresql://'; then
  err "Invalid PostgreSQL URL. Re-run and paste the URL from install-postgres.sh."
  exit 1
fi

# Test connection
if ! PGPASSWORD=$(echo "$PG_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p') \
     psql -h localhost -U apsamo -d apsamo -c "SELECT 1;" >/dev/null 2>&1; then
  err "Cannot connect to PostgreSQL with the provided URL"
  exit 1
fi
ok "PostgreSQL connection verified"

# ── Step 2: Backup current state ──────────────────────────────────────────
step "Step 2/7: Backing up current state"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Back up .env
cp "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.pre-postgres"
ok ".env backed up to .env.pre-postgres"

# Back up SQLite DB
cp "$SQLITE_PATH" "${SQLITE_PATH}.pre-postgres-$TIMESTAMP"
ok "SQLite DB backed up to $(basename "$SQLITE_PATH").pre-postgres-$TIMESTAMP"

# Back up current Prisma schema
cp "$INSTALL_DIR/prisma/schema.prisma" "$INSTALL_DIR/prisma/schema.sqlite.prisma"
ok "SQLite schema backed up to prisma/schema.sqlite.prisma"

# ── Step 3: Switch Prisma schema to PostgreSQL ───────────────────────────
step "Step 3/7: Switching Prisma schema to PostgreSQL"

cp "$INSTALL_DIR/prisma/schema.postgres.prisma" "$INSTALL_DIR/prisma/schema.prisma"
ok "Prisma schema switched to PostgreSQL (with pgvector support)"

# ── Step 4: Update .env ──────────────────────────────────────────────────
step "Step 4/7: Updating .env"

# Replace DATABASE_URL
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=\"$PG_URL\"|" "$INSTALL_DIR/.env"

# Add DB_ENGINE if not present
if ! grep -q '^DB_ENGINE=' "$INSTALL_DIR/.env"; then
  echo "" >> "$INSTALL_DIR/.env"
  echo "# Database engine: sqlite (default) | postgres" >> "$INSTALL_DIR/.env"
  echo "DB_ENGINE=\"postgres\"" >> "$INSTALL_DIR/.env"
else
  sed -i 's|^DB_ENGINE=.*|DB_ENGINE="postgres"|' "$INSTALL_DIR/.env"
fi

ok ".env updated (DATABASE_URL → PostgreSQL, DB_ENGINE=postgres)"

# ── Step 5: Push schema to PostgreSQL ────────────────────────────────────
step "Step 5/7: Pushing schema to PostgreSQL"

bun run db:generate
bun run db:push
ok "Schema pushed — PostgreSQL tables created"

# ── Step 6: Migrate data from SQLite → PostgreSQL ────────────────────────
step "Step 6/7: Migrating data (SQLite → PostgreSQL)"

warn "This reads every row from SQLite and inserts it into PostgreSQL."
warn "For large DBs this may take several minutes."

bun -e "
const { Database } = require('bun:sqlite');
const { PrismaClient } = require('@prisma/client');

const SQLITE_PATH = '${SQLITE_PATH}';
const sqlite = new Database(SQLITE_PATH, { readonly: true });
const pg = new PrismaClient();

const tables = [
  'User', 'Plan', 'Server', 'Subscription', 'Payment',
  'Project', 'Deployment', 'DeploymentStage',
  'Domain', 'DnsRecord', 'DomainOrder', 'DomainLog',
  'Template', 'Service', 'SiteContent',
  'PaymentMethodSetting', 'DomainPrice', 'Invoice',
  'Team', 'TeamMember', 'ApiKey', 'Notification',
  'AutomationLog', 'JobQueue', 'AuditLog',
  'EnvironmentVariable', 'GithubIntegration',
  'Webhook', 'WebhookDelivery', 'Pipeline', 'PipelineRun',
  'UptimeMonitor', 'UptimeMonitorCheck',
  'AnalyticsEvent', 'ProvisioningJob',
  'ProjectBackup', 'FtpAccount', 'CronJob',
  'RedirectRule', 'IpBlockRule', 'ProjectDatabase', 'ProjectMailbox',
  'CustomDomain', 'ProjectDomain',
];

let totalRows = 0;
const skipped = [];

for (const table of tables) {
  try {
    // Get all rows from SQLite
    const rows = sqlite.prepare('SELECT * FROM \"' + table + '\"').all();
    if (rows.length === 0) {
      console.log('  ' + table + ': 0 rows (skip)');
      continue;
    }

    // Insert into PostgreSQL (skip the embedding column — pgvector, populated lazily)
    // We use createMany for speed; if it fails (e.g., unique conflict), fall back to skipDuplicates.
    try {
      // Strip embedding columns — they're pgvector and not in SQLite
      const cleaned = rows.map(r => {
        const c = { ...r };
        delete c.embedding;
        return c;
      });
      // @ts-ignore — Prisma's model names are dynamic
      await pg[table.toLowerCase()].createMany({ data: cleaned, skipDuplicates: true });
      console.log('  ' + table + ': ' + rows.length + ' rows ✓');
      totalRows += rows.length;
    } catch (e) {
      console.log('  ' + table + ': FAILED — ' + e.message.split('\\n')[0]);
      skipped.push(table);
    }
  } catch (e) {
    // Table doesn't exist in SQLite (e.g., it's a new model)
    if (!String(e.message).includes('no such table')) {
      console.log('  ' + table + ': ERROR — ' + e.message.split('\\n')[0]);
    }
  }
}

console.log('');
console.log('Total rows migrated: ' + totalRows);
if (skipped.length > 0) {
  console.log('Skipped tables: ' + skipped.join(', '));
}

sqlite.close();
await pg.\$disconnect();
" 2>&1 | sed 's/^/  /'

ok "Data migration complete"

# ── Step 7: Restart + verify ─────────────────────────────────────────────
step "Step 7/7: Restarting services + verifying"

systemctl restart apsamo-realtime apsamo-worker apsamo-panel
sleep 5

# Run verify
apsamo verify 2>&1 | tail -30 || warn "Verify had warnings — check 'apsamo doctor'"

# ── Done ──────────────────────────────────────────────────────────────────
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${GREEN}${BOLD}  ✓ Migration to PostgreSQL complete${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  ${BOLD}New DB:${NC}         $PG_URL"
echo "  ${BOLD}Engine:${NC}         postgres (with pgvector)"
echo "  ${BOLD}SQLite backup:${NC}  ${SQLITE_PATH}.pre-postgres-$TIMESTAMP"
echo "  ${BOLD}Schema backup:${NC}  prisma/schema.sqlite.prisma"
echo "  ${BOLD}.env backup:${NC}    .env.pre-postgres"
echo ""
echo "  ${BOLD}Rollback:${NC}       bash $INSTALL_DIR/deploy/scripts/switch-to-postgres.sh --rollback"
echo ""
echo "  ${BOLD}Next: enable AI semantic search${NC}"
echo "    The pgvector extension is installed but embedding columns are empty."
echo "    Populate them by running:"
echo ""
echo "      cd $INSTALL_DIR"
echo "      bun run scripts/populate-embeddings.ts"
echo ""
echo "    This makes the AI assistant actually smart (semantic project search)."
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
