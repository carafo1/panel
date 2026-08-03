#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# backup.sh — Create a full backup of the Apsamo Panel
# ════════════════════════════════════════════════════════════════════════════
#
#   Includes:
#     • SQLite database (custom.db) — file-copied after a VACUUM
#     • STORAGE_ROOT directory (project files, backups, SQLite DBs)
#     • .env file (contains secrets — keep the backup safe!)
#     • Caddyfile (if present at /etc/caddy/Caddyfile)
#     • Systemd unit files (under /etc/systemd/system/apsamo-*.service)
#
#   Output: /opt/apsamo/backups/apsamo-backup-YYYYMMDD-HHMMSS.tar.gz
#
#   Options:
#     --keep N     Keep only the last N backups (default: 14)
#     --output F   Write to F instead of the default path
#     --no-storage Skip the storage dir (faster, smaller backup)
#
#   Usage:
#     apsamo backup
#     apsamo backup --keep 7
#     apsamo backup --output /tmp/snapshot.tar.gz --no-storage
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="/opt/apsamo"
BACKUP_DIR="$INSTALL_DIR/backups"
KEEP=14
OUTPUT=""
INCLUDE_STORAGE=1

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)         KEEP="$2"; shift 2 ;;
    --output)       OUTPUT="$2"; shift 2 ;;
    --no-storage)   INCLUDE_STORAGE=0; shift ;;
    *)              echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }

# ── Pre-flight ────────────────────────────────────────────────────────────
if [[ ! -d "$INSTALL_DIR" ]]; then
  err "Install dir not found: $INSTALL_DIR"
  exit 1
fi

if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  err ".env not found at $INSTALL_DIR/.env"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
if [[ -z "$OUTPUT" ]]; then
  OUTPUT="$BACKUP_DIR/apsamo-backup-$TIMESTAMP.tar.gz"
fi

# ── Read STORAGE_ROOT from .env ───────────────────────────────────────────
STORAGE_ROOT=$(grep '^STORAGE_ROOT=' "$INSTALL_DIR/.env" | cut -d'"' -f2)
STORAGE_ROOT="${STORAGE_ROOT:-$INSTALL_DIR/storage}"

DB_URL=$(grep '^DATABASE_URL=' "$INSTALL_DIR/.env" | cut -d'"' -f2)
DB_PATH="${DB_URL#file:}"

# ── Verify database ───────────────────────────────────────────────────────
if [[ ! -f "$DB_PATH" ]]; then
  warn "Database file not found: $DB_PATH — backing up without DB"
  DB_PATH=""
fi

# ── VACUUM the SQLite DB (creates a clean, defragged copy) ───────────────
if [[ -n "$DB_PATH" ]] && command -v sqlite3 &>/dev/null; then
  ok "VACUUMing database..."
  sqlite3 "$DB_PATH" "VACUUM;" 2>/dev/null || warn "VACUUM failed (continuing)"
fi

# ── Create staging dir ────────────────────────────────────────────────────
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/apsamo"

# Copy .env (contains secrets!)
cp "$INSTALL_DIR/.env" "$STAGE/apsamo/.env"

# Copy database (file copy is safe for SQLite when not actively writing)
if [[ -n "$DB_PATH" ]]; then
  ok "Copying database..."
  cp "$DB_PATH" "$STAGE/apsamo/custom.db"
fi

# Copy storage
if [[ "$INCLUDE_STORAGE" == "1" ]] && [[ -d "$STORAGE_ROOT" ]]; then
  ok "Copying storage (this may take a while)..."
  mkdir -p "$STAGE/apsamo/storage"
  cp -a "$STORAGE_ROOT/." "$STAGE/apsamo/storage/" 2>/dev/null || warn "Some storage files could not be copied"
fi

# Copy Caddyfile
if [[ -f /etc/caddy/Caddyfile ]]; then
  cp /etc/caddy/Caddyfile "$STAGE/apsamo/Caddyfile"
fi

# Copy systemd units
if ls /etc/systemd/system/apsamo-*.service >/dev/null 2>&1; then
  mkdir -p "$STAGE/apsamo/systemd"
  cp /etc/systemd/system/apsamo-*.service "$STAGE/apsamo/systemd/"
fi

# Write manifest
cat > "$STAGE/apsamo/MANIFEST.txt" <<EOF
Apsamo Panel Backup
───────────────────
Timestamp:   $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Hostname:    $(hostname)
Install dir: $INSTALL_DIR
Storage:     $STORAGE_ROOT
DB path:     $DB_PATH
DB size:     $([[ -n "$DB_PATH" ]] && du -h "$DB_PATH" | cut -f1 || echo "n/a")
Storage size: $([[ "$INCLUDE_STORAGE" == "1" ]] && [[ -d "$STORAGE_ROOT" ]] && du -sh "$STORAGE_ROOT" | cut -f1 || echo "skipped")
Created by:  $0 ${*:-}
EOF

# ── Create tarball ────────────────────────────────────────────────────────
ok "Compressing backup → $OUTPUT"
# The operator scripts live outside the repo, so nothing else captures them.
# apsamo-restore.sh in particular is what you want in your hands right after
# losing the server -- it should not be a casualty of the event it exists for.
mkdir -p "$STAGE/apsamo/bin"
cp -a /usr/local/bin/apsamo-*.sh "$STAGE/apsamo/bin/" 2>/dev/null || true
cp -a /usr/local/bin/apsamo "$STAGE/apsamo/bin/" 2>/dev/null || true

tar --exclude='storage/backups' --exclude='./storage/backups' -czf "$OUTPUT" -C "$STAGE" apsamo

# ── Show result ───────────────────────────────────────────────────────────
SIZE=$(du -h "$OUTPUT" | cut -f1)
ok "Backup created: $OUTPUT ($SIZE)"

# ── Prune old backups ────────────────────────────────────────────────────
if [[ "$OUTPUT" == "$BACKUP_DIR"/apsamo-backup-*.tar.gz ]]; then
  PRUNED=$(ls -1t "$BACKUP_DIR"/apsamo-backup-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)))
  if [[ -n "$PRUNED" ]]; then
    ok "Pruning old backups (keeping $KEEP):"
    echo "$PRUNED" | while read -r old; do
      rm -f "$old"
      echo "  removed: $(basename "$old")"
    done
  fi
fi

# ── Verify backup ─────────────────────────────────────────────────────────
ok "Verifying backup integrity..."
if tar -tzf "$OUTPUT" >/dev/null 2>&1; then
  ok "Backup verified OK"
  FILES=$(tar -tzf "$OUTPUT" | wc -l)
  echo "  $FILES files in archive"
else
  err "Backup verification FAILED — the tarball may be corrupt"
  exit 1
fi

echo ""
ok "Done. Restore with: apsamo restore $OUTPUT"
