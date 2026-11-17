# Apsamo Panel — Go-Live Checklist (Netcup VPS)

Follow the steps in order and tick each box. Plan on about 1–2 hours of work,
plus waiting for DNS (minutes to a few hours).

Throughout this guide:

| Placeholder | Example | Meaning |
|---|---|---|
| `yourdomain.com` | `apsamo.com` | Your brand domain (landing page, customer subdomains, email) |
| `panel.yourdomain.com` | `panel.apsamo.com` | Where the control panel runs (the installer's default) |
| `SERVER_IP` | `203.0.113.10` | Your Netcup server's IPv4 address |

---

## ☐ Step 0 — Before you start (on your computer)

1. **Merge the release into `main`.** The server installs whatever is on `main`.
   All recent work lives on `fix/production-install-hardening`: open a pull
   request into `main` on GitHub, wait for the checks to pass, and merge it.
2. **Revoke the old leaked keys** (they are still in git history):
   - Dynadot → API settings → generate a new API key/secret, which disables the old ones.
   - GitHub → Settings → Developer settings → Personal access tokens → delete the old token.
3. **Collect what you'll paste later** (skip anything you don't use yet):
   Stripe secret key, SMTP login, Dynadot key/secret, GitHub OAuth app, Cloudflare API token.

---

## ☐ Step 1 — Prepare the Netcup server

1. Log in to the **Server Control Panel (SCP)**: https://www.servercontrolpanel.de
2. Pick your VPS → **Media → Images** → install **Ubuntu 24.04** (minimal is fine).
   Add your **SSH public key** during the install and keep root login with keys only.
   Size: at least **4 GB RAM**; **8 GB** if you will also run Mailcow (email hosting).
3. Note the server's **IPv4** (SCP → Network). This is `SERVER_IP`.
4. **Reverse DNS** (SCP → Network → rDNS): set the IPv4 (and IPv6 if shown) to
   `mail.yourdomain.com`. Without this, email from the server lands in spam.
5. **Outgoing port 25**: if you will send mail directly from this server (Mailcow),
   check it is open: `nc -vz gmail-smtp-in.l.google.com 25` from the server.
   If it times out, ask Netcup support to unblock port 25.
   (Not needed if you send through Mailgun / SendGrid / SES.)
6. Netcup's own firewall is off by default; the installer configures `ufw`
   (ports 22, 80, 443). No change is needed in the SCP.

---

## ☐ Step 2 — DNS records

At the company that hosts DNS for `yourdomain.com` (Dynadot, Cloudflare, …), create:

| Type | Name | Value | Why |
|---|---|---|---|
| A | `@` | `SERVER_IP` | Landing page |
| A | `www` | `SERVER_IP` | Landing page |
| A | `panel` | `SERVER_IP` | **The control panel** |
| A | `*` | `SERVER_IP` | Customer sites on `name.yourdomain.com` |
| A | `connect` | `SERVER_IP` | Where customers point their domains; SFTP host |
| A | `mail` | `SERVER_IP` | Mail server (only with Mailcow) |
| A | `ns1` | `SERVER_IP` | Your nameserver (only with Step 8b) |
| A | `ns2` | `SERVER_IP` | Your nameserver (only with Step 8b) |

> If Cloudflare hosts this DNS, set these records to **DNS only** (grey cloud),
> or certificates will not be issued.

Check before continuing (from your computer):

```bash
nslookup panel.yourdomain.com
```

It must return `SERVER_IP`.

---

## ☐ Step 3 — Get the code onto the server

```bash
ssh root@SERVER_IP
apt update && apt install -y git
```

**If the GitHub repository is private** (recommended), give the server read-only access with a deploy key:

```bash
ssh-keygen -t ed25519 -N "" -f /root/.ssh/apsamo_deploy
cat /root/.ssh/apsamo_deploy.pub
```

Copy the printed line into GitHub → repository → **Settings → Deploy keys → Add deploy key**
(leave "Allow write access" off), then:

