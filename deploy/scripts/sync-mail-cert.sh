#!/usr/bin/env bash
#
# Give Mailcow the real Let's Encrypt certificate that Caddy already holds.
#
# mailcow.conf sets SKIP_LETS_ENCRYPT=y (correctly — Caddy owns port 80 on this
# host, so mailcow's own ACME client cannot complete an HTTP-01 challenge
# without fighting it). The result was that SMTP/IMAP served mailcow's
# self-signed snakeoil cert: any mail client, and the panel itself, got a
# certificate verification failure.
#
# Caddy already obtains and renews a valid cert for mail.apsamo.com, so copy
# that in rather than running a second ACME client. Caddy renews roughly every
# 60 days, so this runs from cron and reloads mailcow only when the cert has
# actually changed.
set -uo pipefail

DOMAIN="${MAIL_CERT_DOMAIN:-mail.apsamo.com}"
CADDY_DIR="/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${DOMAIN}"
MC_SSL="/opt/mailcow-dockerized/data/assets/ssl"
SRC_CRT="${CADDY_DIR}/${DOMAIN}.crt"
SRC_KEY="${CADDY_DIR}/${DOMAIN}.key"

log() { echo "[mail-cert] $*"; }

if [[ ! -f "$SRC_CRT" || ! -f "$SRC_KEY" ]]; then
  log "ERROR: Caddy cert for ${DOMAIN} not found at ${CADDY_DIR}"
  exit 1
fi

# Refuse to install anything that isn't currently valid — shipping an expired
# or malformed cert to the mail server is worse than leaving the old one.
if ! openssl x509 -in "$SRC_CRT" -noout -checkend 0 >/dev/null 2>&1; then
  log "ERROR: source certificate is expired or unreadable; not installing"
  exit 1
fi

# No-op when unchanged, so cron can run this often without churning mailcow.
if [[ -f "$MC_SSL/cert.pem" ]] && cmp -s "$SRC_CRT" "$MC_SSL/cert.pem"; then
  log "certificate already current — nothing to do"
  exit 0
fi

mkdir -p "$MC_SSL"
# Keep one rollback copy of whatever was there before.
[[ -f "$MC_SSL/cert.pem" ]] && cp -a "$MC_SSL/cert.pem" "$MC_SSL/cert.pem.prev"
[[ -f "$MC_SSL/key.pem" ]] && cp -a "$MC_SSL/key.pem" "$MC_SSL/key.pem.prev"

install -m 644 "$SRC_CRT" "$MC_SSL/cert.pem"
install -m 600 "$SRC_KEY" "$MC_SSL/key.pem"
log "installed $(openssl x509 -in "$MC_SSL/cert.pem" -noout -issuer)"

# Reload the services that terminate TLS for mail. Restart (not just reload)
# because postfix/dovecot read the cert at startup.
cd /opt/mailcow-dockerized || exit 1
for c in postfix-mailcow dovecot-mailcow nginx-mailcow; do
  name="mailcowdockerized-${c}-1"
  if docker ps --format '{{.Names}}' | grep -qx "$name"; then
    docker restart "$name" >/dev/null 2>&1 && log "restarted $c"
  fi
done

log "done"
