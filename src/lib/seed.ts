import { db } from '@/lib/db'

export async function seedDatabase() {
  // Seed Plans
  const existingPlans = await db.plan.count()
  if (existingPlans === 0) {
    await db.plan.createMany({
      data: [
        {
          name: 'Starter',
          slug: 'starter',
          description: 'Perfect for personal projects and small websites',
          price: 9,
          ram: '1GB',
          cpu: '1 vCPU',
          storage: '10GB',
          bandwidth: '100GB',
          projects: 1,
          ssl: true,
          customDomain: false,
          priority: 1,
          popular: false,
        },
        {
          name: 'Pro',
          slug: 'pro',
          description: 'Ideal for growing businesses and teams',
          price: 29,
          ram: '4GB',
          cpu: '2 vCPU',
          storage: '50GB',
          bandwidth: '500GB',
          projects: 5,
          ssl: true,
          customDomain: true,
          priority: 2,
          popular: true,
        },
        {
          name: 'Business',
          slug: 'business',
          description: 'For large-scale applications and enterprises',
          price: 79,
          ram: '16GB',
          cpu: '4 vCPU',
          storage: '200GB',
          bandwidth: 'Unlimited',
          projects: 999,
          ssl: true,
          customDomain: true,
          priority: 3,
          popular: false,
        },
      ],
    })
    console.log('✅ Plans seeded')
  }

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
