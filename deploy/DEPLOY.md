# Apsamo Panel — Deployment Guide

> Three ways to deploy Apsamo Panel to production. Pick the one that fits
> your workflow.

---

## Option 1: Terraform (recommended — fully automated)

Provisions the VPS AND installs the panel in one command. Zero SSH interaction.

### Hetzner Cloud (~€4.50/mo)

```bash
# 1. Get Hetzner API token: https://console.hetzner.cloud/
# 2. Configure
cd deploy/terraform/hetzner
cp terraform.tfvars.example terraform.tfvars
nano terraform.tfvars   # fill in hcloud_token, brand_domain, admin_email, admin_password

# 3. Deploy
terraform init
terraform apply

# 4. Wait ~10 min for cloud-init
#    (Terraform will show the IP + tail command in outputs)
```

### DigitalOcean (~$24/mo)

```bash
# 1. Get DO token: https://cloud.digitalocean.com/account/api/tokens
# 2. Configure
cd deploy/terraform/digitalocean
cp terraform.tfvars.example terraform.tfvars
nano terraform.tfvars

# 3. Deploy
terraform init
terraform apply
```

### After Terraform finishes

1. **Set up DNS** — Terraform outputs the server IP. At your registrar, create A records:
   - `@` → server IP
   - `www` → server IP
   - `ns1` → server IP
   - `ns2` → server IP
   - `mail` → server IP (if using Mailcow)

2. **Wait for cloud-init** — SSH in and tail the log:
   ```bash
   ssh root@<server-ip>
   tail -f /var/log/apsamo-install.log
   ```
   When you see `APSAMO PANEL — CLOUD-INIT BOOTSTRAP COMPLETE`, it's done.

3. **Verify** — run the post-install verification:
   ```bash
   apsamo verify
   ```

4. **Open in browser** — `https://your-domain.com` (SSL auto-provisions on first request)

---

## Option 2: cloud-init (semi-automated)

If you create the VPS manually (via web UI) but want unattended install.

### Hetzner / DigitalOcean / Vultr / AWS

1. **Create a VPS** at your provider's web UI (Ubuntu 22.04+, min 2 vCPU / 4 GB RAM)

2. **In the "User data" / "Cloud-init" field**, paste the contents of `deploy/cloud-init/cloud-init.yaml`

3. **Edit the user-data** before submitting — find `/root/apsamo-config.env` in the `write_files` section and replace `__SET_ME__` with:
   - `APSAMO_BRAND_DOMAIN=yourdomain.com`
   - `APSAMO_ADMIN_EMAIL=admin@yourdomain.com`
   - `APSAMO_ADMIN_PASS=YourStrongPassword!`
   - Any optional credentials (Dynadot, Stripe, SMTP, Mailcow, GitHub)

4. **Launch the VPS** — cloud-init runs on first boot, takes ~10 min

5. **Set up DNS** — point your domain at the VPS IP

6. **SSH in and verify**:
   ```bash
   ssh root@<vps-ip>
   tail -f /var/log/apsamo-install.log
   apsamo verify
   ```

---

## Option 3: deploy.sh (run from your laptop)

If you already have a fresh VPS with SSH root access, this script SSHes in and runs the installer.

```bash
# 1. Configure
cd deploy
cp .env.production.example .env.production
nano .env.production   # fill in BRAND_DOMAIN, ADMIN_EMAIL, ADMIN_PASS, optional creds

# 2. Set up DNS at your registrar (A records pointing at the VPS IP)

# 3. Deploy
bash scripts/deploy.sh <vps-ip> [ssh-key-path]

# Example:
bash scripts/deploy.sh 203.0.113.5
bash scripts/deploy.sh 203.0.113.5 ~/.ssh/id_ed25519
```

The script:
1. Tests SSH connection
2. Validates your `.env.production`
3. Checks DNS resolves to the VPS IP
4. Clones the panel repo on the VPS
5. Runs `install.sh` non-interactively
6. Applies optional credentials (Dynadot, Stripe, etc.)
7. Creates the localhost server
8. Waits for panel to come up
9. Triggers SSL cert provisioning
10. Runs remote doctor check
11. Prints the admin URL + credentials

---

## Option 4: Manual SSH install

For full control, SSH into the VPS and run the installer yourself:

```bash
ssh root@<vps-ip>

# Clone the repo
git clone https://github.com/carafo1/panel.git
cd panel

# Run installer (interactive — asks for brand domain, admin creds, etc.)
bash deploy/install.sh

# Or, non-interactive with env vars:
BRAND_DOMAIN=yourdomain.com \
ADMIN_EMAIL=admin@yourdomain.com \
ADMIN_PASSWORD=YourStrongPass123 \
DYNADOT_API_KEY=xxx \
STRIPE_SECRET_KEY=sk_live_xxx \
bash deploy/install.sh
```

