#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Scheduled production check with e-mail alerts.  Run from cron every 15 min:
#
#   */15 * * * * bash /opt/apsamo/deploy/scripts/live-check-cron.sh
#
# Runs live-check.sh (read-only) and e-mails ALERT_EMAIL only when the state
# CHANGES: healthy -> failing (with the failed checks) and failing -> healthy.
# No repeat mail while a problem persists. Mail goes through the panel's own
# sending mailbox (SMTP_HOST/PORT/USER/PASS in the panel .env); nothing is
# printed or logged with a password.
#
# ALERT_EMAIL: from the panel .env (ALERT_EMAIL, else ADMIN_EMAIL).
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="${APP_DIR:-/opt/apsamo}"
ENV_FILE="$APP_DIR/.env"
STATE_DIR=/var/lib/apsamo
STATE="$STATE_DIR/live-check.state"
LOG=/var/log/apsamo-live-check.log
BRAND="${BRAND:-apsamo.com}"
mkdir -p "$STATE_DIR"

envval() {
  local v
  v=$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)
  v="${v%$'\r'}"
  if [[ "$v" == \"*\" || "$v" == \'*\' ]]; then v="${v:1:${#v}-2}"; fi
  printf '%s' "$v"
}

out=$(bash "$APP_DIR/deploy/scripts/live-check.sh" "$BRAND" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
fails=$(printf '%s\n' "$out" | grep -E '^\s+FAIL ' || true)
now=$(date -u '+%Y-%m-%d %H:%M UTC')
summary=$(printf '%s\n' "$out" | grep -E '^Result:' | tail -1)
echo "$now $summary" >> "$LOG"

new_state=ok
[ -n "$fails" ] && new_state=fail
old_state=$(cat "$STATE" 2>/dev/null || echo ok)
echo "$new_state" > "$STATE"
[ "$new_state" = "$old_state" ] && exit 0

to=$(envval ALERT_EMAIL); [ -n "$to" ] || to=$(envval ADMIN_EMAIL)
host=$(envval SMTP_HOST); port=$(envval SMTP_PORT); user=$(envval SMTP_USER); pass=$(envval SMTP_PASS)
from=$(envval SMTP_FROM_EMAIL); [ -n "$from" ] || from="$user"
if [ -z "$to" ] || [ -z "$host" ] || [ -z "$user" ] || [ -z "$pass" ]; then
  echo "$now state changed to $new_state but no ALERT_EMAIL/SMTP settings; no mail sent" >> "$LOG"
  exit 0
fi

if [ "$new_state" = fail ]; then
  subject="[Apsamo] Production check FAILED on $(hostname)"
  body="The scheduled production check found problems at $now.

Failed checks:
$fails

$summary

Full output:
$out"
else
  subject="[Apsamo] Production check healthy again on $(hostname)"
  body="All production checks pass again at $now.

$summary"
fi

msg=$(mktemp)
{
  printf 'From: Apsamo Monitor <%s>\r\n' "$from"
  printf 'To: %s\r\n' "$to"
  printf 'Subject: %s\r\n' "$subject"
  printf 'Date: %s\r\n' "$(date -R)"
  printf 'Content-Type: text/plain; charset=utf-8\r\n\r\n'
  printf '%s\n' "$body"
} > "$msg"

proto=smtp; [ "${port:-587}" = "465" ] && proto=smtps
# Password via a curl config file on stdin, never on the command line.
if printf 'user = "%s:%s"\n' "$user" "$pass" | curl -sS --max-time 60 -K - \
     --url "$proto://$host:${port:-587}" --ssl-reqd \
     --mail-from "$from" --mail-rcpt "$to" --upload-file "$msg" >/dev/null 2>>"$LOG"; then
  echo "$now alert sent ($new_state)" >> "$LOG"
else
  echo "$now alert FAILED to send ($new_state)" >> "$LOG"
fi
rm -f "$msg"
