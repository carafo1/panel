/**
 * Preload for the scenario tests (bun test --preload). Runs once per test
 * process, BEFORE any src module is imported:
 *
 *   1. points DATABASE_URL at a fresh SQLite file in a temp directory and
 *      creates every table from prisma/schema.prisma (`prisma db push`)
 *   2. sets test-only secrets, so nothing here can read a real .env value
 *
 * Every scenario creates its own users/projects with unique names, so files
 * share this one database without depending on each other's data.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'apsamo-scenarios-'))
const dbFile = join(dir, 'test.db').replace(/\\/g, '/')

process.env.DATABASE_URL = `file:${dbFile}`
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'scenario-tests-jwt-secret-not-for-production-0123456789'
process.env.ENCRYPTION_KEY = '1'.repeat(64)
process.env.CRON_API_KEY = 'scenario-tests-cron-key'
// No outbound mail, payments or registrar calls from tests.
delete process.env.EMAIL_PROVIDER
delete process.env.SMTP_HOST
delete process.env.STRIPE_SECRET_KEY
delete process.env.DYNADOT_API_KEY

const prismaBin = join(process.cwd(), 'node_modules', '.bin', process.platform === 'win32' ? 'prisma.cmd' : 'prisma')
const push = Bun.spawnSync([prismaBin, 'db', 'push', '--skip-generate', '--accept-data-loss'], {
  env: { ...process.env },
  stdout: 'pipe',
  stderr: 'pipe',
})
if (push.exitCode !== 0) {
  console.error(push.stdout.toString(), push.stderr.toString())
  throw new Error('scenario preload: prisma db push failed')
}

process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* Windows may still hold the file; the OS temp cleaner will get it */
  }
})