```bash
GIT_SSH_COMMAND="ssh -i /root/.ssh/apsamo_deploy -o StrictHostKeyChecking=accept-new" git clone git@github.com:carafo1/panel.git /opt/apsamo
git -C /opt/apsamo config core.sshCommand "ssh -i /root/.ssh/apsamo_deploy"
```

**If the repository is public:**

```bash
git clone https://github.com/carafo1/panel.git /opt/apsamo
```

---

## ☐ Step 4 — Run the installer (about 10 minutes)

```bash
cd /opt/apsamo
BRAND_DOMAIN=yourdomain.com PANEL_DOMAIN=panel.yourdomain.com ADMIN_EMAIL=admin@yourdomain.com INSTALL_MAILCOW=n DB_ENGINE=sqlite bash deploy/install.sh
```

- It asks for the **admin password** (hidden, at least 8 characters).
- It then asks for Dynadot, Stripe and SMTP. You can press Enter to skip each one
  and add them in Step 7.
- Choose `INSTALL_MAILCOW=y` only if you want to host customer mailboxes on this
  server (needs 8 GB RAM, rDNS and port 25 from Step 1).
- `DB_ENGINE=postgres` instead of `sqlite` enables AI semantic search; SQLite is fine to start.

Wait for:

```
✓ Apsamo Panel installed successfully!
```

The installer also registers this server so customers can deploy websites on it,
installs the panel, realtime and worker services, and schedules a daily backup at 3 AM.

---

## ☐ Step 5 — Verify the install

```bash
apsamo verify
```

Every check should pass. If something fails:

```bash
apsamo doctor
apsamo status
apsamo logs panel
journalctl -u caddy -n 50
```

Also confirm all three services are running (`apsamo status` shows panel, realtime, worker).
Realtime is what makes support chat and deploy logs update live.

---

## ☐ Step 6 — First login and admin 2FA (required)

1. Open **https://panel.yourdomain.com**. The certificate is issued on the first visit
   (wait ~10 seconds and reload if you see a certificate warning).
2. Sign in with the admin email and password from Step 4.
3. You will see **"Administrator access is paused"**. That is expected: in production,
   admin accounts must use two-factor authentication.
4. Go to **Settings → Security → Enable 2FA**, scan the QR code with an authenticator
   app, enter the code, and **save the backup codes somewhere safe**.
5. Reload the page. The **Admin** menu now appears.

---

## ☐ Step 7 — Add your real credentials

```bash
apsamo env
```

Fill in what you use, save, then run `apsamo restart`.

| Setting | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY=sk_live_...` | https://dashboard.stripe.com/apikeys |
| `STRIPE_WEBHOOK_SECRET=whsec_...` | Created in Step 8 |
| `STRIPE_PUBLISHABLE_KEY=pk_live_...` | https://dashboard.stripe.com/apikeys |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Your email sending provider (Mailgun, SendGrid, SES, or Mailcow) |
| `DYNADOT_API_KEY`, `DYNADOT_SECRET_KEY` | Dynadot → Tools → API (the **new** keys from Step 0) |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Created in Step 8 |
| `MAILCOW_API_URL`, `MAILCOW_API_KEY` | Only with Mailcow: Mailcow admin → Configuration → Access → API |

Do **not** change `JWT_SECRET`, `ENCRYPTION_KEY` or `CRON_API_KEY` — the installer
generated strong values, and changing `ENCRYPTION_KEY` makes stored secrets unreadable.

---

## ☐ Step 8 — Connect Stripe and GitHub

**Stripe** (Dashboard → Developers → Webhooks → Add endpoint):

- URL: `https://panel.yourdomain.com/api/billing/webhook`
- Events:
  `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET` (Step 7), then `apsamo restart`.

**GitHub** (Settings → Developer settings → OAuth Apps → New):

- Homepage URL: `https://panel.yourdomain.com`
- Callback URL: `https://panel.yourdomain.com/api/github/oauth/callback`

---

## ☐ Step 8b — Optional services

**Your own nameservers (ns1/ns2)** — lets customers connect a domain by changing
nameservers only:

