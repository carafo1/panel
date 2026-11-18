#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# setup-email.sh — Configure SMTP + install/configure Mailcow
# ════════════════════════════════════════════════════════════════════════════
#
#   Interactive script that:
#     1. Helps you configure SMTP (outgoing email — no install needed)
#     2. Optionally installs Mailcow (incoming email hosting — Docker)
#     3. Tests that email sending works
#
#   Usage:
#     bash deploy/scripts/setup-email.sh
#
#   Non-interactive mode (pre-fill via env vars):
#     SMTP_HOST=smtp.mailgun.org SMTP_USER=postmaster@mg.x.com SMTP_PASS=xxx \
#     INSTALL_MAILCOW=n bash deploy/scripts/setup-email.sh
#
#   After running, restart the panel: apsamo restart panel
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-/opt/apsamo}"
ENV_FILE="$INSTALL_DIR/.env"

# ── Colors ────────────────────────────────────────────────────────────────
GREEN=$'\033[0;32m'; YELLOW=$'\033[1;33m'; BLUE=$'\033[0;34m'
RED=$'\033[0;31m'; BOLD=$'\033[1m'; NC=$'\033[0m'
ok()   { echo "${GREEN}✓${NC} $*"; }
warn() { echo "${YELLOW}!${NC} $*"; }
err()  { echo "${RED}✗${NC} $*" >&2; }
step() { echo ""; echo "${BLUE}${BOLD}── $* ──${NC}"; }
ask()      { read -rp "$* " ans; echo "$ans"; }
ask_secret() { read -rsp "$* " ans; echo >&2; echo "$ans"; }

echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo "${BOLD}  Apsamo Panel — Email Setup (SMTP + Mailcow)${NC}"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  This script configures:"
echo "    1. SMTP  — outgoing email (verification, password resets, receipts)"
echo "               • No installation needed — just configuration"
echo "               • Use Mailgun / SendGrid / AWS SES / any SMTP provider"
echo ""
echo "    2. Mailcow — incoming email hosting (customer mailboxes)"
echo "               • REQUIRES installation (Dockerized email server)"
echo "               • Needs port 25 open; 8 GB RAM recommended (low-memory mode below 6 GB)"
echo ""

if [[ ! -f "$ENV_FILE" ]]; then
  err ".env not found at $ENV_FILE — run install.sh first."
  exit 1
fi

cd "$INSTALL_DIR"

# ── Helper: update or append a key in .env ────────────────────────────────
env_set() {
  local key=$1 val=$2
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=.*|${key}=\"${val}\"|" "$ENV_FILE"
  else
    echo "${key}=\"${val}\"" >> "$ENV_FILE"
  fi
}

env_get() {
  local key=$1
  grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d'"' -f2
}

# ════════════════════════════════════════════════════════════════════════════
# PART 1: SMTP CONFIGURATION
# ════════════════════════════════════════════════════════════════════════════
step "Part 1/3: SMTP Configuration (outgoing email)"

echo "  SMTP is what sends emails FROM your panel (verification links,"
echo "  password resets, billing receipts). No installation needed —"
echo "  you just need an account with one of these providers:"
echo ""
echo "    • Mailgun   — 5,000 free emails/mo for 3 months  → https://mailgun.com"
echo "    • SendGrid  — 12,000 free emails/mo forever       → https://sendgrid.com"
echo "    • AWS SES   — \$0.10 per 1,000 emails           → https://aws.amazon.com/ses"
echo "    • Or any SMTP provider (Zoho, Postmark, etc.)"
echo ""

CURRENT_SMTP_HOST=$(env_get SMTP_HOST)
if [[ -n "$CURRENT_SMTP_HOST" ]]; then
  echo "  Current SMTP host: $CURRENT_SMTP_HOST"
  read -rp "  Reconfigure SMTP? [y/N]: " reconfig
  [[ "$reconfig" =~ ^[Yy] ]] || SKIP_SMTP=1
fi

