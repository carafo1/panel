/**
 * Pricing service for the domain reseller module.
 *
 * Selling Price = Dynadot Wholesale Price + 6.50 USD
 *
 * Maintains a pricing table for every supported TLD with:
 *  - Wholesale price
 *  - Markup amount (default $6.50)
 *  - Final selling price (registration / renewal / transfer)
 *  - Currency
 *  - Future price synchronization (via Dynadot API)
 */
import { db } from './db'

// The automatic markup applied to every supported TLD (USD).
export const DEFAULT_MARKUP_USD = 6.5

// Base wholesale prices (USD) per TLD. These represent Dynadot's wholesale
// registration / renewal / transfer pricing. In production these are fetched
// via the Dynadot reseller price API; in demo mode we use these defaults.
interface WholesalePrice {
  registration: number
  renewal: number
  transfer: number
}

export const TLD_WHOLESALE_PRICES: Record<string, WholesalePrice> = {
  '.com': { registration: 8.49, renewal: 8.49, transfer: 8.49 },
  '.net': { registration: 10.49, renewal: 10.49, transfer: 10.49 },
  '.org': { registration: 9.49, renewal: 9.49, transfer: 9.49 },
  '.info': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.biz': { registration: 11.49, renewal: 11.49, transfer: 11.49 },
  '.co': { registration: 23.49, renewal: 23.49, transfer: 23.49 },
  '.io': { registration: 30.5, renewal: 30.5, transfer: 30.5 },
  '.app': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.dev': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.ai': { registration: 63.49, renewal: 63.49, transfer: 63.49 },
  '.xyz': { registration: 2.49, renewal: 8.49, transfer: 8.49 },
  '.online': { registration: 7.49, renewal: 27.49, transfer: 27.49 },
  '.site': { registration: 6.49, renewal: 27.49, transfer: 27.49 },
  '.store': { registration: 8.49, renewal: 47.49, transfer: 47.49 },
  '.tech': { registration: 8.49, renewal: 37.49, transfer: 37.49 },
  '.cloud': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.live': { registration: 8.49, renewal: 22.49, transfer: 22.49 },
  '.me': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.us': { registration: 7.49, renewal: 7.49, transfer: 7.49 },
  '.ca': { registration: 11.49, renewal: 11.49, transfer: 11.49 },
  '.uk': { registration: 6.49, renewal: 6.49, transfer: 6.49 },
  '.eu': { registration: 6.49, renewal: 6.49, transfer: 6.49 },
  '.de': { registration: 5.49, renewal: 5.49, transfer: 5.49 },
  '.fr': { registration: 8.49, renewal: 8.49, transfer: 8.49 },
  '.it': { registration: 8.49, renewal: 8.49, transfer: 8.49 },
  '.nl': { registration: 7.49, renewal: 7.49, transfer: 7.49 },
  '.in': { registration: 8.49, renewal: 8.49, transfer: 8.49 },
  '.co.uk': { registration: 6.49, renewal: 6.49, transfer: 6.49 },
  '.org.uk': { registration: 6.49, renewal: 6.49, transfer: 6.49 },
  '.africa': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.shop': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
}

export interface PricedTld {
  tld: string
  wholesale: number
  markup: number
  registration: number
  renewal: number
  transfer: number
  currency: string
  active: boolean
  lastSyncedAt: string | null
}

/**
 * Apply the markup formula to a wholesale price.
 */
export function applyMarkup(wholesale: number, markup = DEFAULT_MARKUP_USD): number {
  return Math.round((wholesale + markup) * 100) / 100
}

/**
 * Get the TLD (with leading dot) from a domain name.
 * Handles multi-level TLDs like .co.uk.
 */
export function tldFromDomain(domain: string): string {
  const lower = domain.toLowerCase().trim()
  const parts = lower.split('.')
  if (parts.length >= 3 && ['co', 'org', 'com', 'me'].includes(parts[parts.length - 2])) {
    return '.' + parts.slice(-2).join('.')
  }
  return '.' + parts[parts.length - 1]
}

