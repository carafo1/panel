import { PrismaClient } from '@prisma/client'

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
