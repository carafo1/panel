/**
 * Run seedDatabase() standalone so we can populate Plans, Servers, and the
 * admin user before starting the dev server.
 */
import { seedDatabase } from '../src/lib/seed'

async function main() {
  try {
    await seedDatabase()
    console.log('✅ Seed script complete')
    process.exit(0)
  } catch (err) {
    console.error('❌ Seed failed:', err)
    process.exit(1)
  }
}

main()
