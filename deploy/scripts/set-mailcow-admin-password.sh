#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Set the Mailcow `admin` password to one YOU choose (typed twice, never shown).
#
#   sudo bash /opt/apsamo/deploy/scripts/set-mailcow-admin-password.sh
#
# Mailcow's own helper-scripts/mailcow-reset-admin.sh prints a long random
# password, which is easy to mistype from a console without copy-paste. This
# stores your own password, hashed by Dovecot (BLF-CRYPT) exactly as Mailcow
# stores admin passwords. Two-factor settings are left untouched.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

MC_DIR=""
for d in /opt/mailcow /opt/mailcow-dockerized; do [ -f "$d/mailcow.conf" ] && MC_DIR="$d" && break; done
[ -n "$MC_DIR" ] || { echo "Mailcow not found in /opt/mailcow or /opt/mailcow-dockerized" >&2; exit 1; }
[ "$(id -u)" = "0" ] || { echo "Run as root" >&2; exit 1; }
cd "$MC_DIR"
set -a; . ./mailcow.conf; set +a

read -rsp "New Mailcow admin password: " p1; echo
read -rsp "Type it again: " p2; echo
[ "$p1" = "$p2" ] || { echo "The two passwords are different. Nothing was changed." >&2; exit 1; }
[ "${#p1}" -ge 10 ] || { echo "Use at least 10 characters. Nothing was changed." >&2; exit 1; }

# Hash inside the Dovecot container; the password is passed on stdin, not argv.
hash=$(printf '%s\n%s\n' "$p1" "$p1" | docker compose exec -T dovecot-mailcow doveadm pw -s BLF-CRYPT 2>/dev/null | tr -d '\r\n')
unset p1 p2
case "$hash" in
  '{BLF-CRYPT}$2'*) ;;
  *) echo "Could not hash the password (Dovecot did not answer). Nothing was changed." >&2; exit 1 ;;
esac

docker compose exec -T mysql-mailcow mysql -u root -p"$DBROOT" "$DBNAME" \
  -e "UPDATE admin SET password='${hash}', active=1 WHERE username='admin';" 2>/dev/null
n=$(docker compose exec -T mysql-mailcow mysql -u root -p"$DBROOT" "$DBNAME" -N \
  -e "SELECT COUNT(*) FROM admin WHERE username='admin' AND password='${hash}';" 2>/dev/null | tr -d '\r')
[ "$n" = "1" ] || { echo "The admin account was not updated." >&2; exit 1; }

echo "Done. Sign in at https://mail.apsamo.com/admin with username: admin"
