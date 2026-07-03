# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Apsamo Panel, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Email **security@apsamo.io** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Affected versions
   - Suggested fix (if any)
3. You'll receive a response within 48 hours.
4. We'll coordinate a fix + disclosure timeline with you.

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest `main` | ✅ |
| Previous minor | ⚠ Security fixes only |
| Older | ❌ Unsupported |

## Security measures implemented

### Authentication & authorization
- JWT-based auth (7-day expiry, signed with `JWT_SECRET`)
- bcrypt password hashing (cost factor 12)
- Optional 2FA via TOTP (`otplib`)
- API key support (`dh_` prefix, SHA-256 hashed at rest)
- Role-based access: `user` < `admin` < `super_admin`
- Ownership checks on every `[id]` route
- Admin-only routes check `admin` OR `super_admin`

### Encryption at rest
- AES-256-GCM via `ENCRYPTION_KEY` (64-char hex)
- Encrypts: DB passwords, FTP passwords, WP admin passwords, EPP auth codes, 2FA secrets, SMTP passwords
- `ENCRYPTION_KEY` is mandatory in production (panel refuses to boot without it)

### HTTP security
- HSTS (2 years, includeSubDomains, preload)
- X-Content-Type-Options: nosniff
- X-Frame-Options: SAMEORIGIN
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy (camera, microphone, geolocation denied)
- No `X-Powered-By` header
- Rate limiting on public endpoints (20 req/min for domain search)

### Data isolation
- Server IPs hidden from non-admin customers
- Container IDs + deploy paths hidden from non-admins
- DB connection details gated behind `?reveal=true`
- Webhook signing secrets masked in list views
- EPP auth codes encrypted at rest
- Audit log IPs/userAgents restricted to super_admin
- Dynadot brand hidden from customer responses
- Wholesale cost + markup hidden from non-admins
- Error messages sanitized (no `error.message` leaks)

### Secrets management
- `JWT_SECRET`, `ENCRYPTION_KEY`, `CRON_API_KEY` mandatory (no hardcoded fallbacks)
- `.env` file permissions set to 600
- `.env` is gitignored (never committed)
- Placeholder values detected + rejected at startup
- No hardcoded API keys in source code

### Customer data protection
- Customer passwords: bcrypt-hashed (one-way, never recoverable)
- Customer DB passwords: AES-256-GCM encrypted (recoverable by admin for support)
- Cross-tenant isolation enforced via `where: { userId: decoded.userId }`
- All sensitive operations audit-logged

## Security audit

Run the automated security scan:

```bash
# On the VPS
apsamo security-audit

# Or directly
bash deploy/scripts/security-audit.sh

# Comprehensive scan (all 161 API routes)
bash deploy/scripts/comprehensive-security-scan.sh
```

The scan checks for:
1. Hardcoded JWT_SECRET / CRON_API_KEY fallbacks
2. Unauthenticated seed endpoints
3. Error message leaks in API responses
4. Server IP leaks in customer-facing responses
5. HTTP security headers
6. Webhook secret masking
7. super_admin role check consistency
8. Required environment variables
9. `.env` file permissions
10. Hardcoded secrets in source code

## Incident response

If a breach is suspected:

1. **Rotate secrets immediately:**
   ```bash
   # Generate new secrets
   openssl rand -base64 32  # JWT_SECRET
   openssl rand -hex 32     # ENCRYPTION_KEY (⚠ invalidates all encrypted data!)
   openssl rand -hex 32     # CRON_API_KEY

   # Update .env
   apsamo env

   # Restart
   apsamo restart
   ```

2. **Force logout all users** (rotate `JWT_SECRET` — invalidates all active sessions)

3. **Check audit logs:**
   ```bash
   apsamo db-shell
   SELECT * FROM AuditLog ORDER BY createdAt DESC LIMIT 100;
   ```

4. **Review access:**
   ```bash
   # List all users
   apsamo db-shell
   SELECT email, role, createdAt FROM User ORDER BY createdAt DESC;

   # List all API keys
   SELECT id, prefix, lastUsedAt FROM ApiKey ORDER BY createdAt DESC;
   ```

5. **Restore from backup if data was modified:**
   ```bash
   apsamo restore /opt/apsamo/backups/apsamo-backup-YYYYMMDD-HHMMSS.tar.gz
   ```

## Security checklist for production

Before going live:

- [ ] `JWT_SECRET` set to a strong random value (not placeholder)
- [ ] `ENCRYPTION_KEY` set to a 64-char hex string
- [ ] `CRON_API_KEY` set to a strong random value
- [ ] `.env` file permissions are 600
- [ ] `.env` is not committed to git
- [ ] HTTPS enforced (Caddy auto-provisions Let's Encrypt certs)
- [ ] Firewall active (ufw on 22/80/443 only)
- [ ] fail2ban enabled for SSH
- [ ] Daily backups scheduled (cron at 3 AM)
- [ ] Off-site backup sync configured (rclone to S3/B2)
- [ ] Health monitoring set up (`apsamo setup-monitoring`)
- [ ] All `replace-with-*` placeholders removed from `.env`
- [ ] Admin password is strong (min 12 chars)
- [ ] 2FA enabled on admin account
- [ ] `apsamo verify` passes all 27 checks
- [ ] `apsamo security-audit` passes all 10 checks

## Dependency scanning

We use:
- **Dependabot** (`.github/dependabot.yml`) — automatic PRs for npm + GitHub Actions updates
- **npm audit** — runs in CI on every push
- **Custom security scan** — `deploy/scripts/comprehensive-security-scan.sh`

## Contact

- Security issues: **security@apsamo.io**
- General support: **support@apsamo.io**
- Bug reports: [GitHub Issues](https://github.com/carafo1/panel/issues)
