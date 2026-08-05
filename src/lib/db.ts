import { PrismaClient } from '@prisma/client'

/**
 * SQLite concurrency.
 *
 * The database shipped on `journal_mode = delete` with `busy_timeout = 0`,
 * which is the worst pairing available: a rollback-journal writer takes an
 * EXCLUSIVE lock on the whole file, and a zero timeout means any concurrent
 * reader gives up instantly rather than waiting. That is why reads returned
 *
 *     Error: in prepare, database is locked (5)
 *
 * whenever a deployment was writing stage updates — and it would have got
 * worse with concurrent deploys, not better.
 *
 * WAL lets readers continue while a writer works, and busy_timeout makes the
 * remaining writer-vs-writer overlaps wait instead of failing. journal_mode is
 * persisted in the file header, so it survives restarts; busy_timeout is
 * per-connection and has to be set each time.
 */
async function applySqlitePragmas(client: PrismaClient): Promise<void> {
  if (!(process.env.DATABASE_URL || '').startsWith('file:')) return
  try {
    await client.$executeRawUnsafe('PRAGMA journal_mode = WAL')
    await client.$executeRawUnsafe('PRAGMA busy_timeout = 5000')
    await client.$executeRawUnsafe('PRAGMA synchronous = NORMAL')
  } catch (err) {
    console.error('[db] could not apply SQLite pragmas:', err)
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaSchemaVersion?: string
}

/**
 * Bump this version whenever the Prisma schema changes significantly
 * (new models, new fields, etc.). When the version doesn't match the
 * cached one, the old PrismaClient is discarded and a fresh one is
 * created with the updated schema.
 *
 * This matters because Next.js dev mode caches the PrismaClient on
 * `globalThis` for the lifetime of the Node.js process. Without this
 * check, schema changes (e.g. adding the AuditLog model) wouldn't be
 * picked up until the dev server is manually restarted.
 *
 * Additionally, we bust the Node.js require-cache for `@prisma/client`
 * so the latest generated client (with newly added columns) is loaded
 * even if the dev server's Turbopack has cached an older copy from
 * before `prisma db push` regenerated the client.
 */
const SCHEMA_VERSION = '2025-06-25-cms-services'

// Bust the require cache for the generated Prisma client so the latest
// schema (e.g. the new `stripeCustomerId` column on Subscription) is
// picked up without a full dev-server restart.
try {
  const generatedClientPath = require.resolve('@prisma/client/index.js')
  if (generatedClientPath) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path')
    const generatedDir = path.dirname(generatedClientPath)

    Object.keys(require.cache).forEach((key) => {
      if (
        key.startsWith(generatedDir) ||
        key.includes('.prisma' + path.sep + 'client') ||
        key.includes('@prisma' + path.sep + 'client')
      ) {
        delete require.cache[key]
      }
    })
  }
} catch {
  // Ignore cache-bust failures - safe to fall through.
}

if (globalForPrisma.prismaSchemaVersion !== SCHEMA_VERSION) {
  if (globalForPrisma.prisma) {
    // Fire-and-forget disconnect — don't block module loading on cleanup.
    globalForPrisma.prisma.$disconnect().catch(() => {})
  }
  globalForPrisma.prisma = undefined
  globalForPrisma.prismaSchemaVersion = SCHEMA_VERSION
}

// Re-import PrismaClient after busting the cache so we get the fresh class
// definition that knows about newly added columns (e.g. stripeCustomerId).
/* eslint-disable @typescript-eslint/no-require-imports */
const FreshPrismaClient =
  require('@prisma/client').PrismaClient as typeof PrismaClient
/* eslint-enable @typescript-eslint/no-require-imports */

export const db =
  globalForPrisma.prisma ??
  new FreshPrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// Fire-and-forget: the pragmas apply to the connection Prisma opens, and every
// query after this point benefits. Failing to set them is not a reason to
// refuse to start — it just leaves the previous, contended behaviour.
void applySqlitePragmas(db)
