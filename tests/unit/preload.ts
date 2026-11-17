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
