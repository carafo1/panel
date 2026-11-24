#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Copy backups OFF the server with rclone.  Run nightly after the backups:
#
#   15 4 * * * bash /opt/apsamo/deploy/scripts/offsite-backup.sh
#
# Copies (never deletes at the destination unless OFFSITE_PRUNE_DAYS is set):
#   - panel backups          /opt/apsamo/backups
#   - customer site backups  /opt/apsamo/storage/backups
#   - Mailcow backups        $MAILCOW_BACKUP_DIR (default /var/backups/mailcow)
# to the rclone remote "apsamo-offsite" (any rclone backend: Netcup Storage
# Space via WebDAV/SFTP, Backblaze B2, S3, Google Drive, ...).
#
# One-time setup (as root):  rclone config   -> create a remote named
# "apsamo-offsite". Credentials stay in /root/.config/rclone/rclone.conf.
# Optional in /opt/apsamo/.env: OFFSITE_PATH (default apsamo-backups),
# OFFSITE_PRUNE_DAYS (delete remote copies older than N days).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apsamo}"
ENV_FILE="$APP_DIR/.env"
LOG=/var/log/apsamo-offsite-backup.log
REMOTE=apsamo-offsite

envval() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)
  v="${v%$'\r'}"
  if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
  printf '%s' "$v"
}
log() { echo "$(date -u '+%F %T') $*" | tee -a "$LOG"; }

command -v rclone >/dev/null || { log "rclone is not installed (apt-get install -y rclone)"; exit 1; }
rclone listremotes 2>/dev/null | grep -qx "$REMOTE:" || { log "rclone remote '$REMOTE' is not configured; run: rclone config"; exit 1; }

base=$(envval OFFSITE_PATH); base="${base:-apsamo-backups}"
host=$(hostname)
mc_dir="${MAILCOW_BACKUP_DIR:-/var/backups/mailcow}"
status=0

copy() { # local-dir remote-subdir
  local src="$1" dst="$REMOTE:$base/$host/$2"
  [ -d "$src" ] || { log "skip $2: $src does not exist"; return 0; }
  if rclone copy "$src" "$dst" --transfers 2 --checkers 4 --retries 3 --low-level-retries 5 \
       --min-age 5m --log-level NOTICE --log-file "$LOG"; then
    log "copied $2 -> $dst"
  else
    log "FAILED copying $2"; status=1
  fi
}

copy "$APP_DIR/backups" panel
copy "$APP_DIR/storage/backups" sites
copy "$mc_dir" mailcow

days=$(envval OFFSITE_PRUNE_DAYS)
if [[ "$days" =~ ^[0-9]+$ ]] && [ "$days" -ge 7 ]; then
  rclone delete "$REMOTE:$base/$host" --min-age "${days}d" --log-file "$LOG" --log-level NOTICE \
    && log "pruned remote copies older than ${days}d" || { log "FAILED pruning"; status=1; }
fi

# Proof the copy is usable: list the newest panel backup at the destination.
newest=$(rclone lsf "$REMOTE:$base/$host/panel" --files-only 2>/dev/null | sort | tail -1 || true)
[ -n "$newest" ] && log "newest remote panel backup: $newest" || { log "no panel backup found at the destination"; status=1; }
exit $status
