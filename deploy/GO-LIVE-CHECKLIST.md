# Apsamo Panel — Go-Live Checklist (Netcup VPS)

Follow the steps in order and tick each box. Plan on about **2–3 hours of work**,
plus waiting for DNS (minutes to a few hours).

| Placeholder | Example | Meaning |
|---|---|---|
| `yourdomain.com` | `apsamo.com` | Your brand domain (landing page, customer subdomains, email) |
| `panel.yourdomain.com` | `panel.apsamo.com` | Where the control panel runs (the installer's default) |
| `SERVER_IP` | `203.0.113.10` | Your Netcup server's IPv4 address |

Where a step says **Admin → X**, that is the Admin menu in the panel, tab X.

---

## ☐ Step 0 — Before you start (on your computer)

1. **`main` must contain everything.** The server installs from `main`.
   ✅ Done: pull requests #131 (all features), #132 (CI fix) and #133 (Dynadot keys
   in Admin, Mailcow setup fix, this checklist) are merged. If you change anything
   later, merge it into `main` (with green CI checks) before installing or updating.
2. **Leaked credentials** (they are in git history):
   - GitHub token "dd": ✅ deleted.
   - Dynadot keys: still the same keys. They only work from IPs on Dynadot's
     allow-list, which limits the risk. To be fully safe, generate new keys in
     Dynadot (API settings → generate new key), then use those in Step 8.
3. **Collect what you'll paste later** (skip anything you don't use yet):
   Stripe keys, SMTP login, Dynadot key/secret, GitHub OAuth app, Cloudflare API token.
4. **Top up your Dynadot account balance.** Domain registrations and renewals made
   through the panel are paid from that balance; with an empty balance, customers'
   domain orders fail.

---

## ☐ Step 1 — Prepare the Netcup server

1. Log in to the **Server Control Panel (SCP)**: https://www.servercontrolpanel.de
2. Pick your VPS → **Media → Images** → install **Ubuntu 24.04** (minimal is fine).
   Add your **SSH public key** during the install.
   Size: at least **4 GB RAM**; **8 GB** if you will also host email (Mailcow).
3. Note the server's **IPv4** (SCP → Network). This is `SERVER_IP`.
4. **Reverse DNS** (SCP → Network → rDNS): set the IPv4 (and IPv6 if shown) to
   `mail.yourdomain.com`. Without this, email sent from the server lands in spam.
5. **Snapshot**: if your VPS offers snapshots (SCP → Snapshots), take one of the clean
   install now. It is your "start over" button.
6. Netcup's own firewall is off by default; the installer configures `ufw`
   (ports 22, 80, 443). No change is needed in the SCP.

---

## ☐ Step 2 — DNS records

At the company that hosts DNS for `yourdomain.com` (Dynadot, Cloudflare, …):

**Remove** any parking/forwarding records the registrar added for `@`, `www` or `*`.

**Create:**

| Type | Name | Value | Why |
|---|---|---|---|
| A | `@` | `SERVER_IP` | Landing page |
| A | `www` | `SERVER_IP` | Landing page |
| A | `panel` | `SERVER_IP` | **The control panel** |
| A | `*` | `SERVER_IP` | Customer sites on `name.yourdomain.com` |
| A | `connect` | `SERVER_IP` | Where customers point their domains; SFTP host |
| A | `mail` | `SERVER_IP` | Mail server (only with Mailcow, Step 11) |
| A | `ns1` | `SERVER_IP` | Your nameserver (only with Step 12) |
| A | `ns2` | `SERVER_IP` | Your nameserver (only with Step 12) |

> If Cloudflare hosts this DNS, set these records to **DNS only** (grey cloud),
> or certificates will not be issued.

**Email records** — so the panel's emails (verification, invoices, support replies)
reach inboxes. Add the **SPF and DKIM** records your email sending provider gives you
(Mailgun / SendGrid / SES show them when you add `yourdomain.com`; with Mailcow they
come from Step 11), plus:

