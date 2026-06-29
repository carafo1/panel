/**
 * reseed-domain-content.ts
 *
 * Updates existing DB content for the "domain-registration" service to:
 *  1. Remove all "Dynadot" brand-name mentions from user-facing text
 *  2. Fix plan prices to match the real live-synced DB prices
 *
 * Also updates SiteContent rows that reference "Dynadot".
 *
 * This is a one-off migration script. Run with:
 *   bun run scripts/reseed-domain-content.ts
 */
import { db } from '../src/lib/db'
import { SERVICES } from '../src/components/landing/services-data'
import { DEFAULT_CONTENT } from '../src/lib/content-schema'
import { ICON_REGISTRY } from '../src/components/landing/icon-registry'
import type { LucideIcon } from 'lucide-react'

function findIconName(icon: LucideIcon): string {
  for (const [name, comp] of Object.entries(ICON_REGISTRY)) {
    if (comp === icon) return name
  }
  return 'LayoutGrid'
}

async function reseedService() {
  const slug = 'domain-registration'
  const s = SERVICES.find((x) => x.slug === slug)
  if (!s) {
    console.log(`[reseed] Service "${slug}" not found in services-data.ts — skipping`)
    return
  }

  const existing = await db.service.findUnique({
    where: { slug },
    include: { plans: true, highlights: true, faqs: true },
  })

  if (!existing) {
    console.log(`[reseed] Service "${slug}" not found in DB — skipping`)
    return
  }

  console.log(`[reseed] Updating service "${slug}" (id=${existing.id})...`)

  // ── Update the service itself ──
  await db.service.update({
    where: { id: existing.id },
    data: {
      tagline: s.tagline,
      description: s.description,
      features: JSON.stringify(s.features),
      iconName: findIconName(s.icon),
    },
  })
  console.log(`  ✓ Updated tagline, description, features`)

  // ── Update plans (match by order, since names may have changed) ──
  for (let i = 0; i < s.plans.length; i++) {
    const newPlan = s.plans[i]
    const dbPlan = existing.plans.find((p) => p.order === i)
    if (!dbPlan) {
      console.log(`  ! Plan at order ${i} not found in DB — creating new`)
      await db.servicePlan.create({
        data: {
          serviceId: existing.id,
          name: newPlan.name,
          price: newPlan.price,
          period: newPlan.period,
          description: newPlan.description,
          features: JSON.stringify(newPlan.features),
          popular: newPlan.popular ?? false,
          order: i,
        },
      })
      continue
    }
    await db.servicePlan.update({
      where: { id: dbPlan.id },
      data: {
        name: newPlan.name,
        price: newPlan.price,
        period: newPlan.period,
        description: newPlan.description,
        features: JSON.stringify(newPlan.features),
        popular: newPlan.popular ?? false,
      },
    })
    console.log(`  ✓ Updated plan #${i}: ${newPlan.name} @ $${newPlan.price}`)
  }

  // ── Update highlights ──
  for (let i = 0; i < s.highlights.length; i++) {
    const newH = s.highlights[i]
    const dbH = existing.highlights.find((h) => h.order === i)
    if (!dbH) continue
    await db.serviceHighlight.update({
      where: { id: dbH.id },
      data: {
        title: newH.title,
        description: newH.description,
        iconName: findIconName(newH.icon),
      },
    })
    console.log(`  ✓ Updated highlight #${i}: ${newH.title}`)
  }

  // ── Update FAQs ──
  for (let i = 0; i < s.faqs.length; i++) {
    const newF = s.faqs[i]
    const dbF = existing.faqs.find((f) => f.order === i)
    if (!dbF) continue
    await db.serviceFaq.update({
      where: { id: dbF.id },
      data: {
        question: newF.q,
        answer: newF.a,
      },
    })
    console.log(`  ✓ Updated FAQ #${i}: ${newF.q}`)
  }
}

async function reseedSiteContent() {
  console.log(`\n[reseed] Updating SiteContent rows that reference "Dynadot"...`)

  // For each key in DEFAULT_CONTENT, if the DB has a row with the same key,
  // update it to the new default value. This only touches keys where the
  // default has changed (i.e. the ones we edited in content-schema.ts).
  const domainKeys = Object.entries(DEFAULT_CONTENT).filter(
    ([key, value]) =>
      key.startsWith('svc.domain-registration.') ||
      key.startsWith('widget.domain.') ||
      value.toLowerCase().includes('dynadot')
  )

  let updated = 0
  for (const [key, value] of domainKeys) {
    const existing = await db.siteContent.findUnique({ where: { key } })
    if (!existing) {
      // Key doesn't exist in DB — the default from DEFAULT_CONTENT will be
      // used automatically by getSiteContent(). No action needed.
      continue
    }
    if (existing.value === value) {
      // Already up to date
      continue
    }
    await db.siteContent.update({
      where: { key },
      data: { value },
    })
    console.log(`  ✓ Updated "${key}"`)
    updated++
  }
  console.log(`  ${updated} SiteContent rows updated`)

  // Also scan ALL SiteContent rows for any remaining "Dynadot" mentions
  // (e.g. custom keys the admin may have added)
  const allContent = await db.siteContent.findMany()
  const dynadotRows = allContent.filter((r) =>
    r.value.toLowerCase().includes('dynadot')
  )
  for (const row of dynadotRows) {
    const newValue = row.value
      .replace(/Dynadot-powered/gi, 'registrar-direct')
      .replace(/Dynadot wholesale/gi, 'wholesale')
      .replace(/Dynadot pricing/gi, 'live pricing')
      .replace(/Dynadot/gi, 'Apsamo')
    if (newValue !== row.value) {
      await db.siteContent.update({
        where: { key: row.key },
        data: { value: newValue },
      })
      console.log(`  ✓ Cleaned "Dynadot" from custom key "${row.key}"`)
    }
  }
}

async function main() {
  console.log('═══════════════════════════════════════════════════')
  console.log('  Re-seed Domain Content — remove "Dynadot" name')
  console.log('═══════════════════════════════════════════════════\n')

  await reseedService()
  await reseedSiteContent()

  console.log('\n═══════════════════════════════════════════════════')
  console.log('  ✅ Re-seed complete')
  console.log('═══════════════════════════════════════════════════')
}

main()
  .catch((err) => {
    console.error('Re-seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
