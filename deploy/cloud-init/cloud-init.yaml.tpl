#cloud-config
# ════════════════════════════════════════════════════════════════════════════
# Apsamo Panel — Cloud-Init Template (consumed by Terraform templatefile())
# ════════════════════════════════════════════════════════════════════════════
#
#   Terraform renders this file with real values from terraform.tfvars
#   and passes it as user-data to the VPS provider.
#
#   Variables (all required — Terraform will substitute):
#     brand_domain, admin_email, admin_password,
#     dynadot_api_key, dynadot_secret_key,
#     stripe_secret_key, stripe_webhook_secret, stripe_price_id,
#     smtp_host, smtp_port, smtp_user, smtp_pass,
#     mailcow_api_url, mailcow_api_key,
#     github_client_id, github_client_secret, github_token,
#     install_mailcow
# ════════════════════════════════════════════════════════════════════════════

# ─── Write the apsamo config file ─────────────────────────────────────────
write_files:
  - path: /root/apsamo-config.env
    permissions: '0600'
    owner: root:root
    content: |
      APSAMO_BRAND_DOMAIN=${brand_domain}
      APSAMO_ADMIN_EMAIL=${admin_email}
      APSAMO_ADMIN_PASS=${admin_password}
      APSAMO_DYNADOT_API_KEY=${dynadot_api_key}
      APSAMO_DYNADOT_SECRET_KEY=${dynadot_secret_key}
      APSAMO_STRIPE_SECRET_KEY=${stripe_secret_key}
      APSAMO_STRIPE_WEBHOOK_SECRET=${stripe_webhook_secret}
      APSAMO_STRIPE_PRICE_ID_DEFAULT=${stripe_price_id}
      APSAMO_SMTP_HOST=${smtp_host}
      APSAMO_SMTP_PORT=${smtp_port}
      APSAMO_SMTP_USER=${smtp_user}
      APSAMO_SMTP_PASS=${smtp_pass}
      APSAMO_SMTP_FROM_NAME=Apsamo Panel
      APSAMO_MAILCOW_API_URL=${mailcow_api_url}
      APSAMO_MAILCOW_API_KEY=${mailcow_api_key}
      APSAMO_GITHUB_CLIENT_ID=${github_client_id}
      APSAMO_GITHUB_CLIENT_SECRET=${github_client_secret}
      APSAMO_GITHUB_TOKEN=${github_token}
      APSAMO_WAAFI_MERCHANT_ID=
      APSAMO_WAAFI_API_KEY=
      APSAMO_WAAFI_API_USER_ID=
      APSAMO_INSTALL_MAILCOW=${install_mailcow}
      APSAMO_REPO_URL=https://github.com/carafo1/panel.git
      APSAMO_REPO_BRANCH=main

# ─── Install packages early ──────────────────────────────────────────────
package_update: true
package_upgrade: true
packages:
  - curl
  - git
  - unzip
  - vim
  - less
  - build-essential
  - python3-dev
  - ufw
  - ca-certificates
  - gnupg
  - lsb-release
  - sqlite3
  - libsqlite3-dev
  - openssh-server
  - fail2ban
  - rsync

