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
  // ── Generic / Popular ────────────────────────────────────────────────
  '.com': { registration: 8.49, renewal: 8.49, transfer: 8.49 },
  '.net': { registration: 10.49, renewal: 10.49, transfer: 10.49 },
  '.org': { registration: 9.49, renewal: 9.49, transfer: 9.49 },
  '.info': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.biz': { registration: 11.49, renewal: 11.49, transfer: 11.49 },
  '.co': { registration: 23.49, renewal: 23.49, transfer: 23.49 },
  '.io': { registration: 30.5, renewal: 30.5, transfer: 30.5 },
  '.me': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.us': { registration: 7.49, renewal: 7.49, transfer: 7.49 },
  '.mobi': { registration: 14.49, renewal: 14.49, transfer: 14.49 },
  '.tv': { registration: 28.49, renewal: 28.49, transfer: 28.49 },
  '.cc': { registration: 16.49, renewal: 16.49, transfer: 16.49 },
  '.ws': { registration: 24.49, renewal: 24.49, transfer: 24.49 },
  '.name': { registration: 9.49, renewal: 9.49, transfer: 9.49 },
  '.pro': { registration: 14.49, renewal: 14.49, transfer: 14.49 },

  // ── Tech / Developer ─────────────────────────────────────────────────
  '.app': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.dev': { registration: 13.49, renewal: 13.49, transfer: 13.49 },
  '.ai': { registration: 63.49, renewal: 63.49, transfer: 63.49 },
  '.cloud': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.tech': { registration: 8.49, renewal: 37.49, transfer: 37.49 },
  '.xyz': { registration: 2.49, renewal: 8.49, transfer: 8.49 },
  '.codes': { registration: 4.49, renewal: 39.49, transfer: 39.49 },
  '.host': { registration: 8.49, renewal: 47.49, transfer: 47.49 },
  '.server': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.website': { registration: 4.49, renewal: 17.49, transfer: 17.49 },
  '.systems': { registration: 12.49, renewal: 17.49, transfer: 17.49 },
  '.software': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.network': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.digital': { registration: 4.49, renewal: 27.49, transfer: 27.49 },
  '.page': { registration: 9.49, renewal: 9.49, transfer: 9.49 },
  '.tools': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.code': { registration: 8.49, renewal: 14.49, transfer: 14.49 },

  // ── Business / Commerce ──────────────────────────────────────────────
  '.store': { registration: 8.49, renewal: 47.49, transfer: 47.49 },
  '.shop': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.online': { registration: 7.49, renewal: 27.49, transfer: 27.49 },
  '.site': { registration: 6.49, renewal: 27.49, transfer: 27.49 },
  '.blog': { registration: 7.49, renewal: 24.49, transfer: 24.49 },
  '.business': { registration: 4.49, renewal: 14.49, transfer: 14.49 },
  '.company': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.enterprise': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.ventures': { registration: 8.49, renewal: 47.49, transfer: 47.49 },
  '.finance': { registration: 8.49, renewal: 47.49, transfer: 47.49 },
  '.financial': { registration: 8.49, renewal: 47.49, transfer: 47.49 },
  '.bank': { registration: 549.49, renewal: 549.49, transfer: 549.49 },
  '.inc': { registration: 199.49, renewal: 199.49, transfer: 199.49 },
  '.corp': { registration: 49.49, renewal: 49.49, transfer: 49.49 },
  '.ltd': { registration: 8.49, renewal: 22.49, transfer: 22.49 },
  '.group': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.agency': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.services': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.solutions': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.support': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.consulting': { registration: 8.49, renewal: 27.49, transfer: 27.49 },

  // ── Lifestyle / Entertainment ────────────────────────────────────────
  '.live': { registration: 8.49, renewal: 22.49, transfer: 22.49 },
  '.life': { registration: 8.49, renewal: 24.49, transfer: 24.49 },
  '.fun': { registration: 4.49, renewal: 17.49, transfer: 17.49 },
  '.games': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.game': { registration: 199.49, renewal: 199.49, transfer: 199.49 },
  '.play': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.music': { registration: 199.49, renewal: 199.49, transfer: 199.49 },
  '.art': { registration: 8.49, renewal: 8.49, transfer: 8.49 },
  '.design': { registration: 24.49, renewal: 32.49, transfer: 32.49 },
  '.studio': { registration: 8.49, renewal: 24.49, transfer: 24.49 },
  '.media': { registration: 8.49, renewal: 32.49, transfer: 32.49 },
  '.news': { registration: 8.49, renewal: 22.49, transfer: 22.49 },
  '.show': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.world': { registration: 8.49, renewal: 22.49, transfer: 22.49 },
  '.today': { registration: 8.49, renewal: 22.49, transfer: 22.49 },
  '.now': { registration: 8.49, renewal: 22.49, transfer: 22.49 },
  '.zone': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.club': { registration: 8.49, renewal: 9.49, transfer: 9.49 },
  '.buzz': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.cool': { registration: 8.49, renewal: 17.49, transfer: 17.49 },

  // ── Geography / ccTLD ────────────────────────────────────────────────
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
  '.so': { registration: 49.49, renewal: 49.49, transfer: 49.49 },
  '.asia': { registration: 11.49, renewal: 11.49, transfer: 11.49 },
  '.nz': { registration: 24.49, renewal: 24.49, transfer: 24.49 },
  '.au': { registration: 49.49, renewal: 49.49, transfer: 49.49 },
  '.ie': { registration: 14.49, renewal: 14.49, transfer: 14.49 },
  '.es': { registration: 5.49, renewal: 5.49, transfer: 5.49 },
  '.pt': { registration: 8.49, renewal: 8.49, transfer: 8.49 },
  '.ch': { registration: 6.49, renewal: 6.49, transfer: 6.49 },
  '.pl': { registration: 9.49, renewal: 9.49, transfer: 9.49 },
  '.be': { registration: 5.49, renewal: 5.49, transfer: 5.49 },
  '.se': { registration: 14.49, renewal: 14.49, transfer: 14.49 },
  '.at': { registration: 7.49, renewal: 7.49, transfer: 7.49 },

  // ── Community / Social ───────────────────────────────────────────────
  '.social': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.community': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.friends': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.fan': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.fans': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.team': { registration: 8.49, renewal: 22.49, transfer: 22.49 },
  '.guru': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.expert': { registration: 8.49, renewal: 47.49, transfer: 47.49 },
  '.academy': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.education': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.school': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
  '.university': { registration: 8.49, renewal: 32.49, transfer: 32.49 },
  '.institute': { registration: 8.49, renewal: 17.49, transfer: 17.49 },
  '.training': { registration: 8.49, renewal: 27.49, transfer: 27.49 },
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
 *
 * REAL MODE (DYNADOT_API_KEY set):
 *   Performs bulk searches (in chunks of 10 — Dynadot's bulk limit) for a
 *   guaranteed-available sample domain across every TLD in
 *   TLD_WHOLESALE_PRICES. Dynadot returns the real Registration + Renewal
 *   prices via `show_price=1`, which we store as the wholesale price. The
 *   $6.50 markup is then applied to compute the selling price. TLDs whose
 *   price can't be fetched fall back to their default wholesale price.
 *
 * DEMO MODE (no API key):
 *   Re-seeds from the TLD_WHOLESALE_PRICES defaults.
 *
 * Returns: { synced, demo, fetched, fallback }
 *   - synced:    total TLDs upserted
 *   - demo:      true if running in demo mode
 *   - fetched:   number of TLDs whose price was fetched live from Dynadot
 *   - fallback:  number of TLDs that fell back to defaults
 */
export async function syncPrices(
  updatedById?: string
): Promise<{ synced: number; demo: boolean; fetched: number; fallback: number }> {
  // DEMO MODE — just re-seed the defaults.
  if (!process.env.DYNADOT_API_KEY) {
    await seedPricing(updatedById)
    return {
      synced: Object.keys(TLD_WHOLESALE_PRICES).length,
      demo: true,
      fetched: 0,
      fallback: Object.keys(TLD_WHOLESALE_PRICES).length,
    }
  }

  // REAL MODE — fetch live wholesale prices from Dynadot.
  const allTlds = Object.keys(TLD_WHOLESALE_PRICES)
  const sampleBase = 'deployhubpricecheck99999' // guaranteed-available sample domain
  const CHUNK_SIZE = 10 // Dynadot bulk search limit per request

  const livePrices = new Map<
    string,
    { registration: number; renewal: number; transfer: number }
  >()

  // Process TLDs in chunks of 10 to respect Dynadot's bulk search limit.
  for (let i = 0; i < allTlds.length; i += CHUNK_SIZE) {
    const chunk = allTlds.slice(i, i + CHUNK_SIZE)
    const domains = chunk.map((tld) => `${sampleBase}${tld}`)
    try {
      // Dynamic import to avoid a circular dependency at module load time
      // (dynadot-service imports from pricing for tldFromDomain in some paths).
      const { dynadotService } = await import('./dynadot-service')
      const results = await dynadotService.bulkSearch(domains)
      for (const r of results) {
        if (r.available && typeof r.registrationPrice === 'number') {
          const tld = tldFromDomain(r.domain)
          livePrices.set(tld, {
            registration: r.registrationPrice,
            renewal: r.renewalPrice ?? r.registrationPrice,
            transfer: r.transferPrice ?? r.renewalPrice ?? r.registrationPrice,
          })
        }
      }
    } catch (err) {
      console.error(
        `[pricing/sync] Failed to fetch chunk starting at ${i}:`,
        err instanceof Error ? err.message : err
      )
      // Continue to next chunk — partial sync is better than no sync.
    }
  }

  // Upsert every TLD: use live price when available, fall back to defaults.
  let fetched = 0
  let fallback = 0
  let synced = 0
  for (const [tld, defaults] of Object.entries(TLD_WHOLESALE_PRICES)) {
    const live = livePrices.get(tld)
    const wholesale = live?.registration ?? defaults.registration
    const renewalWholesale = live?.renewal ?? defaults.renewal
    const transferWholesale = live?.transfer ?? defaults.transfer
    if (live) fetched++
    else fallback++

    await db.domainPrice.upsert({
      where: { tld },
      update: {
        wholesale,
        registration: applyMarkup(wholesale),
        renewal: applyMarkup(renewalWholesale),
        transfer: applyMarkup(transferWholesale),
        lastSyncedAt: new Date(),
        ...(updatedById ? { updatedById } : {}),
      },
      create: {
        tld,
        wholesale,
        markup: DEFAULT_MARKUP_USD,
        registration: applyMarkup(wholesale),
        renewal: applyMarkup(renewalWholesale),
        transfer: applyMarkup(transferWholesale),
        currency: 'USD',
        active: true,
        lastSyncedAt: new Date(),
        ...(updatedById ? { updatedById } : {}),
      },
    })
    synced++
  }

  return { synced, demo: false, fetched, fallback }
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