if [[ "${SKIP_SMTP:-0}" != "1" ]]; then
  echo ""
  echo "  Choose your SMTP provider:"
  echo "    1. Mailgun  (smtp.mailgun.org:587)"
  echo "    2. SendGrid (smtp.sendgrid.net:587)"
  echo "    3. AWS SES  (email-smtp.us-east-1.amazonaws.com:587)"
  echo "    4. Other    (enter manually)"
  echo ""
  provider=$(ask "  Provider [1-4]:")

  case "$provider" in
    1)
      SMTP_HOST="smtp.mailgun.org"
      SMTP_PORT="587"
      echo ""
      echo "  Mailgun SMTP credentials:"
      echo "  Get them at: https://app.mailgun.com/app/sending/domains → your domain → SMTP"
      echo ""
      SMTP_USER=$(ask "  SMTP User (postmaster@mg.yourdomain.com): ")
      SMTP_PASS=$(ask_secret "  SMTP Password (hidden): ")
      ;;
    2)
      SMTP_HOST="smtp.sendgrid.net"
      SMTP_PORT="587"
      echo ""
      echo "  SendGrid SMTP credentials:"
      echo "  - User is literally the word 'apikey'"
      echo "  - Password is your API key from https://app.sendgrid.com/settings/api_keys"
      echo ""
      SMTP_USER="apikey"
      SMTP_PASS=$(ask_secret "  SendGrid API key (hidden): ")
      ;;
    3)
      SMTP_HOST="email-smtp.us-east-1.amazonaws.com"
      SMTP_PORT="587"
      echo ""
      echo "  AWS SES SMTP credentials:"
      echo "  Get them at: https://console.aws.amazon.com/ses/home → SMTP Settings → Create SMTP Credentials"
      echo ""
      SMTP_USER=$(ask "  SMTP Username: ")
      SMTP_PASS=$(ask_secret "  SMTP Password (hidden): ")
      ;;
    4)
      SMTP_HOST=$(ask "  SMTP Host: ")
      SMTP_PORT=$(ask "  SMTP Port [587]: ")
      SMTP_PORT="${SMTP_PORT:-587}"
      SMTP_USER=$(ask "  SMTP User: ")
      SMTP_PASS=$(ask_secret "  SMTP Password (hidden): ")
      ;;
    *)
      warn "Skipping SMTP configuration"
      SKIP_SMTP=1
      ;;
  esac

  if [[ "${SKIP_SMTP:-0}" != "1" ]]; then
    BRAND_DOMAIN=$(env_get BRAND_DOMAIN)
    FROM_EMAIL=$(ask "  From email address [no-reply@$BRAND_DOMAIN]: ")
    FROM_EMAIL="${FROM_EMAIL:-no-reply@$BRAND_DOMAIN}"
    FROM_NAME=$(ask "  From name [Apsamo Panel]: ")
    FROM_NAME="${FROM_NAME:-Apsamo Panel}"

    env_set "SMTP_HOST" "$SMTP_HOST"
    env_set "SMTP_PORT" "$SMTP_PORT"
    env_set "SMTP_USER" "$SMTP_USER"
    env_set "SMTP_PASS" "$SMTP_PASS"
    env_set "SMTP_FROM_NAME" "$FROM_NAME"
    env_set "SMTP_FROM_EMAIL" "$FROM_EMAIL"

    ok "SMTP configured: $SMTP_HOST:$SMTP_PORT as $SMTP_USER"
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
# PART 2: MAILCOW INSTALLATION (optional)
# ════════════════════════════════════════════════════════════════════════════
step "Part 2/3: Mailcow (incoming email hosting)"

echo "  Mailcow is a full email server (IMAP/SMTP/webmail) that runs in Docker"
echo "  on your VPS. It lets you create customer mailboxes like user@yourdomain.com."
echo ""
echo "  Requirements:"
echo "    • 6+ GB RAM, or low-memory mode on smaller servers (swap, no ClamAV)"
echo "    • Port 25 OPEN (many cloud providers block it — see below)"
echo "    • A subdomain like mail.yourdomain.com pointing to this VPS"
echo ""
echo "  Port 25 status by provider:"
echo "    • Hetzner:        OPEN ✓"
echo "    • DigitalOcean:   BLOCKED (request unblock via support ticket)"
echo "    • AWS:            BLOCKED (fill out port-25 request form)"
echo "    • Vultr:          BLOCKED on new accounts"
echo ""
echo "  If outbound port 25 is blocked, Mailcow can receive mail but cannot deliver it."
echo "  Ask your provider to unblock it, or use Zoho Mail / Google Workspace instead."
echo ""

