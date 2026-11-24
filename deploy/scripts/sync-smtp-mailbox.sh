#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Make the panel's sending mailbox accept the password the panel uses.
#
#   sudo bash deploy/scripts/sync-smtp-mailbox.sh
#
# The panel sends all email (password resets, notifications, invoices) through
# Mailcow as SMTP_USER with SMTP_PASS from /opt/apsamo/.env. If the mailbox's
# password is changed in Mailcow, every send fails ("Password mismatch") and
# the failures count toward Mailcow banning the server's own IP. This sets the
# mailbox password to SMTP_PASS (hashed by Dovecot, value never printed).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/apsamo/.env}"
MC_DIR=""
for d in /opt/mailcow /opt/mailcow-dockerized; do [ -f "$d/mailcow.conf" ] && MC_DIR="$d" && break; done
[ -n "$MC_DIR" ] || { echo "Mailcow not found" >&2; exit 1; }
[ "$(id -u)" = "0" ] || { echo "Run as root" >&2; exit 1; }

# Value of KEY from .env, surrounding quotes removed (contents untouched).
envval() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-)
  v="${v%$'\r'}"
  if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
  printf '%s' "$v"
}
user=$(envval SMTP_USER)
pass=$(envval SMTP_PASS)
[ -n "$user" ] && [ -n "$pass" ] || { echo "SMTP_USER or SMTP_PASS is empty in $ENV_FILE" >&2; exit 1; }
[[ "$user" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { echo "SMTP_USER is not a mailbox address" >&2; exit 1; }

cd "$MC_DIR"
set -a; . ./mailcow.conf; set +a
mysqlq() { docker compose exec -T mysql-mailcow mysql -u root -p"$DBROOT" "$DBNAME" -N -e "$1" 2>/dev/null | tr -d '\r'; }

[ "$(mysqlq "SELECT COUNT(*) FROM mailbox WHERE username='${user}' AND active=1;")" = "1" ] \
  || { echo "Mailbox $user does not exist or is not active" >&2; exit 1; }

hash=$(printf '%s\n%s\n' "$pass" "$pass" | docker compose exec -T dovecot-mailcow doveadm pw -s BLF-CRYPT 2>/dev/null | tr -d '\r\n')
unset pass
case "$hash" in '{BLF-CRYPT}$2'*) ;; *) echo "Could not hash the password" >&2; exit 1 ;; esac

mysqlq "UPDATE mailbox SET password='${hash}' WHERE username='${user}';" >/dev/null
[ "$(mysqlq "SELECT COUNT(*) FROM mailbox WHERE username='${user}' AND password='${hash}';")" = "1" ] \
  || { echo "Mailbox was not updated" >&2; exit 1; }
# Dovecot caches authentication results; drop the cache so the change applies now.
docker compose exec -T dovecot-mailcow doveadm auth cache flush >/dev/null 2>&1 || true
echo "Mailbox $user now accepts the panel's SMTP password."
