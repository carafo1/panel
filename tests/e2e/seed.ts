/**
 * Builds the isolated e2e database from scratch.
 *
 *   bun tests/e2e/seed.ts
 *
 * 1. deletes and recreates the SQLite file named by tests/e2e/env.ts (in the
 *    OS temp folder — never the dev database under prisma/db)
 * 2. creates every table from prisma/schema.prisma (`prisma db push`)
 * 3. inserts the customer, a second tenant, a plan with an active
 *    subscription, and one WordPress website with no server (demo mode)
 *
 * Safe to run any number of times. Refuses to touch any database that is not
 * the e2e temp file.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import bcrypt from 'bcryptjs'
import { CUSTOMER, OTHER_TENANT, PLAN, SITE } from './fixtures'
import { E2E_DB_FILE, E2E_DIR, e2eEnv } from './env'

const DAY = 24 * 60 * 60 * 1000

export async function seed(): Promise<void> {
  const env = e2eEnv()
  if (env.DATABASE_URL !== `file:${E2E_DB_FILE}` || !E2E_DB_FILE.includes('apsamo-e2e')) {
    throw new Error(`e2e seed: refusing to seed ${env.DATABASE_URL}`)
  }

  mkdirSync(E2E_DIR, { recursive: true })
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rmSync(E2E_DB_FILE + suffix, { force: true })
  }
  for (const dir of ['storage', 'backups', 'migrations', 'uploads']) {
    mkdirSync(join(E2E_DIR, dir), { recursive: true })
  }

  // The Prisma CLI's own entry file, run with this runtime: the shims in
  // node_modules/.bin differ by OS and installer (prisma, prisma.cmd,
  // prisma.exe), and a shell would trip over spaces in the repo path.
  const prismaCli = join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js')
  if (!existsSync(prismaCli)) throw new Error(`e2e seed: ${prismaCli} not found — run bun install`)
  const push = Bun.spawnSync([process.execPath, prismaCli, 'db', 'push', '--skip-generate', '--accept-data-loss'], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (push.exitCode !== 0) {
    console.error(push.stdout.toString(), push.stderr.toString())
    throw new Error('e2e seed: prisma db push failed')
  }

  // Imported only after DATABASE_URL is final, and given it explicitly.
  process.env.DATABASE_URL = env.DATABASE_URL
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } })

  try {
    const now = Date.now()

    await db.plan.create({
      data: {
        id: PLAN.id,
        name: PLAN.name,
        slug: PLAN.slug,
        description: 'Plan used by the browser end-to-end tests',
        price: 12,
        ram: '2GB',
        cpu: '1 vCPU',
        storage: '20GB',
        bandwidth: '200GB',
        projects: 5,
        customDomain: true,
        billingCycle: 'monthly',
      },
    })

    for (const u of [CUSTOMER, OTHER_TENANT]) {
      await db.user.create({
        data: {
          id: u.id,
          name: u.name,
          email: u.email,
          password: await bcrypt.hash(u.password, 10),
          role: 'user',
          status: 'active',
          emailVerified: true,
        },
      })
      await db.subscription.create({
        data: {
          userId: u.id,
          planId: PLAN.id,
          status: 'active',
          currentPeriodStart: new Date(now - 5 * DAY),
          currentPeriodEnd: new Date(now + 25 * DAY),
        },
      })
    }

    await db.project.create({
      data: {
        id: SITE.id,
        userId: CUSTOMER.id,
        name: SITE.name,
        slug: SITE.slug,
        description: 'Seeded WordPress site (demo mode, no server)',
        framework: 'wordpress',
        stack: 'wordpress',
        deploymentMethod: 'wordpress',
        status: 'running',
        subdomain: SITE.subdomain,
        customDomain: SITE.customDomain,
        deployPath: SITE.deployPath,
        sslEnabled: true,
        sslCertStatus: 'issued',
        sslCertExpiry: new Date(now + 60 * DAY),
        lastDeployedAt: new Date(now - DAY),
        wpAdminUser: 'erin',
        wpAdminEmail: CUSTOMER.email,
        databaseType: 'mysql',
      },
    })
    await db.websiteDomain.create({
      data: {
        projectId: SITE.id,
        domain: SITE.customDomain,
        isPrimary: true,
        verified: true,
        verificationMethod: 'nameserver',
        verifiedAt: new Date(now - DAY),
        sslStatus: 'issued',
      },
    })
    await db.domain.create({
      data: {
        userId: CUSTOMER.id,
        projectId: SITE.id,
        name: SITE.customDomain,
        status: 'active',
        registrar: 'external',
        provider: 'external',
      },
    })

    await db.project.create({
      data: {
        id: OTHER_TENANT.projectId,
        userId: OTHER_TENANT.id,
        name: OTHER_TENANT.projectName,
        slug: 'other-tenant-shop',
        framework: 'static',
        stack: 'static',
        status: 'running',
        subdomain: 'other-tenant-shop.apsamo.test',
        deployPath: '/opt/apsamo/sites/other-tenant-shop',
      },
    })
  } finally {
    await db.$disconnect()
  }

  console.log(`e2e seed: ready at ${E2E_DB_FILE}`)
}

if (import.meta.main) {
  seed().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