---

## Post-Install Steps (all options)

### 1. Set up DNS records
At your registrar, create A records pointing to your VPS IP:
| Type | Host | Value |
|------|------|-------|
| A | `@` | `your.vps.ip` |
| A | `www` | `your.vps.ip` |
| A | `ns1` | `your.vps.ip` |
| A | `ns2` | `your.vps.ip` |
| A | `mail` | `your.vps.ip` (if using Mailcow) |

### 2. Verify the install
```bash
ssh root@<vps-ip>
apsamo verify
```

### 3. Set up Stripe webhook (if using Stripe)
- URL: `https://yourdomain.com/api/billing/webhook`
- Events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`

### 4. Set up GitHub OAuth (if using GitHub integration)
- Homepage URL: `https://yourdomain.com`
- Authorization callback URL: `https://yourdomain.com/api/github/oauth/callback`

### 5. Set up off-site backups (recommended)
```bash
apt install -y rclone
rclone config   # configure your S3/B2/etc. remote
# Add to crontab:
(crontab -l 2>/dev/null; echo "0 4 * * * rclone copy /opt/apsamo/backups/ remote:apsamo-backups/") | crontab -
```

---

## Managing the Production Panel

Once deployed, use the `apsamo` CLI on the VPS:

```bash
apsamo status              # service status + ports + disk + backups
apsamo logs panel          # tail panel logs
apsamo restart             # restart all services
apsamo backup              # manual backup
apsamo restore <file>      # restore from backup
apsamo update              # git pull + rebuild + restart
apsamo create-admin        # create or reset admin user
apsamo verify              # full health check (12 checks)
apsamo doctor              # quick diagnosis
apsamo db-shell            # SQLite REPL
apsamo env                 # edit .env
apsamo help                # all commands
```

---

## Troubleshooting

### `apsamo verify` shows failures

```bash
apsamo doctor              # more detailed diagnosis
journalctl -u apsamo-panel -n 50    # panel service logs
journalctl -u caddy -n 50           # Caddy reverse proxy logs
```

### SSL not provisioning

```bash
# 1. Check DNS resolves to the VPS IP
dig +short yourdomain.com

# 2. Check Caddy logs
journalctl -u caddy -n 50

# 3. Force Caddy to retry
systemctl restart caddy
```

### Panel not coming up

```bash
systemctl status apsamo-panel
apsamo logs panel
# Common cause: missing required env vars
apsamo env   # verify .env has JWT_SECRET, ENCRYPTION_KEY, etc.
```

### Domain search returns 401

Dynadot keys not set. Fix:
```bash
apsamo env
# Set:
#   DYNADOT_API_KEY=...
#   DYNADOT_SECRET_KEY=...
apsamo restart panel
```

---

## Cost Estimates

| Provider | Size | Specs | Price |
|----------|------|-------|-------|
| Hetzner | CX22 | 2 vCPU / 4 GB / 40 GB | €4.50/mo |
| Hetzner | CX32 | 4 vCPU / 8 GB / 80 GB | €7.55/mo |
| Hetzner | CX42 | 8 vCPU / 16 GB / 160 GB | €15.11/mo |
| DigitalOcean | s-2vcpu-4gb | 2 vCPU / 4 GB / 80 GB | $24/mo |
| DigitalOcean | s-4vcpu-8gb | 4 vCPU / 8 GB / 160 GB | $48/mo |
| Vultr | vc2-2c-4gb | 2 vCPU / 4 GB / 80 GB | $24/mo |

**Minimum recommended:** 2 vCPU / 4 GB RAM (without Mailcow) or 4 vCPU / 8 GB RAM (with Mailcow).

---

## Migration Between Providers

To move the panel to a new VPS:

```bash
# 1. On old VPS: create a backup
ssh root@old-vps-ip 'apsamo backup --output /tmp/migration.tar.gz'
scp root@old-vps-ip:/tmp/migration.tar.gz .

# 2. Deploy on new VPS (any option above)

# 3. On new VPS: restore the backup
scp migration.tar.gz root@new-vps-ip:/tmp/
ssh root@new-vps-ip 'apsamo restore /tmp/migration.tar.gz'

# 4. Update DNS to point at new VPS IP

# 5. Verify
ssh root@new-vps-ip 'apsamo verify'
```

Total downtime: ~5 minutes (during DNS propagation).