CURRENT_MAILCOW=$(env_get MAILCOW_API_URL)
if [[ -n "$CURRENT_MAILCOW" ]]; then
  echo "  Mailcow already configured: $CURRENT_MAILCOW"
  read -rp "  Reconfigure? [y/N]: " reconfig
  [[ "$reconfig" =~ ^[Yy] ]] || SKIP_MAILCOW=1
fi

if [[ "${SKIP_MAILCOW:-0}" != "1" ]]; then
  if [[ -z "${INSTALL_MAILCOW:-}" ]]; then
    read -rp "  Install Mailcow? [y/N]: " INSTALL_MAILCOW
  fi
  INSTALL_MAILCOW="${INSTALL_MAILCOW:-n}"

  if [[ "$INSTALL_MAILCOW" =~ ^[Yy] ]]; then
    # ── Pre-flight checks ─────────────────────────────────────────────
    step "Mailcow pre-flight checks"

    # Memory. Mailcow asks for 6 GB. Below that, run it in low-memory mode
    # rather than refusing, aiming for Mailcow itself to use under ~1.5 GB:
    # add a swap file and leave off the optional heavy parts: ClamAV virus
    # scanner (about 1 GB on its own), Olefy (Office macro scanner) and the
    # full-text search index (searching mail still works, just slower).
    # Rspamd spam filtering and SOGo webmail (the panel's webmail sign-in uses
    # it) stay on. Re-enable any of them later in /opt/mailcow/mailcow.conf
    # (SKIP_CLAMD=n, SKIP_OLEFY=n, SKIP_FTS=n) and run: docker compose up -d
    LOW_MEMORY=0
    MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
    if [[ "$MEM_MB" -lt 5800 ]]; then
      LOW_MEMORY=1
      warn "RAM: ${MEM_MB} MB, below Mailcow's 6 GB. Using low-memory mode:"
      warn "  a swap file is added; ClamAV, Olefy and full-text search are left"
      warn "  off (spam filtering and webmail stay on)."
      read -rp "  Continue in low-memory mode? [Y/n]: " ans_mem
      [[ "$ans_mem" =~ ^[Nn] ]] && { echo "Skipping Mailcow."; INSTALL_MAILCOW=n; }
    else
      ok "RAM: ${MEM_MB} MB (sufficient)"
    fi

    # Outbound port 25 is what delivers mail to other servers (Gmail, Outlook…).
    # Inbound port 25 cannot be tested from inside the server.
    if [[ "$INSTALL_MAILCOW" =~ ^[Yy] ]]; then
      echo ""
      echo "  Checking outbound port 25..."
      if timeout 8 bash -c 'exec 3<>/dev/tcp/gmail-smtp-in.l.google.com/25 && head -c 3 <&3' 2>/dev/null | grep -q 220; then
        ok "Port 25 outbound: OPEN (this server can deliver mail to other servers)"
      else
        warn "Port 25 outbound: BLOCKED. Mailcow could receive mail but not deliver"
        warn "  it to Gmail/Outlook. Ask your VPS provider to unblock port 25."
        read -rp "  Install anyway? [y/N]: " ans_25
        [[ "$ans_25" =~ ^[Yy] ]] || { echo "Skipping Mailcow."; INSTALL_MAILCOW=n; }
      fi
    fi

    # Check if Mailcow is already installed
    if [[ -d "/opt/mailcow" ]] && [[ "$INSTALL_MAILCOW" =~ ^[Yy] ]]; then
      ok "Mailcow already installed at /opt/mailcow"
      read -rp "  Reconfigure? [y/N]: " reconfig_mc
      [[ "$reconfig_mc" =~ ^[Yy] ]] || INSTALL_MAILCOW=skip
    fi
  fi

  if [[ "$INSTALL_MAILCOW" =~ ^[Yy]$ ]]; then
    # ── Install Mailcow ───────────────────────────────────────────────
    step "Installing Mailcow"

    BRAND_DOMAIN=$(env_get BRAND_DOMAIN)
    MAIL_HOSTNAME=$(ask "  Mailcow hostname [mail.$BRAND_DOMAIN]: ")
    MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.$BRAND_DOMAIN}"

    # Check DNS resolves to this server
    VPS_IP=$(curl -s -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    MAIL_IP=$(getent ahostsv4 "$MAIL_HOSTNAME" 2>/dev/null | awk 'NR==1 {print $1}')

    if [[ -n "$MAIL_IP" ]] && [[ "$MAIL_IP" != "$VPS_IP" ]]; then
      warn "$MAIL_HOSTNAME resolves to $MAIL_IP (this VPS is $VPS_IP)"
      warn "  Add an A record: $MAIL_HOSTNAME → $VPS_IP at your DNS registrar"
      read -rp "  Continue install anyway? [y/N]: " continue
      [[ "$continue" =~ ^[Yy] ]] || { echo "Aborting."; exit 1; }
    elif [[ -z "$MAIL_IP" ]]; then
      warn "$MAIL_HOSTNAME doesn't resolve yet — DNS not propagated"
      warn "  After install, add A record: $MAIL_HOSTNAME → $VPS_IP"
    else
      ok "DNS: $MAIL_HOSTNAME → $VPS_IP ✓"
    fi

    # Install Docker if needed
    if ! command -v docker &>/dev/null; then
      echo "  Installing Docker..."
      curl -fsSL https://get.docker.com | sh
      systemctl enable --now docker
      ok "Docker installed"
    fi

    # Tools Mailcow's generate_config.sh refuses to run without.
    for bin in jq openssl git curl; do
      command -v "$bin" &>/dev/null && continue
      apt-get install -y -qq "$bin" >/dev/null 2>&1 \
        || { apt-get update -qq && apt-get install -y -qq "$bin" >/dev/null; }
    done

    # Swap (low-memory mode only). 4 GB, only if there is no swap yet and the
    # disk has room. Low swappiness: it is a safety net, not working memory.
    if [[ "$LOW_MEMORY" == 1 ]] && [[ -z "$(swapon --show=NAME --noheadings 2>/dev/null)" ]]; then
      FREE_GB=$(df --output=avail -BG / | tail -1 | tr -dc '0-9')
      if [[ "${FREE_GB:-0}" -ge 10 ]]; then
        fallocate -l 4G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
        chmod 600 /swapfile
        mkswap /swapfile >/dev/null
        swapon /swapfile
        grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
        echo 'vm.swappiness=10' > /etc/sysctl.d/90-apsamo-swap.conf
        sysctl -q -p /etc/sysctl.d/90-apsamo-swap.conf || true
        ok "Added a 4 GB swap file (/swapfile)"
      else
        warn "Only ${FREE_GB} GB disk free; not adding swap. Watch memory closely."
      fi
    fi

    # Clone Mailcow
    if [[ ! -d "/opt/mailcow" ]]; then
      echo "  Cloning Mailcow..."
      git clone https://github.com/mailcow/mailcow-dockerized /opt/mailcow
    fi
    cd /opt/mailcow

    # Generate config. Answers go in through generate_config.sh's own
    # environment variables, never as piped text: its prompt order changes
    # between Mailcow releases (piping "y / hostname / UTC" would make "y" the
    # hostname on current versions).
    echo "  Generating Mailcow config (hostname: $MAIL_HOSTNAME)..."
    if [[ -f mailcow.conf ]]; then
      cp mailcow.conf "mailcow.conf.before-apsamo-$(date +%Y%m%d-%H%M%S)"
      rm -f mailcow.conf
    fi
    SERVER_TZ=$(timedatectl show -p Timezone --value 2>/dev/null || true)
    [[ "$LOW_MEMORY" == 1 ]] && MC_SKIP_CLAMD=y || MC_SKIP_CLAMD=n
    # FORCE=y answers the remaining Docker IPv6 prompts with yes. Answering no
    # makes generate_config.sh EXIT on any host with working IPv6. Yes only
    # sets "ipv6": true in /etc/docker/daemon.json and restarts Docker once;
    # Mailcow's own network is still kept IPv4-only below (ENABLE_IPV6=false).
    # FORCE's only other effect is removing unused old Mailcow images.
    MAILCOW_HOSTNAME="$MAIL_HOSTNAME" MAILCOW_TZ="${SERVER_TZ:-UTC}" \
      SKIP_CLAMD="$MC_SKIP_CLAMD" MAILCOW_BRANCH=master FORCE=y \
      ./generate_config.sh < /dev/null
    [[ -f mailcow.conf ]] || { err "generate_config.sh did not create mailcow.conf"; exit 1; }

    # Caddy already owns ports 80/443 on this server and serves every website.
    # Mailcow's web UI must listen on localhost only, behind Caddy, and must
    # not run its own Let's Encrypt client (Caddy issues the certificate and
    # sync-mail-cert.sh copies it into Mailcow for SMTP/IMAP).
    set_mc() {
      if grep -qE "^$1=" mailcow.conf; then sed -i "s|^$1=.*|$1=$2|" mailcow.conf; else echo "$1=$2" >> mailcow.conf; fi
    }
    set_mc HTTP_PORT 8080
    set_mc HTTP_BIND 127.0.0.1
    set_mc HTTPS_PORT 8443
    set_mc HTTPS_BIND 127.0.0.1
    set_mc HTTP_REDIRECT n
    set_mc SKIP_LETS_ENCRYPT y
    # IPv6 off: outgoing mail over IPv6 is rejected by Gmail and others unless
    # the IPv6 address has its own matching reverse DNS, which a fresh VPS
    # does not. IPv4 delivery is what the PTR record is set up for.
    set_mc ENABLE_IPV6 false
    set_mc SKIP_CLAMD "$MC_SKIP_CLAMD"
    if [[ "$LOW_MEMORY" == 1 ]]; then
      set_mc SKIP_OLEFY y
      set_mc SKIP_FTS y
      # SOGo (webmail) starts 20 workers by default; 5 serve a small user base
      # and cut its memory from ~260 MB to ~95 MB (measured on a 4 GB VPS,
      # Mailcow total ~1.35 GB). Raise it again if webmail feels slow under load.
      sed -i 's/WOWorkersCount = "[0-9]*";/WOWorkersCount = "5";/' data/conf/sogo/sogo.conf
    fi
    ok "Mailcow web UI bound to 127.0.0.1:8080 (served publicly by Caddy)"
    [[ "$LOW_MEMORY" == 1 ]] && ok "Low-memory mode: ClamAV, Olefy and full-text search off; SOGo 5 workers"

    # Firewall: mail ports. (Docker-published ports bypass ufw anyway, but the
    # rules make the intent visible in `ufw status`.)
    if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
      for p in 25 465 587 143 993 110 995 4190; do ufw allow "$p/tcp" >/dev/null; done
      ok "Firewall: opened mail ports 25 465 587 143 993 110 995 4190"
    fi

    # Caddy site for the mail hostname (webmail + admin), plus autodiscover /
    # autoconfig for the brand domain when they point here (mail apps use them
    # to configure themselves). Validated before use; on any error the previous
    # Caddyfile is restored.
    MAIL_SITES="$MAIL_HOSTNAME"
    for h in "autodiscover.$BRAND_DOMAIN" "autoconfig.$BRAND_DOMAIN"; do
      [[ "$(getent ahostsv4 "$h" 2>/dev/null | awk 'NR==1 {print $1}')" == "$VPS_IP" ]] && MAIL_SITES="$MAIL_SITES, $h"
    done
    # Apsamo Mail sign-in page (deploy/mail-login). Served by Caddy in front of
    # Mailcow for a plain GET / on the mail host; its form posts Mailcow's own
    # login fields to "/", so no Mailcow file is changed and Mailcow updates
    # cannot remove it. Everything else (/admin, /SOGo, /api, /?classic=1 for
    # passkeys and two-factor) still goes to Mailcow.
    LOGIN_SRC="$INSTALL_DIR/deploy/mail-login"
    if [[ -f "$LOGIN_SRC/index.html" ]]; then
      mkdir -p /srv/apsamo-mail-login
      cp "$LOGIN_SRC"/index.html "$LOGIN_SRC"/*.png /srv/apsamo-mail-login/
      chmod 755 /srv/apsamo-mail-login; chmod 644 /srv/apsamo-mail-login/*
      ok "Apsamo Mail sign-in page installed (/srv/apsamo-mail-login)"
    fi

    if ! grep -qE "^\s*${MAIL_HOSTNAME//./\\.}[ ,{]" /etc/caddy/Caddyfile 2>/dev/null; then
      cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-mailcow
      cat >> /etc/caddy/Caddyfile <<CADDY

# ─── Mailcow webmail / admin (added by setup-email.sh) ────────────────
${MAIL_SITES} {
    # Apsamo Mail sign-in page for a plain GET / on the mail host.
    @apsamo_login {
        host ${MAIL_HOSTNAME}
        method GET HEAD
        path /
        not query classic=*
    }
    handle @apsamo_login {
        root * /srv/apsamo-mail-login
        rewrite * /index.html
        header Cache-Control "no-store"
        file_server
    }
    handle_path /apsamo-login/* {
        root * /srv/apsamo-mail-login
        file_server
    }
    handle {
        reverse_proxy 127.0.0.1:8080
    }
}
CADDY
      if caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
        systemctl reload caddy && ok "Caddy now serves https://${MAIL_HOSTNAME}"
      else
        cp /etc/caddy/Caddyfile.before-mailcow /etc/caddy/Caddyfile
        warn "Caddy rejected the mail site; the previous Caddyfile was restored."
      fi
    fi

    # Start Mailcow
    echo "  Starting Mailcow containers (~2 minutes)..."
    docker compose up -d
    sleep 30

    # Wait for it to be ready
    echo "  Waiting for Mailcow to be ready..."
    for i in $(seq 1 12); do
      if curl -sk -o /dev/null -w '%{http_code}' "https://$MAIL_HOSTNAME" 2>/dev/null | grep -q "200\|301\|302"; then
        ok "Mailcow is up at https://$MAIL_HOSTNAME"
        break
      fi
      echo "  attempt $i: waiting..."
      sleep 10
    done

    echo ""
    echo "${BOLD}  ── Mailcow Admin Setup ──${NC}"
    echo ""
    echo "  1. Open: https://$MAIL_HOSTNAME"
    echo "  2. Log in with default credentials:"
    echo "       Username: admin"
    echo "       Password: moohoo"
    echo "  3. CHANGE THE PASSWORD immediately"
    echo "  4. Go to: System → Configuration → Access → API"
    echo "  5. In the Read/Write section: enter a key (or let Mailcow make one),"
    echo "     put  $VPS_IP  in 'Allow API access from these IPs', tick Activate"
    echo "  6. Copy the API key"
    echo ""
    read -rp "  Press Enter after you've copied the API key..."

    MAILCOW_API_KEY=$(ask_secret "  Paste the Mailcow API key (hidden):")

    env_set "MAILCOW_API_URL" "https://$MAIL_HOSTNAME"
    env_set "MAILCOW_API_KEY" "$MAILCOW_API_KEY"
    env_set "MAIL_SERVER_HOSTNAME" "$MAIL_HOSTNAME"

    ok "Mailcow configured: https://$MAIL_HOSTNAME"

    # SMTP/IMAP use the certificate Caddy obtained for $MAIL_HOSTNAME.
    SYNC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/sync-mail-cert.sh"
    if [[ -f "$SYNC" ]]; then
      curl -s -o /dev/null "https://$MAIL_HOSTNAME" || true   # makes Caddy request the certificate
      sleep 15
      MAIL_CERT_DOMAIN="$MAIL_HOSTNAME" bash "$SYNC" || warn "Certificate not copied yet; cron will retry."
      ( crontab -l 2>/dev/null | grep -v 'sync-mail-cert.sh'; echo "17 */6 * * * MAIL_CERT_DOMAIN=$MAIL_HOSTNAME bash $SYNC >> /var/log/apsamo-mail-cert.log 2>&1" ) | crontab -
      ok "Mail certificate sync scheduled every 6 hours"
    fi

  elif [[ "$INSTALL_MAILCOW" == "skip" ]]; then
    # ── Just reconfigure existing Mailcow ─────────────────────────────
    BRAND_DOMAIN=$(env_get BRAND_DOMAIN)
    MAIL_HOSTNAME=$(ask "  Mailcow hostname [mail.$BRAND_DOMAIN]: ")
    MAIL_HOSTNAME="${MAIL_HOSTNAME:-mail.$BRAND_DOMAIN}"
    MAILCOW_API_KEY=$(ask_secret "  Mailcow API key (hidden):")

    env_set "MAILCOW_API_URL" "https://$MAIL_HOSTNAME"
    env_set "MAILCOW_API_KEY" "$MAILCOW_API_KEY"
    env_set "MAIL_SERVER_HOSTNAME" "$MAIL_HOSTNAME"
    ok "Mailcow config updated"
  else
    echo "  Skipping Mailcow (you can run this script again later)"
  fi
fi

# ════════════════════════════════════════════════════════════════════════════
# PART 3: DNS RECORDS + TEST
# ════════════════════════════════════════════════════════════════════════════
step "Part 3/3: DNS Records + Test"

BRAND_DOMAIN=$(env_get BRAND_DOMAIN)
VPS_IP=$(curl -s -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')

echo "  Make sure these DNS records exist at your registrar:"
echo ""
echo "    ┌──────────────────────────────────────────────────────────────────────┐"
echo "    │ Type  Host              Value                          Purpose     │"
echo "    ├──────────────────────────────────────────────────────────────────────┤"
echo "    │ A     mail              $VPS_IP                  Mail server  │"
echo "    │ MX    @                 mail.$BRAND_DOMAIN (pri 10)   Incoming mail │"
echo "    │ TXT   @                 v=spf1 include:mailgun.org ~all  SPF       │"
echo "    │ TXT   _dmarc            v=DMARC1; p=quarantine...       DMARC      │"
echo "    └──────────────────────────────────────────────────────────────────────┘"
echo ""
echo "  Note: SPF record depends on your SMTP provider:"
echo "    Mailgun:   v=spf1 include:mailgun.org ~all"
echo "    SendGrid:  v=spf1 include:sendgrid.net ~all"
echo "    AWS SES:   v=spf1 include:amavisd.outbound-sender.amazonses.com ~all"
echo "    Mailcow:   v=spf1 mx a -all"
echo ""

# Test SMTP if configured
SMTP_HOST=$(env_get SMTP_HOST)
if [[ -n "$SMTP_HOST" ]]; then
  echo "  Testing SMTP..."
  TEST_RESULT=$(bun -e "
const { sendEmail } = require('./src/lib/email');
(async () => {
  try {
    await sendEmail({
      to: 'test@apsamo.io',
      subject: 'SMTP Test from Apsamo Panel',
      text: 'This is a test email from the Apsamo Panel setup script. If you received this, SMTP is working!',
      html: '<p>This is a test email from the Apsamo Panel setup script.</p><p>If you received this, <strong>SMTP is working!</strong></p>',
    });
    console.log('OK');
    process.exit(0);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
" 2>&1)

  if echo "$TEST_RESULT" | grep -q "OK"; then
    ok "SMTP test: email sent successfully"
    warn "  (sent to test@apsamo.io — check the panel logs to verify)"
  else
    err "SMTP test failed: $TEST_RESULT"
    warn "  Check your SMTP credentials in .env"
    warn "  Common issues:"
    warn "    - SendGrid user must be literally 'apikey'"
    warn "    - Port 587 = STARTTLS, Port 465 = SSL (try both)"
    warn "    - Verify domain is verified in your SMTP provider dashboard"
  fi
fi

# Restart panel to pick up new env vars
step "Restarting panel"
systemctl restart apsamo-panel
sleep 3
ok "Panel restarted"

echo ""
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
ok "Email setup complete!"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "  ${BOLD}SMTP${NC} (outgoing email):"
echo "    Host:     $(env_get SMTP_HOST)"
echo "    Port:     $(env_get SMTP_PORT)"
echo "    User:     $(env_get SMTP_USER)"
echo "    From:     $(env_get SMTP_FROM_EMAIL)"
echo ""
if [[ -n "$(env_get MAILCOW_API_URL)" ]]; then
  echo "  ${BOLD}Mailcow${NC} (incoming email hosting):"
  echo "    URL:      $(env_get MAILCOW_API_URL)"
  echo "    API key:  $(env_get MAILCOW_API_KEY | head -c 8)..."
  echo "    Mailbox:  $(env_get MAIL_SERVER_HOSTNAME)"
  echo ""
  echo "  ${BOLD}Test mailbox creation:${NC}"
  echo "    1. Open the panel: https://$BRAND_DOMAIN"
  echo "    2. Go to: Hosting → [any project] → Email tab"
  echo "    3. Click 'Add Mailbox'"
  echo "    4. Log in to webmail: $(env_get MAIL_SERVER_HOSTNAME)/SOGo"
fi
echo ""
echo "  ${BOLD}Manage:${NC} apsamo env  (to edit .env)"
echo "  ${BOLD}Logs:${NC}    apsamo logs panel"
echo "  ${BOLD}Verify:${NC}   apsamo verify"
echo "${BOLD}══════════════════════════════════════════════════════════════════════════${NC}"
