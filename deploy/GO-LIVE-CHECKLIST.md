# 🚀 Apsamo Panel — Go-Live Checklist

> Follow these 7 steps in order. Total time: ~35 minutes.
> After each step, check the box before moving to the next.

---

## ✅ Step 1: Push to GitHub  (DONE — 1 minute)

```bash
cd /home/z/my-project/panel
git add -A
git commit -m "Production readiness: security hardening + deployment package"
git push origin main
```

**✅ Done.** Commit `d90f2df` is now on GitHub at https://github.com/carafo1/panel

---

## ⬜ Step 2: Provision a VPS  (5 minutes)

Pick **one** provider below. Any will work.

### Option A — Hetzner Cloud (cheapest, recommended)

1. Go to https://console.hetzner.cloud/
2. Create a project → Add server
3. Configure:
   - **Location:** Nuremberg (nbg1) or Falkenstein (fsn1)
   - **Image:** Ubuntu 24.04
   - **Type:** CX22 (2 vCPU / 4 GB / 40 GB) — **€4.50/mo**
   - **SSH key:** Add your public key (or use a root password)
4. **User data** field — paste this (replace `__SET_ME__`):

```yaml
#cloud-config
write_files:
  - path: /root/apsamo-config.env
    permissions: '0600'
    content: |
      APSAMO_BRAND_DOMAIN=__SET_ME__         # e.g. apsamo.com
      APSAMO_ADMIN_EMAIL=__SET_ME__          # e.g. admin@apsamo.com
      APSAMO_ADMIN_PASS=__SET_ME__           # min 8 chars
      APSAMO_REPO_URL=https://github.com/carafo1/panel.git
      APSAMO_REPO_BRANCH=main

runcmd:
  - git clone -b main https://github.com/carafo1/panel.git /opt/apsamo
  - cd /opt/apsamo
  - BRAND_DOMAIN="${APSAMO_BRAND_DOMAIN}" ADMIN_EMAIL="${APSAMO_ADMIN_EMAIL}" ADMIN_PASSWORD="${APSAMO_ADMIN_PASS}" bash deploy/install.sh > /var/log/apsamo-install.log 2>&1
```

