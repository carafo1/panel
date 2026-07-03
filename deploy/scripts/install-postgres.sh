#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# install-postgres.sh — Install PostgreSQL 16 + pgvector for Apsamo Panel
# ════════════════════════════════════════════════════════════════════════════
#
#   Installs PostgreSQL 16 with the pgvector extension (for AI semantic
#   search), creates an `apsamo` database + user, and prints the
#   DATABASE_URL to use in .env.
#
#   Usage:
#     bash deploy/scripts/install-postgres.sh [--password <pw>] [--db <name>] [--user <name>]
#
#   Defaults:
#     --db        apsamo
#     --user      apsamo
#     --password  (auto-generated strong password)
#
#   After running, add this to /opt/apsamo/.env:
#     DATABASE_URL="postgresql://apsamo:<password>@localhost:5432/apsamo"
#     DB_ENGINE="postgres"
#
#   Then switch the Prisma schema and push:
#     cp prisma/schema.postgres.prisma prisma/schema.prisma
#     bun run db:push
#     apsamo restart panel
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────────
DB_NAME="apsamo"
DB_USER="apsamo"
DB_PASSWORD=""
INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --password) DB_PASSWORD="$2"; shift 2 ;;
    --db)       DB_NAME="$2"; shift 2 ;;
    --user)     DB_USER="$2"; shift 2 ;;
    --help|-h)
      grep '^#' "$0" | head -30
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Generate a strong password if not provided
if [[ -z "$DB_PASSWORD" ]]; then
  DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
