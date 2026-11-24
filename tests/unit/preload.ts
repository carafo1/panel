/**
 * Loaded before every unit test file (see "test" in package.json).
 *
 * Modules like src/lib/auth.ts refuse to load without JWT_SECRET. Locally Bun
 * quietly reads the developer's .env, so tests passed here and crashed in CI,
 * where there is no .env. Unit tests must not depend on a real .env at all:
 * set throwaway values before anything is imported.
 */
process.env.JWT_SECRET = 'unit-tests-jwt-secret-not-for-production-0123456789'
process.env.ENCRYPTION_KEY = '0'.repeat(64)
process.env.CRON_API_KEY = 'unit-tests-cron-key'

// External services are never reached from unit tests: empty (not deleted)
// so a developer's real .env cannot fill them back in.
for (const k of [
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
  'DYNADOT_API_KEY', 'DYNADOT_SECRET_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'WAAFI_API_KEY', 'WAAFI_MERCHANT_UID', 'MAILCOW_API_URL', 'MAILCOW_API_KEY',
  'PDNS_API_URL', 'PDNS_API_KEY', 'CLOUDFLARE_API_TOKEN',
]) {
  process.env[k] = ''
}
