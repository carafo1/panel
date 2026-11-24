#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Connect the panel to the local PowerDNS API.  Idempotent.
#
#   sudo bash deploy/scripts/connect-powerdns.sh
#
# Without PDNS_API_URL / PDNS_API_KEY the panel cannot publish any DNS zone,
# so a customer who points their domain at ns1/ns2.<brand> gets REFUSED from
# our nameservers and the domain never connects. This reads the API key from
# PowerDNS's own config (never printed), checks the API answers with it, and
# writes both settings to the panel's .env (backed up first).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/apsamo}"
ENV_FILE="$APP_DIR/.env"
die() { echo "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = "0" ] || die "run as root"

conf_files=$(ls /etc/powerdns/pdns.conf /etc/powerdns/pdns.d/*.conf 2>/dev/null || true)
[ -n "$conf_files" ] || die "PowerDNS config not found in /etc/powerdns"
# shellcheck disable=SC2086
get() { grep -h "^$1=" $conf_files 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]'; }

[ "$(get api)" = "yes" ] || die "PowerDNS API is not enabled (api=yes)"
key="$(get api-key)"
[ -n "$key" ] || die "PowerDNS api-key is not set"
addr="$(get webserver-address)"; addr="${addr:-127.0.0.1}"
port="$(get webserver-port)"; port="${port:-8081}"
url="http://$addr:$port/api/v1/servers/localhost"

code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' -H "X-API-Key: $key" "$url" || true)
[ "$code" = "200" ] || die "PowerDNS API did not accept the key at $url (HTTP $code)"
echo "==> PowerDNS API answers at $url"

cp -p "$ENV_FILE" "$ENV_FILE.bak-pdns-$(date +%Y%m%d%H%M%S)"
tmp=$(mktemp)
grep -vE '^(PDNS_API_URL|PDNS_API_KEY)=' "$ENV_FILE" > "$tmp" || true
printf 'PDNS_API_URL=%s\nPDNS_API_KEY=%s\n' "$url" "$key" >> "$tmp"
cat "$tmp" > "$ENV_FILE"   # keep the file's owner and mode
rm -f "$tmp"
echo "==> PDNS_API_URL and PDNS_API_KEY written to $ENV_FILE"

systemctl restart apsamo-panel
echo "==> Panel restarted. Pending domains get their zone on the next sweep (every 2 minutes)."