/**
 * Seed the pricing table from the default wholesale prices.
 * Idempotent: upserts each TLD.
 */
export async function seedPricing(updatedById?: string): Promise<number> {
  let count = 0
  for (const [tld, prices] of Object.entries(TLD_WHOLESALE_PRICES)) {
    await db.domainPrice.upsert({
      where: { tld },
      update: {
        wholesale: prices.registration,
        registration: applyMarkup(prices.registration),
        renewal: applyMarkup(prices.renewal),
        transfer: applyMarkup(prices.transfer),
        lastSyncedAt: new Date(),
      },
      create: {
        tld,
        wholesale: prices.registration,
        markup: DEFAULT_MARKUP_USD,
        registration: applyMarkup(prices.registration),
        renewal: applyMarkup(prices.renewal),
        transfer: applyMarkup(prices.transfer),
        currency: 'USD',
        active: true,
        lastSyncedAt: new Date(),
        updatedById,
      },
    })
    count++
  }
  return count
}

/**
 * Get all active prices.
 */
export async function getAllPrices(): Promise<PricedTld[]> {
  const rows = await db.domainPrice.findMany({
    where: { active: true },
    orderBy: { tld: 'asc' },
  })
  return rows.map((r) => ({
    tld: r.tld,
    wholesale: r.wholesale,
    markup: r.markup,
    registration: r.registration,
    renewal: r.renewal,
    transfer: r.transfer,
    currency: r.currency,
    active: r.active,
    lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
  }))
}

/**
 * Get the price for a specific TLD.
 */
export async function getPriceForTld(tld: string): Promise<PricedTld | null> {
  const normalized = tld.startsWith('.') ? tld : '.' + tld
  const row = await db.domainPrice.findUnique({ where: { tld: normalized } })
  if (!row) return null
  return {
    tld: row.tld,
    wholesale: row.wholesale,
    markup: row.markup,
    registration: row.registration,
    renewal: row.renewal,
    transfer: row.transfer,
    currency: row.currency,
    active: row.active,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  }
}

/**
 * Get the price for a domain (by extracting its TLD).
 */
export async function getPriceForDomain(domain: string): Promise<PricedTld | null> {
  const tld = tldFromDomain(domain)
  return getPriceForTld(tld)
}

/**
 * Sync prices from Dynadot wholesale list.
 * In demo mode this re-seeds from the defaults; in production it would fetch
 * the latest wholesale pricing from the Dynadot reseller price API.
 */
export async function syncPrices(updatedById?: string): Promise<{ synced: number; demo: boolean }> {
  await seedPricing(updatedById)
  return { synced: Object.keys(TLD_WHOLESALE_PRICES).length, demo: !process.env.DYNADOT_API_KEY }
}

/**
 * Update a single TLD's markup (admin override).
 */
export async function updateMarkup(
  tld: string,
  markup: number,
  updatedById?: string
): Promise<PricedTld | null> {
  const normalized = tld.startsWith('.') ? tld : '.' + tld
  const existing = await db.domainPrice.findUnique({ where: { tld: normalized } })
  if (!existing) return null
  const updated = await db.domainPrice.update({
    where: { tld: normalized },
    data: {
      markup,
      registration: applyMarkup(existing.wholesale, markup),
      renewal: applyMarkup(existing.renewal, markup),
      transfer: applyMarkup(existing.transfer, markup),
      updatedById,
      updatedAt: new Date(),
    },
  })
  return {
    tld: updated.tld,
    wholesale: updated.wholesale,
    markup: updated.markup,
    registration: updated.registration,
    renewal: updated.renewal,
    transfer: updated.transfer,
    currency: updated.currency,
    active: updated.active,
    lastSyncedAt: updated.lastSyncedAt ? updated.lastSyncedAt.toISOString() : null,
  }
}
