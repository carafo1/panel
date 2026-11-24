/**
 * Pricing service for the domain reseller module.
 *
 * Selling Price = Wholesale Price + Global Markup (USD)
 *
 * The global markup is stored in the AppSetting table under the key
 * `domain.markupUsd` and can be changed at runtime by an admin via the
 * /api/pricing/markup endpoint (or the Pricing tab in the dashboard).
 * DEFAULT_MARKUP_USD is only used as the initial/fallback value.
 *
 * Maintains a pricing table for every supported TLD with:
 *  - Wholesale price
 *  - Markup amount (per-TLD, kept in sync with the global markup)
 *  - Final selling price (registration / renewal / transfer)
 *  - Currency
 *  - Future price synchronization (via Dynadot API)
 */
import { db } from './db'
import { TLD_CATALOG, CATALOG_DEFAULT_WHOLESALE } from './tld-catalog'

// The default markup applied to every supported TLD (USD).
// This is only used when no global markup has been set in the AppSetting
// table yet, or as a safety fallback.
export const DEFAULT_MARKUP_USD = 6.5

// The AppSetting key used to store the global domain markup.
export const MARKUP_SETTING_KEY = 'domain.markupUsd'

/**
 * Get the current global markup (USD) from the AppSetting table.
 * Falls back to DEFAULT_MARKUP_USD if not set or invalid.
 */
export async function getGlobalMarkup(): Promise<number> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: MARKUP_SETTING_KEY } })
    if (!row) return DEFAULT_MARKUP_USD
    const parsed = parseFloat(row.value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MARKUP_USD
  } catch {
    return DEFAULT_MARKUP_USD
  }
}

/**
 * Set the global markup (USD) in the AppSetting table AND recalculate
 * every DomainPrice row's selling prices using the new markup.
 *
 * Returns the new markup value and the number of TLD rows updated.
 */
export async function setGlobalMarkup(
  markup: number,
  updatedById?: string
): Promise<{ markup: number; updated: number }> {
  // Validate: must be a non-negative finite number, rounded to 2 decimals.
  if (!Number.isFinite(markup) || markup < 0) {
    throw new Error('Markup must be a non-negative number')
  }
  const rounded = Math.round(markup * 100) / 100

  // 1. Persist the global setting.
  await db.appSetting.upsert({
    where: { key: MARKUP_SETTING_KEY },
    update: {
      value: String(rounded),
      ...(updatedById ? { updatedBy: updatedById } : {}),
    },
    create: {
      key: MARKUP_SETTING_KEY,
      value: String(rounded),
      ...(updatedById ? { updatedBy: updatedById } : {}),
    },
  })

  // 2. Recalculate every DomainPrice row using the new markup.
  const allRows = await db.domainPrice.findMany()
  let updated = 0
  for (const row of allRows) {
    await db.domainPrice.update({
      where: { id: row.id },
      data: {
        markup: rounded,
        registration: applyMarkup(row.wholesale, rounded),
        renewal: applyMarkup(row.renewal - row.markup, rounded), // wholesale renewal = selling - old markup
        transfer: applyMarkup(row.transfer - row.markup, rounded), // wholesale transfer = selling - old markup
        ...(updatedById ? { updatedById } : {}),
        updatedAt: new Date(),
      },
    })
    updated++
  }

  return { markup: rounded, updated }
}

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

/**
 * Full candidate TLD set = curated (TLD_WHOLESALE_PRICES, precise prices) ∪ the
 * broad TLD_CATALOG (default fallback price). Deduped + normalized. Curated
 * prices win; `curated` marks a hand-verified TLD (stays active even if a live
 * sync can't fetch its price). Catalog-only TLDs are only activated once a live
 * Dynadot sync confirms the registrar actually sells them.
 */
