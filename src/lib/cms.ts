import { db } from '@/lib/db'
import { SERVICES } from '@/components/landing/services-data'
import { ICON_REGISTRY, resolveIcon } from '@/components/landing/icon-registry'
import { DEFAULT_CONTENT } from '@/lib/content-schema'
import type { LucideIcon } from 'lucide-react'

/**
 * Server-side CMS data layer.
 *
 * Reads services + site text from the database. If the DB is empty (first
 * run), it auto-seeds from the static `services-data.ts` content so the
 * public site always has something to show.
 *
 * All functions return plain JSON-serialisable objects (icons resolved to
 * their string names) so they can be sent over HTTP to client components.
 */

export interface CmsServicePlan {
  id: string
  name: string
  price: number
  period: string
  description: string
  features: string[]
  popular: boolean
}

export interface CmsServiceHighlight {
  title: string
  description: string
  iconName: string
}

export interface CmsServiceFaq {
  q: string
  a: string
}

export interface CmsService {
  id: string
  slug: string
  name: string
  tagline: string
  description: string
  iconName: string
  accent: string
  features: string[]
  order: number
  visible: boolean
  plans: CmsServicePlan[]
  highlights: CmsServiceHighlight[]
  faqs: CmsServiceFaq[]
}

export interface CmsSiteContent {
  [key: string]: string
}

export interface CmsFullContent {
  services: CmsService[]
  content: CmsSiteContent
  seeded: boolean
}

/** Parse a JSON string field, falling back to the provided default. */
function parseJsonArray(value: string | null | undefined, fallback: string[] = []): string[] {
  if (!value) return fallback
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Serialise a raw DB Service row (with relations) into a CmsService. */
function serialiseService(
  row: {
    id: string
    slug: string
    name: string
    tagline: string
    description: string
    iconName: string
    accent: string
    features: string
    order: number
    visible: boolean
    plans: {
      id: string
      name: string
      price: number
      period: string
      description: string
      features: string
      popular: boolean
      order: number
    }[]
    highlights: {
      title: string
      description: string
      iconName: string
      order: number
    }[]
    faqs: {
      question: string
      answer: string
      order: number
    }[]
  }
): CmsService {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    iconName: row.iconName,
    accent: row.accent,
    features: parseJsonArray(row.features),
    order: row.order,
    visible: row.visible,
    plans: row.plans
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        period: p.period,
        description: p.description,
        features: parseJsonArray(p.features),
        popular: p.popular,
      })),
    highlights: row.highlights
      .sort((a, b) => a.order - b.order)
      .map((h) => ({
        title: h.title,
        description: h.description,
        iconName: h.iconName,
      })),
    faqs: row.faqs
      .sort((a, b) => a.order - b.order)
      .map((f) => ({
        q: f.question,
        a: f.answer,
      })),
  }
}

/**
 * Seed the DB from the static `services-data.ts` content. Idempotent: only
 * inserts if the Service table is empty. Returns true if seeding happened.
 */
export async function seedServicesIfEmpty(): Promise<boolean> {
  const count = await db.service.count()
  if (count > 0) return false

  for (let i = 0; i < SERVICES.length; i++) {
    const s = SERVICES[i]
    // Resolve the static icon component back to a string name.
    const iconName = findIconName(s.icon) ?? 'LayoutGrid'
    await db.service.create({
      data: {
        slug: s.slug,
        name: s.name,
        tagline: s.tagline,
        description: s.description,
        iconName,
        accent: s.accent,
        features: JSON.stringify(s.features),
        order: i,
        visible: true,
        plans: {
          create: s.plans.map((p, pi) => ({
            name: p.name,
            price: p.price,
            period: p.period,
            description: p.description,
            features: JSON.stringify(p.features),
            popular: p.popular ?? false,
            order: pi,
          })),
        },
        highlights: {
          create: s.highlights.map((h, hi) => ({
            title: h.title,
            description: h.description,
            iconName: findIconName(h.icon) ?? 'LayoutGrid',
            order: hi,
          })),
        },
        faqs: {
          create: s.faqs.map((f, fi) => ({
            question: f.q,
            answer: f.a,
            order: fi,
          })),
        },
      },
    })
  }
  return true
}

/** Reverse-lookup a lucide component to its registry name. */
function findIconName(icon: LucideIcon): string | undefined {
  for (const [name, comp] of Object.entries(ICON_REGISTRY)) {
    if (comp === icon) return name
  }
  return undefined
}

/**
 * Get all published (visible) services for the public site, sorted by order.
 * Auto-seeds the DB on first call. Includes plans, highlights, and FAQs.
 */
export async function getPublishedServices(): Promise<CmsService[]> {
  await seedServicesIfEmpty()
  const rows = await db.service.findMany({
    where: { visible: true },
    include: { plans: true, highlights: true, faqs: true },
    orderBy: { order: 'asc' },
  })
  return rows.map(serialiseService)
}

/**
 * Get ALL services (including hidden) for the admin panel.
 */
export async function getAllServicesForAdmin(): Promise<CmsService[]> {
  await seedServicesIfEmpty()
  const rows = await db.service.findMany({
    include: { plans: true, highlights: true, faqs: true },
    orderBy: { order: 'asc' },
  })
  return rows.map(serialiseService)
}

/**
 * Get a single service by slug (public: only if visible).
 */
export async function getServiceBySlug(slug: string): Promise<CmsService | null> {
  await seedServicesIfEmpty()
  const row = await db.service.findFirst({
    where: { slug, visible: true },
    include: { plans: true, highlights: true, faqs: true },
  })
  return row ? serialiseService(row) : null
}

/**
 * Get all site content key/value pairs as a plain object.
 *
 * Merges the admin-overridden DB values OVER the default schema values, so
 * every known key always resolves (pages never receive an empty string) and
 * the admin editor always shows pre-filled fields. Custom keys the admin may
 * have added that aren't in the schema are preserved.
 */
export async function getSiteContent(): Promise<CmsSiteContent> {
  const rows = await db.siteContent.findMany()
  const dbValues: CmsSiteContent = {}
  for (const r of rows) dbValues[r.key] = r.value
  return { ...DEFAULT_CONTENT, ...dbValues }
}

/**
 * Get the full CMS payload (services + content) for the public site in one
 * call. Auto-seeds the DB on first run.
 */
export async function getFullSiteContent(): Promise<CmsFullContent> {
  const seeded = await seedServicesIfEmpty()
  const [services, content] = await Promise.all([
    getPublishedServices(),
    getSiteContent(),
  ])
  return { services, content, seeded }
}

/** Re-export for client convenience. */
export { resolveIcon }
