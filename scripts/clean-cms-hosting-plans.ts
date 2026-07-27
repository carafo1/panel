/**
 * Remove the CMS hosting plans now that the billing catalogue owns them.
 *
 * Run:  bun run scripts/clean-cms-hosting-plans.ts        (preview)
 *       bun run scripts/clean-cms-hosting-plans.ts --apply
 *
 * These `ServicePlan` rows advertised Hobby $9 / Pro $29 / Business $99 while
 * checkout charged $4.99 / $8.99 / $17.99. Nothing renders them any more, but
 * leaving them behind means the next person to read the database finds two
 * conflicting sets of hosting prices and has to work out which one is real.
 *
 * Only the web-hosting service is touched. Other services keep their CMS plans
 * — those are quotes for bespoke work, not subscribable products.
 */
import { db } from '../src/lib/db'

const APPLY = process.argv.includes('--apply')
const HOSTING_SLUG = 'web-hosting'

async function main() {
  const service = await db.service.findUnique({
    where: { slug: HOSTING_SLUG },
    include: { plans: true },
  })

  if (!service) {
    console.log(`no "${HOSTING_SLUG}" service found — nothing to do`)
    return
  }

  if (service.plans.length === 0) {
    console.log('already clean — no CMS hosting plans remain')
    return
  }

  console.log(
    APPLY ? 'removing stale CMS hosting plans:' : 'would remove (pass --apply):'
  )
  for (const p of service.plans) {
    console.log(`  ${p.name.padEnd(12)} $${p.price}${p.period}`)
  }

  const billed = await db.plan.findMany({
    where: { active: true, archived: false },
    orderBy: { priority: 'asc' },
    select: { name: true, price: true, annualPrice: true },
  })
  console.log('\nthe catalogue these pages now render instead:')
  for (const p of billed) {
    console.log(
      `  ${p.name.padEnd(14)} $${p.price}/mo${p.annualPrice ? `  $${p.annualPrice}/yr` : ''}`
    )
  }

  if (!APPLY) return

  const { count } = await db.servicePlan.deleteMany({
    where: { serviceId: service.id },
  })
  console.log(`\nremoved ${count} stale row(s).`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