```bash
bash /opt/apsamo/deploy/scripts/setup-pdns.sh
apsamo env
```

Add these two lines, save, then `apsamo restart`:

```
PDNS_API_URL="http://127.0.0.1:8081/api/v1/servers/localhost"
PDNS_API_KEY="<output of: cat /etc/powerdns/.api-key>"
```

Then at your registrar, register `ns1.yourdomain.com` and `ns2.yourdomain.com` as
**child nameservers / glue records** pointing to `SERVER_IP`.

**Email hosting (Mailcow)** — if you skipped it in Step 4:

```bash
apsamo setup-email
```

**Cloudflare CDN / WAF / DDoS** — Admin → **Servers** → Cloudflare card → paste an
API token with *Zone:Edit, Zone Settings:Edit, DNS:Edit, Cache Purge, Account:Read*.
Until this is connected, the pricing page does not advertise CDN, WAF or DDoS.

---

## ☐ Step 9 — Set up your plans

Admin → **Plans**. For each plan, decide what is included. These switches are
enforced, not just displayed:

- **Staging environment** — customers can create staging copies.
- **SSH access** — customers can turn on SFTP with SSH keys.
- **CDN integration** + **DDoS level** — Cloudflare protection; a DDoS level enables "I'm under attack" mode.

Also review Admin → **Discounts → Referral programme** (reward amounts, or switch it off).

---

## ☐ Step 10 — Off-site backups

The daily 3 AM backup stays on this server. Copy it elsewhere too:

```bash
apt install -y rclone
rclone config      # add a remote, e.g. Backblaze B2 or a Netcup Storage Box
(crontab -l 2>/dev/null; echo "30 4 * * * rclone copy /opt/apsamo/backups/ remote:apsamo-backups/") | crontab -
```

Replace `remote` with the name you gave in `rclone config`.

---

## ☐ Step 11 — Test with a real customer account before launch

Register a normal (non-admin) account in a private browser window and check:

- [ ] Verification email arrives and the link works
- [ ] Create a WordPress site → it opens on `name.yourdomain.com` with HTTPS
- [ ] Backups → take a backup, then restore it
- [ ] Staging → create staging, change something, push to live (needs a plan with staging)
- [ ] Settings → Security → add an SSH key; website → SSH / SFTP → turn on → connect with FileZilla
- [ ] Billing → buy the cheapest plan with a real card, then refund it in Stripe
- [ ] Support → open a ticket; as admin, reply from Admin → Support; the customer sees it live
- [ ] `https://panel.yourdomain.com/status` and `/help` load
- [ ] Switch the language to العربية and back

Finally:

```bash
apsamo verify
bash /opt/apsamo/deploy/scripts/security-audit.sh
```

---

## You're live

### Day-to-day commands

```bash
apsamo status          # service health
apsamo logs panel      # panel logs (also: realtime, worker)
apsamo restart         # restart everything
apsamo backup          # backup now
apsamo update          # pull the latest main, rebuild, restart
apsamo doctor          # diagnose problems
apsamo verify          # full post-install check
```

### Troubleshooting

| Problem | Fix |
|---|---|
| Certificate warning on the panel | DNS for `panel` not pointing to `SERVER_IP` yet, or proxied by Cloudflare. `journalctl -u caddy -n 50` |
| Customer site has no HTTPS | The `*` record is missing or not propagated |
| 502 Bad Gateway | `apsamo restart panel`, then `apsamo logs panel` |
| Admin menu missing | 2FA is not on for that admin (Step 6) |
| Support chat doesn't update live | `apsamo status` — the realtime service must be running |
| Payments stay in demo mode | `STRIPE_SECRET_KEY` missing → `apsamo env`, then `apsamo restart` |
| Emails not arriving | SMTP settings (Step 7); with Mailcow also rDNS and port 25 (Step 1) |
| Domain search fails | Dynadot keys missing or still the old revoked ones |
| SFTP "permission denied" | The key in the customer's account must match their computer's key; the plan must include SSH access |
| "Use our nameservers" not offered | Step 8b (PowerDNS) not done |
