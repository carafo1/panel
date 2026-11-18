#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# backup-mailcow.sh — nightly backup of all mail data (Mailcow)
# ════════════════════════════════════════════════════════════════════════════
#
#   bash deploy/scripts/backup-mailcow.sh            # run a backup now
#   bash deploy/scripts/backup-mailcow.sh --install  # also schedule it (03:30)
#
#   Wraps Mailcow's own helper-scripts/backup_and_restore.sh, which backs up
#   mailboxes (vmail), the mail crypt key, MySQL, Rspamd, Redis and Postfix.
#   Backups go to $MAILCOW_BACKUP_LOCATION (default /var/backups/mailcow) and
#   are kept $KEEP_DAYS days (default 7).
#
#   This is an ON-SERVER copy. It protects against mistakes and broken
#   updates, not against losing the server: copy /var/backups/mailcow off
#   the machine as well (Netcup snapshot, rsync, or the panel's offsite
#   backup target).
#
#   Restore: cd /opt/mailcow && MAILCOW_BACKUP_LOCATION=/var/backups/mailcow \
#            ./helper-scripts/backup_and_restore.sh restore
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# Mailcow's script requires its target to be writable by "others" (the backup
# container runs as another user). So the target is a sub-folder inside a
# root-only (700) parent: open as Mailcow requires, unreachable for anyone
# but root.
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/mailcow}"
export MAILCOW_BACKUP_LOCATION="${MAILCOW_BACKUP_LOCATION:-$BACKUP_ROOT/data}"
KEEP_DAYS="${KEEP_DAYS:-7}"
LOG=/var/log/apsamo-mailcow-backup.log

MC_DIR="${MAILCOW_DIR:-}"
if [[ -z "$MC_DIR" ]]; then
  for d in /opt/mailcow /opt/mailcow-dockerized; do [[ -f "$d/mailcow.conf" ]] && MC_DIR="$d" && break; done
fi
[[ -n "$MC_DIR" ]] || { echo "Mailcow not found" >&2; exit 1; }

if [[ "${1:-}" == "--install" ]]; then
  SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
  ( crontab -l 2>/dev/null | grep -v 'backup-mailcow'
    echo "30 3 * * * bash $SELF >> $LOG 2>&1" ) | crontab -
  echo "✓ Scheduled daily at 03:30 (log: $LOG)"
fi

mkdir -p "$MAILCOW_BACKUP_LOCATION"
chmod 700 "$(dirname "$MAILCOW_BACKUP_LOCATION")"
chmod 1777 "$MAILCOW_BACKUP_LOCATION"
cd "$MC_DIR"
echo "[$(date -Is)] mailcow backup starting -> $MAILCOW_BACKUP_LOCATION"
# Mailcow's script asks no questions for 'backup'; THREADS keeps load low.
THREADS=1 ./helper-scripts/backup_and_restore.sh backup all --delete-days "$KEEP_DAYS"
echo "[$(date -Is)] mailcow backup finished"
