# Apsamo Panel — what still needs adding

Status on 24 Nov 2026, after a full live check of the customer side (every
dashboard section, every website-management section and the main actions,
run as a real customer account on production).

**Working now:** sign-in, dashboard, hosting (WordPress install, redeploy,
files, uploads up to 100 MB, terminal, logs, container, SSL, backups,
staging, cron, redirects, security rules), custom domains through
ns1/ns2.apsamo.com (zone, verification, www, SSL), Database Studio,
phpMyAdmin, email mailboxes, domain search with live Dynadot prices,
invoices, plans, notifications, monitors, support tickets, teams,
webhooks, pipelines. 87/87 production checks pass
(`deploy/scripts/live-check.sh`).

---

## 1. Needs a decision or an account from you (blocks a feature)

| # | Item | Why | What is needed |
|---|---|---|---|
| 1 | **Online payments** | Customers can only pay by bank transfer; every order waits for a manual approval. | Stripe and/or Waafi (EVC/Zaad/Sahal) merchant account and API keys. The code supports both. |
| 2 | **AI assistant** | No AI provider is connected; the assistant now says so and shows account data instead of failing. | Choose a provider (e.g. Anthropic Claude) and add its API key; budget per month. |
| 3 | **Malware scanning** | ClamAV is installed but off (`SKIP_CLAMD=y`): it needs 1–1.5 GB RAM and the server has ~1.4 GB free. Also scans incoming mail when on. | Upgrade the VPS (VPS 500 → VPS 1000, 8 GB), then enable it. |
| 4 | **Second nameserver** | ns1 and ns2 are the same server: if it is down, every customer domain on our DNS stops resolving. | A small second VPS (or a secondary-DNS service) for ns2, replicating zones from PowerDNS. |
| 5 | **Off-server backups** | Nightly backups stay on the same disk; a server loss loses them too. | A destination: Netcup Storage Space, Backblaze B2, S3, or Google Drive. |

## 2. Security tasks (you, 5–10 minutes each)

| # | Item |
|---|---|
| 6 | Set your own Mailcow admin password in the *mail admin password* terminal tab (not the Netcup console: its German keyboard changes characters), then turn on two-factor. |
| 7 | Reset the panel admin password (`apsamo reset-password admin@apsamo.com`) and turn on two-factor in Settings. |
| 8 | Rotate the Dynadot API key and secret (they were exposed earlier). |
| 9 | Rotate Stripe keys when payments are set up (item 1). |

## 3. Product features to add (development)

| # | Feature | Notes |
|---|---|---|
| 10 | **Customer domain-order list** | Orders waiting for payment, being registered, or in manual review are invisible to the customer until the domain exists. Needs `GET /api/domains/orders` + a list in Domains. The wording is already written. |
| 11 | **Orphaned-resource cleanup** | Reconcile should report (and, after approval, remove) database containers, volumes and files that no project uses — today's redeploy bug left four. |
| 12 | **Streamed backup downloads** | A download loads the whole archive into memory; large sites can exhaust RAM. |
| 13 | **Default backup retention** | Without a plan setting, backups are kept forever. |
| 14 | **Audit log for environment variables** | Create/update/delete of env vars is not recorded. |
| 15 | **Scheduled live checks with alerts** | Run `live-check.sh` every 15 min and email the admin on any failure. |
| 16 | **Browser end-to-end tests in CI** | CI has unit + scenario tests but no browser tests of the customer flows (sign-in, create site, connect domain, upload, database). The bugs fixed today would have been caught. |
| 17 | **SFTP onboarding** | FTP was removed (no FTP server exists). Add a short guide and a key generator in the SFTP section. |
| 18 | **Capacity view for admins** | RAM/disk per customer site and per server, warning before a server is full. |

## 4. Customer follow-up (not code)

| # | Item |
|---|---|
| 19 | The customer *Qansorobad Digital Printing* should run **Import Site** again on `public html`: their old site was never imported (database `u317305639_IWDFJ` is empty). The new WordPress admin password is in the WordPress tab. |
| 20 | Their plan shows "Databases: 6 of 5" until the four leftover database containers are removed (needs your approval). |

---

### Fixed during this check (24 Nov 2026)

- WordPress tab listed no plugins, themes or admins (a PHP notice broke the JSON).
- Every WordPress redeploy created a new database container (5 for one site).
- A site's domain appeared twice in its domain list.
- The AI assistant failed on every message (no provider); it now answers honestly.
- Earlier today: domain connection through ns1/ns2, uploads over 10 MB,
  WordPress install, Database Studio on MySQL, phpMyAdmin, panel email
  (no-reply mailbox), www and subdomain serving, reverse DNS for mail.