| Type | Name | Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:postmaster@yourdomain.com` |

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

Your repository is **private**, so give the server read-only access with a deploy key:

```bash
ssh-keygen -t ed25519 -N "" -f /root/.ssh/apsamo_deploy
cat /root/.ssh/apsamo_deploy.pub
```

Copy the printed line into GitHub → `carafo1/panel` → **Settings → Deploy keys →
Add deploy key** (leave "Allow write access" off), then:

```bash
GIT_SSH_COMMAND="ssh -i /root/.ssh/apsamo_deploy -o StrictHostKeyChecking=accept-new" git clone git@github.com:carafo1/panel.git /opt/apsamo
git -C /opt/apsamo config core.sshCommand "ssh -i /root/.ssh/apsamo_deploy"
```

---

## ☐ Step 4 — Run the installer (about 10–15 minutes)

```bash
cd /opt/apsamo
BRAND_DOMAIN=yourdomain.com PANEL_DOMAIN=panel.yourdomain.com ADMIN_EMAIL=admin@yourdomain.com INSTALL_MAILCOW=n DB_ENGINE=sqlite bash deploy/install.sh
```

- It asks for the **admin password** (hidden, at least 8 characters).
- It then asks for Dynadot, Stripe and SMTP. Press Enter to skip each one; you
  add them in Steps 7–8.
- Keep `INSTALL_MAILCOW=n` here even if you want email hosting: Mailcow is set up
  afterwards in Step 11, behind Caddy.
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
apsamo status
```

Every check should pass, and `apsamo status` must show **panel, realtime and worker**
running (realtime makes support chat and deploy logs update live). If something fails:

```bash
apsamo doctor
apsamo logs panel
journalctl -u caddy -n 50
```

---

## ☐ Step 6 — First login and admin 2FA (required)

1. Open **https://panel.yourdomain.com**. The certificate is issued on the first visit
   (wait ~10 seconds and reload if you see a certificate warning).
2. Sign in with the admin email and password from Step 4.
3. You will see **"Administrator access is paused"**. That is expected: in production,
   admin accounts must use two-factor authentication.
4. **Settings → Security → Enable 2FA**: scan the QR code with an authenticator app,
   enter the code, and **save the backup codes somewhere safe** (not on the server).
5. Reload the page. The **Admin** menu now appears.

---

## ☐ Step 7 — Server credentials (.env)

```bash
apsamo env
```

Fill in what you use, save, then run `apsamo restart`.

| Setting | Where to get it |
|---|---|
| `STRIPE_SECRET_KEY=sk_live_...` | https://dashboard.stripe.com/apikeys |
| `STRIPE_PUBLISHABLE_KEY=pk_live_...` | https://dashboard.stripe.com/apikeys |
| `STRIPE_WEBHOOK_SECRET=whsec_...` | Created in Step 9 |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Your email sending provider (Mailgun, SendGrid, SES), or Mailcow after Step 11 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Created in Step 9 |

**Not here:** Dynadot (Step 8) and Cloudflare (Step 12) are entered in the panel,
where they are stored encrypted.

Do **not** change `JWT_SECRET`, `ENCRYPTION_KEY` or `CRON_API_KEY`. The installer
generated strong values, and changing `ENCRYPTION_KEY` makes stored secrets unreadable.

---

## ☐ Step 8 — Dynadot (domain search, registration, renewals)

Admin → **Servers** → **Dynadot** card:

1. Paste the API key (and secret key), then **Save & test**.
2. If the test says Dynadot refused the server's address, add the IP it shows in
   Dynadot → **Settings → API → allowed IPs**, then press **Test connection** again
   until it says Dynadot accepted the key.
3. Only allow the **server's** IP. Any machine on that list can register and pay for
   domains with your account.

---

## ☐ Step 9 — Connect Stripe and GitHub

**Stripe** (Dashboard → Developers → Webhooks → Add endpoint):

- URL: `https://panel.yourdomain.com/api/billing/webhook`
- Events:
  `checkout.session.completed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`
- Copy the signing secret into `STRIPE_WEBHOOK_SECRET` (`apsamo env`), then `apsamo restart`.
- After the first test payment (Step 15), check the webhook shows **succeeded** deliveries.

**GitHub** (Settings → Developer settings → OAuth Apps → New):

- Homepage URL: `https://panel.yourdomain.com`
- Callback URL: `https://panel.yourdomain.com/api/github/oauth/callback`

