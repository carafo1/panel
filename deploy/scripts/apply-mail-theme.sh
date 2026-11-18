#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# apply-mail-theme.sh — Apsamo look for Mailcow and SOGo webmail
# ════════════════════════════════════════════════════════════════════════════
#
#   bash deploy/scripts/apply-mail-theme.sh
#
#   Uses only Mailcow's own customization hooks, all of which Mailcow's
#   updater keeps (they are in Mailcow's .gitignore):
#     • css/themes/apsamo/        theme.css + dark.css (Mailcow theme folder)
#     • Redis UI_THEME            = apsamo (same as System > Customize > Theme)
#     • Redis MAIN_LOGO(_DARK)    Apsamo logos (same as Customize > Logo)
#     • Redis TITLE_NAME / MAIN_NAME / UI_FOOTER   names and footer
#     • data/conf/sogo/custom-*   SOGo webmail palette and logos
#
#   Safe to re-run. Overwrites the names/footer/logos set in Customize.
#   Mailcow's original SOGo files are kept once as *.mailcow-default.
#   The Apsamo sign-in pages themselves are separate (deploy/mail-login).
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"
SRC="$INSTALL_DIR/deploy/mailcow-theme"
LOGOS="$INSTALL_DIR/deploy/mail-login"
MC_DIR="${MAILCOW_DIR:-}"
if [[ -z "$MC_DIR" ]]; then
  for d in /opt/mailcow /opt/mailcow-dockerized; do [[ -f "$d/mailcow.conf" ]] && MC_DIR="$d" && break; done
fi

ok()   { echo "✓ $*"; }
die()  { echo "✗ $*" >&2; exit 1; }

[[ -n "$MC_DIR" ]] || die "Mailcow not found in /opt/mailcow or /opt/mailcow-dockerized"
[[ -f "$SRC/apsamo/theme.css" ]] || die "Theme files missing in $SRC"
[[ -f "$LOGOS/logo-light.png" && -f "$LOGOS/logo-dark.png" ]] || die "Logos missing in $LOGOS"
cd "$MC_DIR"

# ── 1. Mailcow theme folder ───────────────────────────────────────────────
mkdir -p data/web/css/themes/apsamo
cp "$SRC"/apsamo/theme.json "$SRC"/apsamo/theme.css "$SRC"/apsamo/dark.css data/web/css/themes/apsamo/
chmod 755 data/web/css/themes/apsamo; chmod 644 data/web/css/themes/apsamo/*
ok "Mailcow theme installed (data/web/css/themes/apsamo)"

# ── 2. Customize settings in Redis (theme, logos, names, footer) ─────────
REDISPASS=$(grep -E '^REDISPASS=' mailcow.conf | cut -d= -f2-)
rcli() { docker compose exec -T redis-mailcow redis-cli -a "$REDISPASS" --no-auth-warning "$@"; }
# Values go in on stdin (-x) so long logos never hit the command line.
printf '%s' "apsamo" | rcli -x SET UI_THEME >/dev/null
printf '%s' "data:image/png;base64,$(base64 -w0 "$LOGOS/logo-light.png")" | rcli -x SET MAIN_LOGO >/dev/null
printf '%s' "data:image/png;base64,$(base64 -w0 "$LOGOS/logo-dark.png")" | rcli -x SET MAIN_LOGO_DARK >/dev/null
printf '%s' "Apsamo Mail" | rcli -x SET TITLE_NAME >/dev/null
printf '%s' "Apsamo Mail" | rcli -x SET MAIN_NAME >/dev/null
printf '%s' 'Apsamo Mail · <a href="https://apsamo.com" target="_blank" rel="noopener">apsamo.com</a> · <a href="https://apsamo.com/status" target="_blank" rel="noopener">Status</a> · <a href="https://apsamo.com/#/privacy" target="_blank" rel="noopener">Privacy</a>' | rcli -x SET UI_FOOTER >/dev/null
[[ "$(rcli GET UI_THEME | tr -d '\r')" == "apsamo" ]] || die "Could not select the theme in Redis"
ok "Theme selected, logos, names and footer set"

# ── 3. SOGo webmail palette and logos ────────────────────────────────────
# Written in place (cat >) because these files are bind-mounted into the SOGo
# container; replacing the file (cp/mv to a new inode) would hide the change.
for f in custom-theme.js custom-fulllogo.svg custom-shortlogo.svg custom-fulllogo.png; do
  dst="data/conf/sogo/$f"
  [[ -f "$dst" && ! -f "$dst.mailcow-default" ]] && cp -p "$dst" "$dst.mailcow-default"
  if [[ -f "$dst" ]]; then cat "$SRC/sogo/$f" > "$dst"; else cp "$SRC/sogo/$f" "$dst"; fi
done
ok "SOGo theme and logos written"
docker compose restart memcached-mailcow sogo-mailcow >/dev/null 2>&1 && ok "SOGo restarted"

echo "Done. Reload the Mailcow pages; dark mode uses the same theme."