fi

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'
BLUE=$'\033[0;34m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }
step() { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — PostgreSQL 16 + pgvector Installer${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"

# ── Pre-flight ────────────────────────────────────────────────────────────
if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root."
  exit 1
fi

if ! command -v openssl &>/dev/null; then
  err "openssl not found — install with: apt install -y openssl"
  exit 1
fi

# ── Step 1: Install PostgreSQL 16 ────────────────────────────────────────
step "Installing PostgreSQL 16"

if command -v psql &>/dev/null; then
  PG_VERSION=$(psql --version | awk '{print $3}' | cut -d. -f1)
  log_msg="PostgreSQL already installed (v$PG_VERSION)"
  if [[ "$PG_VERSION" -ge 14 ]]; then
    ok "$log_msg — using existing install"
  else
    warn "$log_msg — version < 14, will upgrade to 16"
    # Continue with install — apt will upgrade
  fi
fi

# Install PostgreSQL 16 from the official PostgreSQL APT repo (newer than distro)
if ! apt-cache show postgresql-16 &>/dev/null 2>&1; then
  echo "[install-postgres] adding PostgreSQL APT repo..."
  sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor -o /etc/apt/trusted.gpg.d/postgresql.gpg
  apt-get update -qq
fi

apt-get install -y -qq postgresql-16 postgresql-contrib-16

# Enable + start
systemctl enable --now postgresql
ok "PostgreSQL 16 installed and running"

# ── Step 2: Install pgvector extension ────────────────────────────────────
step "Installing pgvector extension"

PG_VECTOR_DIR="/tmp/pgvector"
if [[ ! -d "$PG_VECTOR_DIR" ]]; then
  git clone --depth 1 https://github.com/pgvector/pgvector.git "$PG_VECTOR_DIR"
fi

apt-get install -y -qq build-essential postgresql-server-dev-16
cd "$PG_VECTOR_DIR"
make clean
make PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config
make install PG_CONFIG=/usr/lib/postgresql/16/bin/pg_config
ok "pgvector extension compiled + installed"

# ── Step 3: Create database + user ────────────────────────────────────────
step "Creating database + user"

# Check if user already exists
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  warn "User '$DB_USER' already exists — leaving password unchanged"
else
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';"
  ok "User '$DB_USER' created"
fi

# Check if database already exists
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
  warn "Database '$DB_NAME' already exists"
else
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  ok "Database '$DB_NAME' created (owner: $DB_USER)"
fi

# Grant privileges
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" >/dev/null
sudo -u postgres psql -c "ALTER USER $DB_USER WITH SUPERUSER;" >/dev/null  # needed for CREATE EXTENSION
ok "Privileges granted"

# ── Step 4: Enable pgvector in the database ──────────────────────────────
step "Enabling pgvector extension"

sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
ok "pgvector extension enabled in '$DB_NAME'"

# Verify
VECTOR_VERSION=$(sudo -u postgres psql -d "$DB_NAME" -tAc "SELECT extversion FROM pg_extension WHERE extname='vector';")
ok "pgvector version: $VECTOR_VERSION"

# ── Step 5: Configure PostgreSQL for the panel's workload ────────────────
step "Tuning PostgreSQL config"

PG_CONF="/etc/postgresql/16/main/postgresql.conf"
PG_HBA="/etc/postgresql/16/main/pg_hba.conf"

# Backup configs
cp "$PG_CONF" "$PG_CONF.bak.$(date +%s)" 2>/dev/null || true
cp "$PG_HBA" "$PG_HBA.bak.$(date +%s)" 2>/dev/null || true

# Apply sensible defaults for a 4-8 GB VPS (only if not already set)
update_pg_conf() {
  local key=$1 val=$2
  if ! grep -qE "^${key}\s*=" "$PG_CONF"; then
    echo "${key} = ${val}" >> "$PG_CONF"
  fi
}

# Memory settings (tuned for 4GB VPS; scale up on bigger boxes)
update_pg_conf "shared_buffers" "512MB"
update_pg_conf "effective_cache_size" "1536MB"
update_pg_conf "work_mem" "16MB"
update_pg_conf "maintenance_work_mem" "128MB"

# WAL/checkpoint settings (better for write-heavy workloads)
update_pg_conf "wal_buffers" "16MB"
update_pg_conf "checkpoint_completion_target" "0.9"
update_pg_conf "random_page_cost" "1.1"  # SSD-tuned

# Connection settings
update_pg_conf "max_connections" "100"
update_pg_conf "listen_addresses" "'localhost'"  # only listen locally — Caddy proxies

# Ensure local connections use md5 (password) auth
if ! grep -q "host.*${DB_NAME}.*${DB_USER}.*md5" "$PG_HBA"; then
  echo "" >> "$PG_HBA"
  echo "# Apsamo Panel — local PostgreSQL access" >> "$PG_HBA"
  echo "host    ${DB_NAME}    ${DB_USER}    127.0.0.1/32    md5" >> "$PG_HBA"
  echo "host    ${DB_NAME}    ${DB_USER}    ::1/128         md5" >> "$PG_HBA"
fi

systemctl restart postgresql
ok "PostgreSQL config tuned + restarted"

# ── Step 6: Test connection ──────────────────────────────────────────────
step "Testing connection"

DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@localhost:5432/${DB_NAME}"
if PGPASSWORD="$DB_PASSWORD" psql -h localhost -U "$DB_USER" -d "$DB_NAME" -c "SELECT version();" >/dev/null 2>&1; then
  ok "Connection test passed"
else
  err "Connection test FAILED"
  err "Try manually: PGPASSWORD='$DB_PASSWORD' psql -h localhost -U $DB_USER -d $DB_NAME"
  exit 1
fi

# ── Step 7: Print summary + next steps ────────────────────────────────────
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${GREEN}${BOLD}  ✓ PostgreSQL 16 + pgvector installed${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  ${BOLD}Database:${NC}      $DB_NAME"
echo "  ${BOLD}User:${NC}          $DB_USER"
echo "  ${BOLD}Password:${NC}      $DB_PASSWORD"
echo "  ${BOLD}Host:${NC}          localhost:5432"
echo "  ${BOLD}pgvector:${NC}      v$VECTOR_VERSION"
echo ""
echo "  ${BOLD}DATABASE_URL:${NC}"
echo "    ${YELLOW}${DATABASE_URL}${NC}"
echo ""
echo "  ${BOLD}Next steps:${NC}"
echo ""
echo "  1. Add to $INSTALL_DIR/.env:"
echo ""
echo "       DATABASE_URL=\"${DATABASE_URL}\""
echo "       DB_ENGINE=\"postgres\""
echo ""
echo "  2. Switch the Prisma schema to PostgreSQL:"
echo ""
echo "       cd $INSTALL_DIR"
echo "       cp prisma/schema.postgres.prisma prisma/schema.prisma"
echo "       bun run db:push"
echo ""
echo "  3. Restart the panel:"
echo ""
echo "       apsamo restart"
echo ""
echo "  4. Verify:"
echo ""
echo "       apsamo verify"
echo ""
echo "  ${BOLD}Or use the one-command switcher:${NC}"
echo "    bash $INSTALL_DIR/deploy/scripts/switch-to-postgres.sh"
echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