---

## ☐ Step 10 — Plans, prices and payments

The installer does **not** create hosting plans; until you do, the pricing page is empty.

```bash
cd /opt/apsamo
bun run scripts/seed-plans.ts --dry    # shows what will be created
bun run scripts/seed-plans.ts
```

This creates **Starter ($4.99), Professional ($8.99) and Enterprise ($17.99)**. Then in the panel:

1. **Admin → Plans** — adjust prices and features. These switches are enforced:
   - **Staging environment** (off on Starter) — customers can create staging copies.
   - **SSH access** (off on Starter) — customers can turn on SFTP with SSH keys.
   - **CDN integration** + **DDoS level** — Cloudflare protection (only shown once Step 12 is done).
2. **Domains → Pricing** — press **Sync Prices** to load Dynadot's prices, and set your markup.
3. **Admin → Discounts → Tax rates** — add VAT/sales tax if you must charge it.
4. **Admin → Payment Methods / Gateways** (visible to the super admin the installer
   created) — turn on the payment options you accept
   (Stripe card payments; local gateways such as WaafiPay only if you have a merchant account).
5. **Admin → Discounts → Referral programme** — set the reward amounts, or switch it off.

---

## ☐ Step 11 — Email

**Sending (required):** with SMTP set in Step 7, register a test account (Step 15)
and confirm the verification email arrives, and not in spam.

**Receiving:** make sure `support@yourdomain.com` and `billing@yourdomain.com`
exist as real mailboxes or forwarders. Customers reply to these addresses.

**Hosting customer mailboxes (optional, Mailcow)** — 8 GB RAM recommended; on a
smaller server (4 GB) `setup-email` switches to low-memory mode by itself, aiming for
Mailcow to use under ~1.5 GB: it adds a 4 GB swap file and leaves off the ClamAV virus
scanner, Olefy (Office macro scanner) and full-text search. Spam filtering and SOGo
webmail stay on. After a RAM upgrade, set `SKIP_CLAMD=n`, `SKIP_OLEFY=n`, `SKIP_FTS=n`
in `/opt/mailcow/mailcow.conf` and run `docker compose up -d` in `/opt/mailcow`. Also needs the `mail` A record (Step 2) and rDNS set to `mail.yourdomain.com`
(Step 1). First check outgoing port 25 is open:

```bash
nc -vz gmail-smtp-in.l.google.com 25
```

If it times out, ask Netcup support to unblock port 25, then:

```bash
apsamo setup-email
```

It installs Mailcow behind Caddy (webmail at `https://mail.yourdomain.com`), shares
Caddy's certificate with the mail server, and asks you for a Mailcow API key. In the
Mailcow admin: **change the default password (`admin` / `moohoo`) immediately**, then
create the Read/Write API key with your server IP in "Allow API access from these IPs".
Add `yourdomain.com` as a mail domain, and copy its **MX, SPF and DKIM** records into
your DNS. It also opens the mail ports in ufw and serves `autodiscover.` /
`autoconfig.yourdomain.com` when those DNS records point at the server.

---

## ☐ Step 12 — Optional services

**Your own nameservers (ns1/ns2)** — lets customers connect a domain by changing
nameservers only:

```bash
bash /opt/apsamo/deploy/scripts/setup-pdns.sh
cat /etc/powerdns/.api-key
apsamo env
```

Add these two lines (the key is the output of the `cat` command), save, then `apsamo restart`:

```
PDNS_API_URL="http://127.0.0.1:8081/api/v1/servers/localhost"
PDNS_API_KEY="<the key>"
```

At your registrar, register `ns1.yourdomain.com` and `ns2.yourdomain.com` as
**child nameservers / glue records** pointing to `SERVER_IP`.

**Cloudflare CDN / WAF / DDoS** — Admin → **Servers** → **Cloudflare** card → paste an
API token with *Zone:Edit, Zone Settings:Edit, DNS:Edit, Cache Purge, Account:Read*.
Until this is connected, the pricing page does not advertise CDN, WAF or DDoS.

---

## ☐ Step 13 — Content customers will read