# ─── Run the installer ───────────────────────────────────────────────────
runcmd:
  - echo "=== Apsamo Panel cloud-init bootstrap started at $(date) ===" > /var/log/apsamo-install.log

  - set -a && . /root/apsamo-config.env && set +a

  - hostnamectl set-hostname "${APSAMO_BRAND_DOMAIN}" 2>/dev/null || echo "${APSAMO_BRAND_DOMAIN}" > /etc/hostname

  - |
    if ! command -v docker >/dev/null 2>&1; then
      echo "[bootstrap] installing Docker..." >> /var/log/apsamo-install.log
      curl -fsSL https://get.docker.com | sh >> /var/log/apsamo-install.log 2>&1
      systemctl enable --now docker >> /var/log/apsamo-install.log 2>&1
    fi

  - |
    if ! command -v caddy >/dev/null 2>&1; then
      echo "[bootstrap] installing Caddy..." >> /var/log/apsamo-install.log
      apt-get install -y debian-keyring debian-archive-keyring apt-transport-https >> /var/log/apsamo-install.log 2>&1
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
      curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
        | tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
      apt-get update -qq >> /var/log/apsamo-install.log 2>&1
      apt-get install -y caddy >> /var/log/apsamo-install.log 2>&1
    fi

  - |
    if ! command -v bun >/dev/null 2>&1; then
      echo "[bootstrap] installing Bun..." >> /var/log/apsamo-install.log
      curl -fsSL https://bun.sh/install | bash >> /var/log/apsamo-install.log 2>&1
      ln -sf /root/.bun/bin/bun /usr/local/bin/bun
    fi

  - |
    if ! command -v node >/dev/null 2>&1; then
      echo "[bootstrap] installing Node..." >> /var/log/apsamo-install.log
      curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >> /var/log/apsamo-install.log 2>&1
      apt-get install -y nodejs >> /var/log/apsamo-install.log 2>&1
    fi

  - |
    if [ ! -d /opt/apsamo ]; then
      echo "[bootstrap] cloning panel repo..." >> /var/log/apsamo-install.log
      REPO_URL="${APSAMO_REPO_URL}"
      if [ -n "${APSAMO_GITHUB_TOKEN}" ]; then
        REPO_URL=$(echo "${APSAMO_REPO_URL}" | sed "s|https://github.com|https://${APSAMO_GITHUB_TOKEN}@github.com|")
      fi
      git clone -b "${APSAMO_REPO_BRANCH}" "${REPO_URL}" /opt/apsamo >> /var/log/apsamo-install.log 2>&1
    fi

  - |
    cd /opt/apsamo
    echo "[bootstrap] running install.sh..." >> /var/log/apsamo-install.log
    BRAND_DOMAIN="${APSAMO_BRAND_DOMAIN}" \
    ADMIN_EMAIL="${APSAMO_ADMIN_EMAIL}" \
    ADMIN_PASSWORD="${APSAMO_ADMIN_PASS}" \
    INSTALL_MAILCOW=$([ "${APSAMO_INSTALL_MAILCOW}" = "true" ] && echo "y" || echo "n") \
    DYNADOT_API_KEY="${APSAMO_DYNADOT_API_KEY}" \
    STRIPE_SECRET_KEY="${APSAMO_STRIPE_SECRET_KEY}" \
    SMTP_HOST="${APSAMO_SMTP_HOST}" \
    SMTP_USER="${APSAMO_SMTP_USER}" \
    SMTP_PASS="${APSAMO_SMTP_PASS}" \
    bash /opt/apsamo/deploy/install.sh >> /var/log/apsamo-install.log 2>&1

  - |
    set -a && . /root/apsamo-config.env && set +a
    ENV=/opt/apsamo/.env
    [ -n "${APSAMO_DYNADOT_SECRET_KEY}" ]      && sed -i "s|^DYNADOT_SECRET_KEY=.*|DYNADOT_SECRET_KEY=\"${APSAMO_DYNADOT_SECRET_KEY}\"|" $ENV
    [ -n "${APSAMO_STRIPE_WEBHOOK_SECRET}" ]   && sed -i "s|^STRIPE_WEBHOOK_SECRET=.*|STRIPE_WEBHOOK_SECRET=\"${APSAMO_STRIPE_WEBHOOK_SECRET}\"|" $ENV
    [ -n "${APSAMO_STRIPE_PRICE_ID_DEFAULT}" ] && sed -i "s|^STRIPE_PRICE_ID_DEFAULT=.*|STRIPE_PRICE_ID_DEFAULT=\"${APSAMO_STRIPE_PRICE_ID_DEFAULT}\"|" $ENV
    [ -n "${APSAMO_MAILCOW_API_URL}" ]         && sed -i "s|^MAILCOW_API_URL=.*|MAILCOW_API_URL=\"${APSAMO_MAILCOW_API_URL}\"|" $ENV
    [ -n "${APSAMO_MAILCOW_API_KEY}" ]         && sed -i "s|^MAILCOW_API_KEY=.*|MAILCOW_API_KEY=\"${APSAMO_MAILCOW_API_KEY}\"|" $ENV
    [ -n "${APSAMO_GITHUB_CLIENT_ID}" ]        && sed -i "s|^GITHUB_CLIENT_ID=.*|GITHUB_CLIENT_ID=\"${APSAMO_GITHUB_CLIENT_ID}\"|" $ENV
    [ -n "${APSAMO_GITHUB_CLIENT_SECRET}" ]    && sed -i "s|^GITHUB_CLIENT_SECRET=.*|GITHUB_CLIENT_SECRET=\"${APSAMO_GITHUB_CLIENT_SECRET}\"|" $ENV
    [ -n "${APSAMO_SMTP_PORT}" ]               && sed -i "s|^SMTP_PORT=.*|SMTP_PORT=\"${APSAMO_SMTP_PORT}\"|" $ENV
    [ -n "${APSAMO_SMTP_FROM_NAME}" ]          && sed -i "s|^SMTP_FROM_NAME=.*|SMTP_FROM_NAME=\"${APSAMO_SMTP_FROM_NAME}\"|" $ENV
    systemctl restart apsamo-panel apsamo-realtime apsamo-worker

  - |
    cd /opt/apsamo
    bun -e "
    const { db } = require('./src/lib/db');
    (async () => {
      const existing = await db.server.findFirst({ where: { sshHost: 'localhost' } });
      if (existing) { console.log('localhost server already exists'); process.exit(0); }
      await db.server.create({
        data: {
          name: 'Localhost (this server)',
          ip: '127.0.0.1',
          provider: 'local',
          status: 'active',
          cpuCores: $(nproc),
          ramGB: $(awk '/MemTotal/ {printf \"%d\", \$2/1024/1024}' /proc/meminfo),
          storageGB: $(df -BG / | awk 'NR==2 {gsub(/G/, \"\", \$2); print \$2}'),
          bandwidthGB: 1000,
          usedRamGB: 0,
          usedStorageGB: 0,
          region: 'local',
          sshHost: 'localhost',
          sshPort: 22,
          sshUser: 'root',
          dockerInstalled: true,
          caddyInstalled: true,
          healthStatus: 'healthy',
        },
      });
      console.log('localhost server created');
      process.exit(0);
    })();
    " >> /var/log/apsamo-install.log 2>&1

  - |
    IP=$(curl -s -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
    echo "" >> /var/log/apsamo-install.log
    echo "════════════════════════════════════════════════════════════════" >> /var/log/apsamo-install.log
    echo "  APSAMO PANEL — CLOUD-INIT BOOTSTRAP COMPLETE" >> /var/log/apsamo-install.log
    echo "════════════════════════════════════════════════════════════════" >> /var/log/apsamo-install.log
    echo "  URL:      https://${APSAMO_BRAND_DOMAIN}" >> /var/log/apsamo-install.log
    echo "  IP:       ${IP}" >> /var/log/apsamo-install.log
    echo "  Email:    ${APSAMO_ADMIN_EMAIL}" >> /var/log/apsamo-install.log
    echo "  Log:      /var/log/apsamo-install.log" >> /var/log/apsamo-install.log
    echo "  Manage:   apsamo status" >> /var/log/apsamo-install.log
    echo "════════════════════════════════════════════════════════════════" >> /var/log/apsamo-install.log