export function buildCandidateTlds(): Array<{
  tld: string
  prices: WholesalePrice
  curated: boolean
}> {
  const map = new Map<
    string,
    { tld: string; prices: WholesalePrice; curated: boolean }
  >()
  for (const raw of TLD_CATALOG) {
    const tld = raw.toLowerCase().trim()
    if (!tld.startsWith('.') || tld.length < 2) continue
    if (!map.has(tld)) {
      map.set(tld, {
        tld,
        prices: {
          registration: CATALOG_DEFAULT_WHOLESALE,
          renewal: CATALOG_DEFAULT_WHOLESALE,
          transfer: CATALOG_DEFAULT_WHOLESALE,
        },
        curated: false,
      })
    }
  }
  for (const [tld, prices] of Object.entries(TLD_WHOLESALE_PRICES)) {
    map.set(tld, { tld, prices, curated: true })
  }
  return [...map.values()]
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
 * Idempotent: upserts each TLD. Uses the current global markup.
 */
export async function seedPricing(updatedById?: string): Promise<number> {
  const markup = await getGlobalMarkup()
  let count = 0
  for (const { tld, prices, curated } of buildCandidateTlds()) {
    await db.domainPrice.upsert({
      where: { tld },
      update: {
        wholesale: prices.registration,
        markup,
        registration: applyMarkup(prices.registration, markup),
        renewal: applyMarkup(prices.renewal, markup),
        transfer: applyMarkup(prices.transfer, markup),
        lastSyncedAt: new Date(),
      },
      create: {
        tld,
        wholesale: prices.registration,
        markup,
        registration: applyMarkup(prices.registration, markup),
        renewal: applyMarkup(prices.renewal, markup),
        transfer: applyMarkup(prices.transfer, markup),
        currency: 'USD',
        // Curated TLDs are active immediately; catalog-only TLDs stay inactive
        // until a live Dynadot sync confirms the registrar sells them.
        active: curated,
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
  // Recomputed from wholesale rather than returned from the stored columns.
  // Those are written by the registrar sync from the single global markup, so
  // reading them would ignore the admin's per-action settings and then quietly
  // overwrite them on the next sync.
  const s = await getDomainPricingSettings()
  return rows.map((r) => {
    const p = sellingPrices(r.wholesale, s)
    return {
      tld: r.tld,
      wholesale: r.wholesale,
      markup: s.registerMarkup,
      registration: p.registration,
      renewal: p.renewal,
      transfer: p.transfer,
      currency: r.currency,
      active: r.active,
      lastSyncedAt: r.lastSyncedAt ? r.lastSyncedAt.toISOString() : null,
    }
  })
}

/**
 * Get the price for a specific TLD.
 */
export async function getPriceForTld(tld: string): Promise<PricedTld | null> {
  const normalized = tld.startsWith('.') ? tld : '.' + tld
  const row = await db.domainPrice.findUnique({ where: { tld: normalized } })
  // No price row = we do not sell this TLD. This used to invent a price from
  // a default wholesale guess (CATALOG_DEFAULT_WHOLESALE) and mark it active,
  // so any extension was sellable at a made-up price the registrar might
  // charge far more for. Search and checkout both read this, so null here
  // keeps them consistent: no row, no price, not sellable.
  if (!row) return null
  const s = await getDomainPricingSettings()
  const p = sellingPrices(row.wholesale, s)
  return {
    tld: row.tld,
    wholesale: row.wholesale,
    markup: s.registerMarkup,
    registration: p.registration,
    renewal: p.renewal,
    transfer: p.transfer,
    currency: row.currency,
    active: row.active,
    lastSyncedAt: row.lastSyncedAt ? row.lastSyncedAt.toISOString() : null,
  }
}

/**
 * Get the price for a domain (by extracting its TLD).
 */
export async function getPriceForDomain(domain: string): Promise<PricedTld | null> {
  return getSellablePriceForDomain(domain)
}

/**
 * The SELLING price for a domain, or null when it is not for sale here: no
 * price row, an inactive TLD, or a non-positive registration price. Every
 * customer-facing quote (search, checkout, billing) goes through this.
 */
export async function getSellablePriceForDomain(domain: string): Promise<PricedTld | null> {
  const row = await getPriceForTld(tldFromDomain(domain))
  if (!row || !row.active) return null
  if (!(row.registration > 0)) return null
  return row
}

/** Customer-safe view of a price: never includes wholesale or markup. */
export function publicPrice(row: PricedTld | null): {
  registration: number
  renewal: number
  transfer: number
  currency: string
} | null {
  if (!row) return null
  return {
    registration: row.registration,
    renewal: row.renewal,
    transfer: row.transfer,
    currency: row.currency,
  }
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
 *   (The actual markup used is the current global markup from AppSetting,
 *   which defaults to $6.50 but can be changed by an admin.)
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
): Promise<{ synced: number; demo: boolean; fetched: number; fallback: number; active: number }> {
  const candidates = buildCandidateTlds()

  // DEMO MODE — just re-seed (curated active, catalog inactive).
  if (!process.env.DYNADOT_API_KEY) {
    const n = await seedPricing(updatedById)
    return {
      synced: n,
      demo: true,
      fetched: 0,
      fallback: n,
      active: candidates.filter((c) => c.curated).length,
    }
  }

  // REAL MODE — fetch live wholesale prices from Dynadot for the whole catalog.
  const markup = await getGlobalMarkup()
  const allTlds = candidates.map((c) => c.tld)
  const sampleBase = 'deployhubpricecheck99999' // guaranteed-available sample domain
  const CHUNK_SIZE = 10 // Dynadot bulk search limit per request

  const livePrices = new Map<
    string,
    { registration: number; renewal: number; transfer: number }
  >()

  const { dynadotService } = await import('./dynadot-service')

  // Process TLDs in chunks of 10 to respect Dynadot's bulk search limit.
  for (let i = 0; i < allTlds.length; i += CHUNK_SIZE) {
    const chunk = allTlds.slice(i, i + CHUNK_SIZE)
    const domains = chunk.map((tld) => `${sampleBase}${tld}`)
    try {
      const results = await dynadotService.bulkSearch(domains)
      for (const r of results) {
        if (
          r.available &&
          typeof r.registrationPrice === 'number' &&
          r.registrationPrice > 0
        ) {
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
    // Gentle pacing so a 600-TLD catalog doesn't trip registrar rate limits.
    await new Promise((res) => setTimeout(res, 250))
  }

  // Upsert every candidate. A TLD is active (sellable) only if the registrar
  // returned a real price OR it's a curated hand-verified TLD — so the client
  // never sees a TLD Dynadot can't actually register.
  let fetched = 0
  let fallback = 0
  let synced = 0
  let active = 0
  for (const { tld, prices, curated } of candidates) {
    const live = livePrices.get(tld)
    const wholesale = live?.registration ?? prices.registration
    const renewalWholesale = live?.renewal ?? prices.renewal
    const transferWholesale = live?.transfer ?? prices.transfer
    const isActive = !!live || curated
    if (live) fetched++
    else fallback++
    if (isActive) active++

    await db.domainPrice.upsert({
      where: { tld },
      update: {
        wholesale,
        markup,
        registration: applyMarkup(wholesale, markup),
        renewal: applyMarkup(renewalWholesale, markup),
        transfer: applyMarkup(transferWholesale, markup),
        active: isActive,
        lastSyncedAt: new Date(),
        ...(updatedById ? { updatedById } : {}),
      },
      create: {
        tld,
        wholesale,
        markup,
        registration: applyMarkup(wholesale, markup),
        renewal: applyMarkup(renewalWholesale, markup),
        transfer: applyMarkup(transferWholesale, markup),
        currency: 'USD',
        active: isActive,
        lastSyncedAt: new Date(),
        ...(updatedById ? { updatedById } : {}),
      },
    })
    synced++
  }

  return { synced, demo: false, fetched, fallback, active }
}

/**
 * Update a single TLD's markup (admin per-TLD override).
 * Recalculates selling prices from the stored wholesale price + new markup.
 */
export async function updateMarkup(
  tld: string,
  markup: number,
  updatedById?: string
): Promise<PricedTld | null> {
  const normalized = tld.startsWith('.') ? tld : '.' + tld
  const existing = await db.domainPrice.findUnique({ where: { tld: normalized } })
  if (!existing) return null
  // Recover wholesale renewal/transfer from stored selling prices.
  const renewalWholesale = existing.renewal - existing.markup
  const transferWholesale = existing.transfer - existing.markup
  const updated = await db.domainPrice.update({
    where: { tld: normalized },
    data: {
      markup,
      registration: applyMarkup(existing.wholesale, markup),
      renewal: applyMarkup(renewalWholesale, markup),
      transfer: applyMarkup(transferWholesale, markup),
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


// ─── Per-action markup + discount ────────────────────────────────────────────

/** AppSetting keys. Per-action markups fall back to MARKUP_SETTING_KEY. */
export const MARKUP_REGISTER_KEY = 'domain.markup.register'
export const MARKUP_RENEW_KEY = 'domain.markup.renew'
export const MARKUP_TRANSFER_KEY = 'domain.markup.transfer'
export const DISCOUNT_PERCENT_KEY = 'domain.discountPercent'
export const DISCOUNT_REGISTER_KEY = 'domain.discount.register'
export const DISCOUNT_RENEW_KEY = 'domain.discount.renew'
export const DISCOUNT_TRANSFER_KEY = 'domain.discount.transfer'

export interface DomainPricingSettings {
  /** USD added to wholesale, per action. */
  registerMarkup: number
  renewMarkup: number
  transferMarkup: number
  /** The "all actions" percentage off. 0-90. Used where no per-action value is set. */
  discountPercent: number
  /** Per-action percentages. Each falls back to discountPercent. */
  registerDiscount: number
  renewDiscount: number
  transferDiscount: number
  /** The legacy single markup, still the fallback for any unset action. */
  globalMarkup: number
}

async function readNumber(key: string): Promise<number | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key } })
    if (!row) return null
    const n = parseFloat(row.value)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

/**
 * Current pricing settings.
 *
 * An unset per-action markup falls back to the global one, so an install that
 * has never touched these prices exactly as it did before.
 */
export async function getDomainPricingSettings(): Promise<DomainPricingSettings> {
  const globalMarkup = await getGlobalMarkup()
  const [reg, ren, xfer, disc, dReg, dRen, dXfer] = await Promise.all([
    readNumber(MARKUP_REGISTER_KEY),
    readNumber(MARKUP_RENEW_KEY),
    readNumber(MARKUP_TRANSFER_KEY),
    readNumber(DISCOUNT_PERCENT_KEY),
    readNumber(DISCOUNT_REGISTER_KEY),
    readNumber(DISCOUNT_RENEW_KEY),
    readNumber(DISCOUNT_TRANSFER_KEY),
  ])

  // Capped at 90% throughout: a 100% discount gives domains away at a loss,
  // because the registrar still charges wholesale either way.
  // >= 0, not > 0: a stored 0 is a deliberate "no discount on this action",
  // not an absent value. Only a key that was never written inherits.
  const cap = (v: number | null, fallback: number): number =>
    v !== null && v >= 0 ? Math.min(Math.max(v, 0), 90) : fallback
  const all = disc !== null && disc > 0 ? Math.min(disc, 90) : 0

  return {
    registerMarkup: reg !== null && reg >= 0 ? reg : globalMarkup,
    renewMarkup: ren !== null && ren >= 0 ? ren : globalMarkup,
    transferMarkup: xfer !== null && xfer >= 0 ? xfer : globalMarkup,
    discountPercent: all,
    // A per-action discount overrides the "all actions" one. Same shape as the
    // markups above, so both halves of the form behave the same way.
    registerDiscount: cap(dReg, all),
    renewDiscount: cap(dRen, all),
    transferDiscount: cap(dXfer, all),
    globalMarkup,
  }
}

export interface PricingUpdate {
  registerMarkup?: number
  renewMarkup?: number
  transferMarkup?: number
  discountPercent?: number
  registerDiscount?: number
  renewDiscount?: number
  transferDiscount?: number
}

/**
 * Write the settings an admin changed. Only the keys supplied are touched.
 *
 * Rejects a markup below zero and a discount outside 0-90: either would sell
 * domains for less than they cost, and the registrar still has to be paid.
 */
export async function setDomainPricingSettings(
  update: PricingUpdate,
  updatedBy?: string
): Promise<{ ok: boolean; error?: string; settings?: DomainPricingSettings }> {
  const pairs: Array<[string, number]> = []

  for (const [field, key] of [
    ['registerMarkup', MARKUP_REGISTER_KEY],
    ['renewMarkup', MARKUP_RENEW_KEY],
    ['transferMarkup', MARKUP_TRANSFER_KEY],
  ] as const) {
    const v = update[field]
    if (v === undefined) continue
    if (!Number.isFinite(v) || v < 0) {
      return { ok: false, error: `${field} must be zero or more.` }
    }
    if (v > 1000) {
      return { ok: false, error: `${field} of $${v} looks like a mistake.` }
    }
    pairs.push([key, v])
  }

  for (const [field, key, label] of [
    ['discountPercent', DISCOUNT_PERCENT_KEY, 'Discount'],
    ['registerDiscount', DISCOUNT_REGISTER_KEY, 'Registration discount'],
    ['renewDiscount', DISCOUNT_RENEW_KEY, 'Renewal discount'],
    ['transferDiscount', DISCOUNT_TRANSFER_KEY, 'Transfer discount'],
  ] as const) {
    const d = update[field]
    if (d === undefined) continue
    if (!Number.isFinite(d) || d < 0 || d > 90) {
      return { ok: false, error: `${label} must be between 0 and 90 percent.` }
    }
    pairs.push([key, d])
  }

  for (const [key, value] of pairs) {
    await db.appSetting.upsert({
      where: { key },
      create: { key, value: String(value), updatedBy: updatedBy ?? null },
      update: { value: String(value), updatedBy: updatedBy ?? null },
    })
  }

  return { ok: true, settings: await getDomainPricingSettings() }
}

/** Round to cents, never below zero. */
function money(n: number): number {
  return Math.max(0, Math.round(n * 100) / 100)
}

/**
 * Selling prices for one wholesale cost.
 *
 * Discount is applied AFTER the markup, so "20% off" is 20% off the price the
 * customer sees rather than 20% off the margin — which is what a customer
 * reading the banner will expect.
 */
export function sellingPrices(
  wholesale: number,
  s: DomainPricingSettings
): { registration: number; renewal: number; transfer: number } {
  const off = (pct: number) => 1 - pct / 100
  return {
    registration: money((wholesale + s.registerMarkup) * off(s.registerDiscount)),
    renewal: money((wholesale + s.renewMarkup) * off(s.renewDiscount)),
    transfer: money((wholesale + s.transferMarkup) * off(s.transferDiscount)),
  }
}