5. Click **Create & buy now**
6. Note the server IP (you'll need it for Step 3)

### Option B — DigitalOcean

1. Go to https://cloud.digitalocean.com/
2. Create → Droplets
3. Configure:
   - **Region:** New York (nyc1) or Amsterdam (ams3)
   - **Image:** Ubuntu 24.04 (LTS) x64
   - **Size:** Basic / Shared CPU / $24/mo (2 vCPU / 4 GB / 80 GB)
   - **SSH keys:** Add yours
4. **User data** — paste the same cloud-config as Option A (with `__SET_ME__` filled in)
5. Create Droplet
6. Note the IP

### Option C — Manual (any provider)

1. Spin up any Ubuntu 22.04+ VPS with at least 2 vCPU / 4 GB RAM
2. Note the IP + SSH credentials
3. Skip to Step 4

---

## ⬜ Step 3: Configure DNS  (5 minutes)

At your domain registrar (Namecheap, Cloudflare, GoDaddy, Dynadot, etc.), add these A records pointing to your VPS IP:

| Type | Host | Value | TTL |
|------|------|-------|-----|
| A | `@` (apex) | `YOUR.VPS.IP` | 3600 |
| A | `www` | `YOUR.VPS.IP` | 3600 |
| A | `ns1` | `YOUR.VPS.IP` | 3600 |
| A | `ns2` | `YOUR.VPS.IP` | 3600 |
| A | `mail` | `YOUR.VPS.IP` | 3600 (if using Mailcow) |

**Verify DNS propagated:**
```bash
dig +short yourdomain.com
# Should return your VPS IP
```

---

## ⬜ Step 4: Run the installer  (10 minutes)

If you used Option A or B (cloud-init), the installer is **already running**. SSH in and check:

```bash
ssh root@YOUR.VPS.IP
tail -f /var/log/apsamo-install.log
```

Wait until you see:
```
══════════════════════════════════════════════════════════════════════════
  ✓ Apsamo Panel installed successfully!
══════════════════════════════════════════════════════════════════════════
```

If you used Option C (manual), SSH in and run:
```bash
ssh root@YOUR.VPS.IP
apt update && apt install -y git
git clone https://github.com/carafo1/panel.git /opt/apsamo
cd /opt/apsamo
bash deploy/install.sh
```

Answer the prompts:
- Brand domain: `yourdomain.com`
- Admin email: `admin@yourdomain.com`
- Admin password: (your strong password)
- Database engine: `sqlite` (default) or `postgres` (for AI semantic search)
- Optional credentials: leave blank for now

---

## ⬜ Step 5: Verify the install  (2 minutes)

```bash
ssh root@YOUR.VPS.IP
apsamo verify
```

Should output:
```
✓ ALL CHECKS PASSED (27/27)
Panel is healthy and production-ready.
```

If any checks fail:
```bash
apsamo doctor          # diagnose
apsamo logs panel      # check panel logs
journalctl -u caddy -n 50   # check Caddy/SSL logs
```

---

## ⬜ Step 6: Open in browser + add real credentials  (10 minutes)

1. **Open:** `https://yourdomain.com`
   - SSL auto-provisions on first request (~10 seconds)
   - If it doesn't, check: `journalctl -u caddy -n 50`

2. **Log in** with the admin email + password from Step 2

3. **Add real credentials** (run on the VPS):
   ```bash
   apsamo env
   ```
   
   Set these (get the values from the linked dashboards):

   | Variable | Where to get it |
   |---|---|
   | `STRIPE_SECRET_KEY=sk_live_...` | https://dashboard.stripe.com/apikeys |
   | `STRIPE_WEBHOOK_SECRET=whsec_...` | https://dashboard.stripe.com/webhooks (create endpoint → `https://yourdomain.com/api/billing/webhook`) |
   | `STRIPE_PRICE_ID_DEFAULT=price_...` | Stripe → Products → Create product → Copy price ID |
   | `SMTP_HOST=smtp.mailgun.org` | Your email provider (Mailgun/SendGrid/AWS SES) |
   | `SMTP_USER=postmaster@yourdomain.com` | Your SMTP username |
   | `SMTP_PASS=...` | Your SMTP password |
   | `MAILCOW_API_URL=https://mail.yourdomain.com` | Your Mailcow instance URL (if installed) |
   | `MAILCOW_API_KEY=...` | Mailcow admin → Configuration → Access → API |
   | `GITHUB_CLIENT_ID=...` | https://github.com/settings/developers (OAuth app) |
   | `GITHUB_CLIENT_SECRET=...` | Same as above |
   
   Save + exit (Ctrl+X, Y, Enter if using nano)

4. **Restart** to pick up the new credentials:
   ```bash
   apsamo restart
   ```

5. **Set up Stripe webhook** (if using Stripe):
   - URL: `https://yourdomain.com/api/billing/webhook`
   - Events to send:
     - `checkout.session.completed`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_succeeded`

6. **Set up GitHub OAuth** (if using GitHub):
   - Homepage URL: `https://yourdomain.com`
   - Authorization callback URL: `https://yourdomain.com/api/github/oauth/callback`

---

## ⬜ Step 7: Final production hardening  (5 minutes)

### Set up off-site backups (recommended)

```bash
ssh root@YOUR.VPS.IP
apt install -y rclone
rclone config   # configure S3/B2/etc. remote

# Add to crontab:
(crontab -l 2>/dev/null; echo "0 4 * * * rclone copy /opt/apsamo/backups/ remote:apsamo-backups/") | crontab -
```

### Create the localhost server (so customers can deploy projects on this box)

```bash
ssh root@YOUR.VPS.IP
apsamo db-shell
```

Paste this SQL:
```sql
INSERT INTO Server (id, name, ip, provider, status, cpuCores, ramGB, storageGB,
  bandwidthGB, usedRamGB, usedStorageGB, region, sshHost, sshPort, sshUser,
  dockerInstalled, caddyInstalled, healthStatus, createdAt, updatedAt)
VALUES (lower(hex(randomblob(12))), 'Localhost', '127.0.0.1', 'local', 'active',
  4, 8, 100, 1000, 0, 0, 'local', 'localhost', 22, 'root', 1, 1, 'healthy',
  datetime('now'), datetime('now'));
```

### Run a final verification

```bash
apsamo verify
```

All 27 checks should pass.

---

## 🎉 You're live!

Your panel is now accessible at **https://yourdomain.com** with:
- ✅ Real SSL (Let's Encrypt via Caddy)
- ✅ Real domain registration (Dynadot)
- ✅ Real payments (Stripe)
- ✅ Real email (SMTP)
- ✅ Auto-restart on crash (systemd)
- ✅ Daily 3 AM backups (cron)
- ✅ Off-site backup sync (rclone)
- ✅ Security headers + hardened API
- ✅ Firewall (ufw on 22/80/443)

### Ongoing management

```bash
apsamo status              # check service health
apsamo logs panel          # tail panel logs
apsamo backup              # manual backup
apsamo update              # git pull + rebuild + restart
apsamo doctor              # diagnose issues
apsamo security-audit      # re-run security checks
```

---

## 🆘 Troubleshooting

| Issue | Fix |
|---|---|
| SSL not provisioning | `journalctl -u caddy -n 50` — likely DNS not propagated yet |
| 502 Bad Gateway | `apsamo restart panel` — panel may have crashed |
| Domain search 401 | `apsamo env` — verify `DYNADOT_API_KEY` is set |
| Stripe demo mode | `apsamo env` — set `STRIPE_SECRET_KEY` + restart |
| Email not sending | `apsamo env` — set `SMTP_HOST` + `SMTP_PASS` + restart |
| Customer can't deploy | Run the Step 7 SQL to create localhost server |

---

## 📞 What's NOT in this checklist (post-launch)

These can wait until after you're live:

- [ ] Security audit of remaining 12 API sections (billing, admin, github, etc.)
- [ ] Automated test suite (Jest + Playwright)
- [ ] CI/CD pipeline (GitHub Actions)
- [ ] Load testing (k6)
- [ ] External penetration testing
- [ ] Monitoring/alerting (Uptime Kuma / Prometheus)
- [ ] PostgreSQL + pgvector switch (for AI semantic search)

The system is fully functional without these. They're hardening/best-practice items.
