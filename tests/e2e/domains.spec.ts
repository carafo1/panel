/**
 * Domain search with no registrar configured (DYNADOT_API_KEY is blank).
 *
 * In a production build a missing registrar key is never simulated: the API
 * answers 503 "availability unknown" (src/app/api/domains/search/route.ts),
 * and the page must say it couldn't check — never "available" with a price,
 * never "taken". Nothing reaches the registrar.
 */
import type { Page } from '@playwright/test'
import { test, expect, sidebar } from './support'
import { SITE } from './fixtures'

async function openDomains(page: Page) {
  await page.goto('/')
  await sidebar(page).getByRole('navigation').getByRole('button', { name: 'Domains', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Search' })).toBeVisible()
}

async function search(page: Page, term: string) {
  const box = page.getByLabel('Domain name to search')
  await box.fill(term)
  await page.getByRole('button', { name: 'Search', exact: true }).click()
}

test('an invalid domain name is rejected with a clear message', async ({ page, health }) => {
  health.allow(/^http: 400 GET \/api\/domains\/search\?domain=/, 'invalid names are refused with 400')
  await openDomains(page)

  await search(page, 'not a domain!')

  const alert = page.getByRole('alert').filter({ hasText: 'Enter a valid domain name' })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('for example mybrand.com')
  await expect(page.getByRole('button', { name: /^Buy / })).toHaveCount(0)
})

test('without a registrar the search honestly says it could not check', async ({ page, health }) => {
  health.allow(/^http: 503 GET \/api\/domains\/search\?domain=/, 'registrar not configured → 503 availability unknown')
  await openDomains(page)

  const searched = page.waitForResponse((r) => r.url().includes('/api/domains/search?domain='))
  await search(page, 'erin-garden-new.com')
  const res = await searched
  expect(res.status()).toBe(503)
  expect(await res.json()).toMatchObject({ errors: [{ code: 'availability_unknown' }] })

  const alert = page.getByRole('alert').filter({ hasText: 'Couldn’t check availability' })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('We couldn’t confirm availability right now')
  await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible()
  // Never presented as buyable or as taken.
  await expect(page.getByRole('button', { name: /^Buy / })).toHaveCount(0)
  await expect(page.getByText(/^\$\d/)).toHaveCount(0)
  await expect(page.getByText('Taken', { exact: true })).toHaveCount(0)
})

test('the customer’s domain is listed once under My Domains', async ({ page }) => {
  await openDomains(page)
  await page.getByRole('tab', { name: 'My Domains' }).click()
  await expect(page.getByRole('button', { name: new RegExp(`^${SITE.customDomain.replace(/\./g, '\\.')},`) })).toHaveCount(1)
})
