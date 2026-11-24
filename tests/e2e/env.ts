/**
 * The complete environment the e2e panel runs with.
 *
 * Every value the app reads is set here on purpose, so the suite never picks
 * up a developer's real `.env`:
 *   - __NEXT_PROCESSED_ENV=true tells Next.js its env is already loaded, so it
 *     skips reading .env / .env.production / .env.local;
 *   - Prisma ALSO loads .env into any variable that is unset, so every
 *     third-party credential is set to an EMPTY string (empty = "set" for the
 *     loaders, and "not configured" for the app). Nothing can reach Dynadot,
 *     Stripe, Mailcow, an SMTP server, an AI provider or a real VPS.
 *   - DATABASE_URL points at a throwaway SQLite file in the OS temp folder.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BASE_URL, E2E_PORT } from './fixtures'

export const E2E_DIR = join(tmpdir(), 'apsamo-e2e')
export const E2E_DB_FILE = join(E2E_DIR, 'e2e.db').replace(/\\/g, '/')

/** Third-party credentials and endpoints, all forced empty. */
const BLANK = [
  'DYNADOT_API_KEY', 'DYNADOT_SECRET_KEY',
  'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_ID_DEFAULT', 'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_ALLOW_UNSIGNED',
  'WAAFI_API_URL', 'WAAFI_MERCHANT_ID', 'WAAFI_MERCHANT_UID', 'WAAFI_API_KEY', 'WAAFI_API_USER_ID',
  'RAZORPAY_KEY_ID', 'PAYSTACK_SECRET_KEY', 'FLUTTERWAVE_SECRET_KEY',
  'MAILCOW_API_URL', 'MAILCOW_API_KEY', 'MAILCOW_POSTFIX_CONTAINER', 'MAILCOW_DOVECOT_CONTAINER',
  'EMAIL_PROVIDER', 'EMAIL_API_KEY', 'RESEND_API_KEY',
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM_NAME', 'SMTP_FROM_EMAIL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_EFFORT',
  'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET',
  'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID',
  'PDNS_API_URL', 'PDNS_API_KEY',
  'PMA_URL', 'PGADMIN_URL', 'WEBMAIL_URL', 'WEBMAIL_HOSTNAME',
  'SERVER_PUBLIC_IP', 'MAIL_SERVER_IP',
  'NEXTAUTH_SECRET',
]

export function e2eEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of BLANK) env[k] = ''
  return {
    ...env,
    __NEXT_PROCESSED_ENV: 'true',
    NEXT_TELEMETRY_DISABLED: '1',
    PORT: String(E2E_PORT),
    DB_ENGINE: 'sqlite',
    DATABASE_URL: `file:${E2E_DB_FILE}`,
    // Throwaway secrets, used by nothing but this local test server.
    JWT_SECRET: 'e2e-only-jwt-secret-not-for-production-0123456789abcdef',
    ENCRYPTION_KEY: 'e'.repeat(64),
    CRON_API_KEY: 'e2e-only-cron-key',
    APP_URL: BASE_URL,
    NEXT_PUBLIC_APP_URL: BASE_URL,
    NEXTAUTH_URL: BASE_URL,
    BRAND_DOMAIN: 'apsamo.test',
    NEXT_PUBLIC_BRAND_DOMAIN: 'apsamo.test',
    APP_SUBDOMAIN_PATTERN: '{slug}.apsamo.test',
    NS1_HOSTNAME: 'ns1.apsamo.test',
    NS2_HOSTNAME: 'ns2.apsamo.test',
    MAIL_SERVER_HOSTNAME: 'mail.apsamo.test',
    SUPPORT_EMAIL: 'support@apsamo.test',
    BILLING_EMAIL: 'billing@apsamo.test',
    ADMIN_EMAIL: 'admin@apsamo.test',
    NO_REPLY_EMAIL: 'no-reply@apsamo.test',
    ALERT_EMAIL: '',
    LE_EMAIL: 'admin@apsamo.test',
    // Every server operation is simulated: no Docker, no SSH, no VPS.
    VPS_DEMO_MODE: '1',
    STORAGE_ROOT: join(E2E_DIR, 'storage'),
    BACKUP_DIR: join(E2E_DIR, 'backups'),
    MIGRATION_WORK_ROOT: join(E2E_DIR, 'migrations'),
    MIGRATION_UPLOAD_ROOT: join(E2E_DIR, 'uploads'),
    // No customer cron jobs to run, and none should fire during a test.
    DISABLE_CRON_SCHEDULER: '1',
    // The realtime service (mini-services/realtime-service) is not started.
    REALTIME_INTERNAL_URL: 'http://127.0.0.1:9',
  }
}
