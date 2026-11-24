#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Install / update phpMyAdmin for the panel's single sign-on.  Idempotent.
#
#   sudo bash deploy/scripts/setup-phpmyadmin.sh [brand-domain]
#
# - Runs the official phpMyAdmin image as container `apsamo-pma`, published on
#   127.0.0.1 only (Caddy is the only public entry), joined to the `deployhub`
#   network so it can reach each customer's database container by name.
# - Mounts the signon config and signon.php from deploy/phpmyadmin: customers
#   arrive only through the panel's one-time ticket, as their OWN non-root
#   database user. There is no login form and no root access.
# - Sets PMA_URL / PMA_CONTAINER / PMA_HTTP_PORT in the panel's .env (names
#   only are printed, never values) and adds the Caddy site for pma.<brand>.
#   The panel emits the same block whenever it regenerates the Caddyfile.
#
# Requires: docker, caddy, the deployhub network, a DNS record for pma.<brand>
# pointing at this server.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

BRAND="${1:-apsamo.com}"
APP_DIR="${APP_DIR:-/opt/apsamo}"
ENV_FILE="$APP_DIR/.env"
HOST="pma.$BRAND"
PORT="${PMA_HTTP_PORT:-8892}"
NAME="${PMA_CONTAINER:-apsamo-pma}"
IMAGE="phpmyadmin:5.2.2-apache"
CONF_DIR="$APP_DIR/deploy/phpmyadmin"
CADDYFILE=/etc/caddy/Caddyfile

say() { echo "==> $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run as root"
command -v docker >/dev/null || die "docker is not installed"
[ -f "$CONF_DIR/config.user.inc.php" ] && [ -f "$CONF_DIR/signon.php" ] || die "missing $CONF_DIR files"
docker network inspect deployhub >/dev/null 2>&1 || die "docker network 'deployhub' not found"

say "Pulling $IMAGE"
docker pull -q "$IMAGE" >/dev/null

if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  say "Replacing existing container $NAME"
  docker rm -f "$NAME" >/dev/null
fi

say "Starting $NAME on 127.0.0.1:$PORT"
docker run -d --name "$NAME" --restart unless-stopped \
  --network deployhub \
  -p "127.0.0.1:$PORT:80" \
  --memory 256m --cpus 0.5 \
  --security-opt no-new-privileges \
  -e PMA_ARBITRARY=0 \
  -e PANEL_URL="https://panel.$BRAND" \
  -e UPLOAD_LIMIT=64M \
  -v "$CONF_DIR/config.user.inc.php:/etc/phpmyadmin/config.user.inc.php:ro" \
  -v "$CONF_DIR/signon.php:/var/www/html/signon.php:ro" \
  "$IMAGE" >/dev/null

# Wait until it answers locally.
for i in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)
  [[ "$code" =~ ^(200|302|401)$ ]] && break
  sleep 2
done
[[ "${code:-000}" =~ ^(200|302|401)$ ]] || die "phpMyAdmin did not start (HTTP ${code:-000}); see: docker logs $NAME"
say "phpMyAdmin answers locally (HTTP $code)"

say "Setting PMA_URL, PMA_CONTAINER, PMA_HTTP_PORT in $ENV_FILE"
cp -p "$ENV_FILE" "$ENV_FILE.bak-pma-$(date +%Y%m%d%H%M%S)"
set_env() {
  local key="$1" val="$2"
  if grep -q "^$key=" "$ENV_FILE"; then
    sed -i "s|^$key=.*|$key=$val|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}
set_env PMA_URL "https://$HOST"
set_env PMA_CONTAINER "$NAME"
set_env PMA_HTTP_PORT "$PORT"

if ! grep -q "^$HOST {" "$CADDYFILE"; then
  say "Adding the Caddy site for $HOST"
  cp -p "$CADDYFILE" "$CADDYFILE.bak-pma"
  email=$(grep -m1 -oE 'tls [^ ]+@[^ ]+' "$CADDYFILE" | awk '{print $2}')
  cat >> "$CADDYFILE" <<EOF

# ── phpMyAdmin (panel SSO only) — auto-managed ──
$HOST {
    encode gzip zstd
    header {
        X-Frame-Options "DENY"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "no-referrer"
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        -Server
    }
    reverse_proxy localhost:$PORT {
        header_up Host {host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
    tls ${email:-admin@$BRAND}
}
EOF
  if ! caddy validate --config "$CADDYFILE" >/dev/null 2>&1; then
    mv "$CADDYFILE.bak-pma" "$CADDYFILE"
    die "Caddy rejected the new site; the previous Caddyfile was restored"
  fi
  systemctl reload caddy
fi

say "Restarting the panel so it picks up PMA_URL"
systemctl restart apsamo-panel
say "Done. Open a database in the panel and click 'Open phpMyAdmin'."
