#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# restore.sh — Restore Apsamo Panel from a backup tarball
# ════════════════════════════════════════════════════════════════════════════
#
#   Usage:
#     apsamo restore /opt/apsamo/backups/apsamo-backup-20251201-030000.tar.gz
#
#   The script will:
#     1. Stop all panel services
#     2. Extract the backup to a staging dir
#     3. Restore .env, DB, storage, Caddyfile, systemd units
#     4. Restart all services
#
#   WARNING: This OVERWRITES the current installation. The current .env
#   and DB are backed up to .env.pre-restore and custom.db.pre-restore
#   before being replaced.
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="/opt/apsamo"
BACKUP_FILE="${1:-}"

# ── Colors ────────────────────────────────────────────────────────────────
RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }

# ── Pre-flight ────────────────────────────────────────────────────────────
if [[ -z "$BACKUP_FILE" ]]; then
  err "Usage: $0 <backup.tar.gz>"
  echo ""
  echo "Available backups:"
  ls -1t /opt/apsamo/backups/apsamo-backup-*.tar.gz 2>/dev/null | head -10 || echo "  (none)"
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  err "Backup file not found: $BACKUP_FILE"
  exit 1
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  err "Install dir not found: $INSTALL_DIR — run the installer first."
  exit 1
fi

echo "${BOLD}═══ Apsamo Panel — Restore ═══${NC}"
echo ""
echo "Backup:    $BACKUP_FILE"
echo "Target:    $INSTALL_DIR"
echo "Size:      $(du -h "$BACKUP_FILE" | cut -f1)"
echo ""
warn "This will OVERWRITE the current installation."
warn "Current .env and DB will be backed up with .pre-restore suffix."
echo ""
read -rp "${BOLD}Type 'yes' to continue:${NC} " confirm
[[ "$confirm" == "yes" ]] || { echo "Aborted."; exit 0; }

# ── Verify backup integrity ───────────────────────────────────────────────
ok "Verifying backup integrity..."
if ! tar -tzf "$BACKUP_FILE" >/dev/null 2>&1; then
  err "Backup file is corrupt or not a valid tarball"
  exit 1
fi

# ── Stop services ─────────────────────────────────────────────────────────
ok "Stopping services..."
for svc in apsamo-panel apsamo-realtime apsamo-worker; do
  systemctl stop "$svc" 2>/dev/null || warn "$svc not running"
done

# ── Pre-restore backup of current state ───────────────────────────────────
TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
if [[ -f "$INSTALL_DIR/.env" ]]; then
  cp "$INSTALL_DIR/.env" "$INSTALL_DIR/.env.pre-restore-$TIMESTAMP"
  ok "Current .env backed up to .env.pre-restore-$TIMESTAMP"
fi

DB_URL=$(grep '^DATABASE_URL=' "$INSTALL_DIR/.env" 2>/dev/null | cut -d'"' -f2 || echo "")
DB_PATH="${DB_URL#file:}"
if [[ -n "$DB_PATH" ]] && [[ -f "$DB_PATH" ]]; then
  cp "$DB_PATH" "${DB_PATH}.pre-restore-$TIMESTAMP"
  ok "Current DB backed up to ${DB_PATH##*/}.pre-restore-$TIMESTAMP"
fi

# ── Extract backup ────────────────────────────────────────────────────────
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

ok "Extracting backup..."
tar -xzf "$BACKUP_FILE" -C "$STAGE"

if [[ ! -d "$STAGE/apsamo" ]]; then
  err "Backup is malformed — no 'apsamo/' directory in tarball"
  exit 1
fi

SRC="$STAGE/apsamo"

# ── Restore .env ──────────────────────────────────────────────────────────
if [[ -f "$SRC/.env" ]]; then
  cp "$SRC/.env" "$INSTALL_DIR/.env"
  chmod 600 "$INSTALL_DIR/.env"
  ok ".env restored"
fi

# ── Restore DB ────────────────────────────────────────────────────────────
if [[ -f "$SRC/custom.db" ]]; then
  DB_URL=$(grep '^DATABASE_URL=' "$INSTALL_DIR/.env" | cut -d'"' -f2)
  DB_PATH="${DB_URL#file:}"
  mkdir -p "$(dirname "$DB_PATH")"
  cp "$SRC/custom.db" "$DB_PATH"
  ok "Database restored → $DB_PATH"
fi

# ── Restore storage ───────────────────────────────────────────────────────
STORAGE_ROOT=$(grep '^STORAGE_ROOT=' "$INSTALL_DIR/.env" | cut -d'"' -f2)
STORAGE_ROOT="${STORAGE_ROOT:-$INSTALL_DIR/storage}"
if [[ -d "$SRC/storage" ]]; then
  mkdir -p "$STORAGE_ROOT"
  rm -rf "$STORAGE_ROOT"/*
  cp -a "$SRC/storage/." "$STORAGE_ROOT/"
  ok "Storage restored → $STORAGE_ROOT"
fi

# ── Restore Caddyfile ─────────────────────────────────────────────────────
if [[ -f "$SRC/Caddyfile" ]] && [[ -f /etc/caddy/Caddyfile ]]; then
  cp /etc/caddy/Caddyfile "/etc/caddy/Caddyfile.pre-restore-$TIMESTAMP"
  cp "$SRC/Caddyfile" /etc/caddy/Caddyfile
  ok "Caddyfile restored (backup at /etc/caddy/Caddyfile.pre-restore-$TIMESTAMP)"
  caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy
fi

# ── Restore systemd units ─────────────────────────────────────────────────
if [[ -d "$SRC/systemd" ]]; then
  for unit in "$SRC"/systemd/*.service; do
    [[ -f "$unit" ]] || continue
    cp "$unit" /etc/systemd/system/
    ok "Restored unit: $(basename "$unit")"
  done
  systemctl daemon-reload
fi

# ── Restart services ──────────────────────────────────────────────────────
ok "Restarting services..."
for svc in apsamo-realtime apsamo-worker apsamo-panel; do
  systemctl restart "$svc"
  sleep 2
  status=$(systemctl is-active "$svc")
  if [[ "$status" == "active" ]]; then
    ok "$svc: active"
  else
    err "$svc: $status"
  fi
done

echo ""
echo "${BOLD}══════════════════════════════════════════════${NC}"
ok "Restore complete!"
echo ""
echo "  Pre-restore backups:"
echo "    .env:  $INSTALL_DIR/.env.pre-restore-$TIMESTAMP"
[[ -n "$DB_PATH" ]] && echo "    DB:    ${DB_PATH}.pre-restore-$TIMESTAMP"
echo ""
echo "  Verify with: apsamo status"
echo "  Roll back:   apsamo restore <pre-restore-backup>"
