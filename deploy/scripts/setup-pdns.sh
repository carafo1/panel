#!/usr/bin/env bash
#
# Install PowerDNS Authoritative so ns1/ns2.apsamo.com actually answer queries.
#
# Until now those hostnames had A records but nothing listened on port 53, so
# telling a customer to delegate to them would have taken their domain offline
# completely. This makes the nameservers real.
#
# Deliberate choices:
#   - AUTHORITATIVE only, never a recursor. An open recursive resolver on a
#     public IP is a DNS-amplification reflector and would get the box
#     blackholed. `disable-axfr` + no recursion keeps it well-behaved.
#   - Bound to the PUBLIC IP, not 0.0.0.0, so it cannot collide with
#     systemd-resolved's stub listener on 127.0.0.53/127.0.0.54.
#   - SQLite backend: one file, no extra service to run or back up separately.
set -uo pipefail

# The server's public IPv4 (Netcup and most VPS hosts have no NAT, so the
# source address of the default route is the public one). Override with PUB_IP=.
PUB_IP="${PUB_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") print $(i+1)}')}"
if [[ -z "$PUB_IP" ]]; then
  echo "[pdns-setup] ERROR: could not detect the public IP; run again with PUB_IP=your.server.ip" >&2
  exit 1
fi
PDNS_DIR=/var/lib/powerdns
DB="$PDNS_DIR/pdns.sqlite3"

log() { echo "[pdns-setup] $*"; }

export DEBIAN_FRONTEND=noninteractive

log "installing packages…"
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq pdns-server pdns-backend-sqlite3 sqlite3 >/dev/null 2>&1 || {
  log "ERROR: package install failed"; exit 1; }

# Stop it immediately — the shipped default tries to bind 0.0.0.0:53.
systemctl stop pdns 2>/dev/null || true

log "creating sqlite schema…"
mkdir -p "$PDNS_DIR"
if [[ ! -f "$DB" ]]; then
  SCHEMA=$(ls /usr/share/pdns-backend-sqlite3/schema/schema.sqlite3.sql 2>/dev/null \
        || ls /usr/share/doc/pdns-backend-sqlite3/schema.sqlite3.sql* 2>/dev/null | head -1)
  if [[ -z "$SCHEMA" ]]; then log "ERROR: schema file not found"; exit 1; fi
  case "$SCHEMA" in
    *.gz) zcat "$SCHEMA" | sqlite3 "$DB" ;;
    *)    sqlite3 "$DB" < "$SCHEMA" ;;
  esac
fi
chown -R pdns:pdns "$PDNS_DIR"
chmod 640 "$DB"

log "writing config…"
# Generate an API key once and keep it stable across re-runs.
KEYFILE=/etc/powerdns/.api-key
if [[ -f "$KEYFILE" ]]; then API_KEY=$(cat "$KEYFILE"); else
  API_KEY=$(openssl rand -hex 24); echo "$API_KEY" > "$KEYFILE"; chmod 600 "$KEYFILE"
fi

cat > /etc/powerdns/pdns.conf <<EOF
# Managed by Apsamo — see deploy/scripts/setup-pdns.sh
launch=gsqlite3
gsqlite3-database=$DB

# Public authoritative listener. NOT 0.0.0.0: systemd-resolved owns
# 127.0.0.53/127.0.0.54 and binding both would fail.
local-address=$PUB_IP
local-port=53

# Authoritative only. No recursion, ever — an open resolver here would be
# abused for amplification attacks within hours.
disable-axfr=yes
version-string=anonymous

# API for the panel to create zones/records.
api=yes
api-key=$API_KEY
webserver=yes
webserver-address=127.0.0.1
webserver-port=8081
webserver-allow-from=127.0.0.1

# Answer for zones we host; refuse everything else rather than recursing.
default-soa-content=ns1.apsamo.com hostmaster.apsamo.com 0 10800 3600 604800 3600
default-ttl=3600
EOF
chmod 640 /etc/powerdns/pdns.conf
chown root:pdns /etc/powerdns/pdns.conf

log "opening firewall for DNS…"
ufw allow 53/udp >/dev/null 2>&1 || true
ufw allow 53/tcp >/dev/null 2>&1 || true

log "starting…"
systemctl enable pdns >/dev/null 2>&1
systemctl restart pdns
sleep 3

if systemctl is-active --quiet pdns; then
  log "pdns is running"
else
  log "ERROR: pdns failed to start"
  journalctl -u pdns -n 15 --no-pager | tail -10
  exit 1
fi

log "API key stored at $KEYFILE"
log "done"
