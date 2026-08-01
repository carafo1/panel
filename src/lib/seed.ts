import { db } from '@/lib/db'

export async function seedDatabase() {
  // Plans are NOT seeded here.
  //
  // This used to create Starter $9 / Pro $29 / Business $79 — prices that were
  // superseded by the real catalogue (Starter $4.99, Professional $8.99,
  // Enterprise $17.99, seeded by scripts/seed-plans.ts). Leaving them here
  // meant an empty Plan table would silently repopulate with prices the
  // business does not sell, on a public endpoint that renders straight onto the
  // pricing page.
  //
  // Run `bun run scripts/seed-plans.ts` to establish the real catalogue; it is
  // idempotent and shows a dry run first.

  // Seed demo Servers — DEV ONLY. In production the installer registers a real
  // "localhost" server (single-box) or you add real VPS hosts via Admin → Servers.
  const existingServers = await db.server.count()
  if (existingServers === 0 && process.env.NODE_ENV !== 'production') {
    await db.server.createMany({
      data: [
        {
          name: 'EU-Central-1',
          ip: '185.234.72.10',
          provider: 'netcup',
          status: 'active',
          cpuCores: 8,
          ramGB: 32,
          storageGB: 500,
          bandwidthGB: 1000,
          usedRamGB: 8.5,
          usedStorageGB: 120.3,
          region: 'eu-central',
        },
        {
          name: 'US-East-1',
          ip: '192.168.1.50',
          provider: 'netcup',
          status: 'active',
          cpuCores: 16,
          ramGB: 64,
          storageGB: 1000,
          bandwidthGB: 2000,
          usedRamGB: 12.0,
          usedStorageGB: 250.7,
          region: 'us-east',
        },
      ],
    })
    console.log('✅ Servers seeded')
  }

  // Seed demo Admin User — DEV ONLY (admin@deployhub.io / admin123). In
  // production the installer creates the real admin from the email/password you
  // provide (see deploy/install.sh), so we never seed a default admin there.
  const adminExists = await db.user.findFirst({ where: { role: 'admin' } })
  if (!adminExists && process.env.NODE_ENV !== 'production') {
    const { hashPassword } = await import('@/lib/auth')
    const hashedPassword = await hashPassword('admin123')
    await db.user.create({
      data: {
        email: 'admin@deployhub.io',
        name: 'Admin User',
        password: hashedPassword,
        role: 'admin',
        emailVerified: true,
      },
    })
    console.log('✅ Admin user seeded')
  }

  console.log('🎉 Database seeding complete')
}