1. **Admin → Content** — review the landing page text, contact details, and the
   **Privacy Policy** and **Terms of Service**. They ship with sample wording
   that mentions `support@apsamo.com`; make sure they match your business and
   local law before you take payments.
2. **Admin → Help** — the help center starts with 9 general articles; check they
   match how you run things.
3. **Admin → Status** — nothing to do now; post incidents here when something breaks.

---

## ☐ Step 14 — Keep the server safe and recoverable

**Automatic security updates:**

```bash
apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades    # answer "Yes"
```

**Off-site backups** (the daily 3 AM backup in `/opt/apsamo/backups` stays on this server):

```bash
apt install -y rclone
rclone config      # add a remote, e.g. Backblaze B2 or a Netcup Storage Box
(crontab -l 2>/dev/null; echo "30 4 * * * rclone copy /opt/apsamo/backups/ remote:apsamo-backups/") | crontab -
```

Replace `remote` with the name you gave in `rclone config`. The next morning, check
the files arrived at the remote.

**Monitoring:**

```bash
apsamo setup-monitoring
```

Also add an **outside** uptime check (for example UptimeRobot, free) on
`https://panel.yourdomain.com/api/status`. It returns an error if the database is down,
and an outside monitor still alerts you when the whole server is offline.

**Reboot test:** run `reboot`, wait 2 minutes, then `apsamo status`. Everything must
come back on its own.

---

## ☐ Step 15 — Test as a real customer before launch

Register a normal (non-admin) account in a private browser window and check:

- [ ] Verification email arrives (not in spam) and the link works
- [ ] Forgot password → reset email arrives → new password works
- [ ] Domains → search a domain → shows availability and your price
- [ ] Create a WordPress site → it opens on `name.yourdomain.com` with HTTPS
- [ ] Backups → take a backup, then restore it
- [ ] Staging → create staging, change something, push to live (Professional plan or higher)
- [ ] Settings → Security → add an SSH key; website → SSH / SFTP → turn on → connect with FileZilla
- [ ] Billing → buy the cheapest plan with a real card → the plan activates → Stripe webhook shows "succeeded" → refund it in Stripe
- [ ] Support → open a ticket; as admin, reply from Admin → Support; the customer sees it live and gets an email
- [ ] `https://panel.yourdomain.com/status` and `/help` load
- [ ] Switch the language to العربية and back

Then:

```bash
apsamo verify
bash /opt/apsamo/deploy/scripts/security-audit.sh
```

Take another snapshot (Step 1) now that everything works.

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

### Every month

- [ ] `apsamo update` (after the change is merged to `main` and CI is green)
- [ ] Check off-site backups are arriving
- [ ] Dynadot balance is enough for upcoming renewals
- [ ] Look at Admin → Support for old open tickets

### Troubleshooting

| Problem | Fix |
|---|---|
| Certificate warning on the panel | DNS for `panel` not pointing to `SERVER_IP` yet, or proxied by Cloudflare. `journalctl -u caddy -n 50` |
| Customer site has no HTTPS | The `*` record is missing or not propagated |
| Pricing page is empty | Plans not created → Step 10 (`seed-plans.ts`) |
| 502 Bad Gateway | `apsamo restart panel`, then `apsamo logs panel` |
| Admin menu missing | 2FA is not on for that admin (Step 6) |
| Support chat doesn't update live | `apsamo status` — the realtime service must be running |
| Payments stay in demo mode | `STRIPE_SECRET_KEY` missing → `apsamo env`, then `apsamo restart` |
| Plan doesn't activate after payment | Stripe webhook URL or `STRIPE_WEBHOOK_SECRET` wrong (Step 9) |
| Emails not arriving / in spam | SMTP settings (Step 7), SPF/DKIM/DMARC (Step 2), rDNS (Step 1) |
| Domain search fails | Admin → Servers → Dynadot → **Test connection**; add the IP it shows to Dynadot's allow-list |
| Domain registration fails | Dynadot account balance is empty (Step 0) |
| SFTP "permission denied" | The key in the customer's account must match their computer's key; the plan must include SSH access |
| "Use our nameservers" not offered | Step 12 (PowerDNS) not done |
| Webmail not loading | `apsamo setup-email` not run, or `mail` DNS record missing |
