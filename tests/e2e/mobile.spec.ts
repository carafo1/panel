/**
 * Phone-width layout of the signed-in dashboard: the page is usable on
 * arrival, the bottom navigation works, and no page scrolls sideways.
 */
import type { Page } from '@playwright/test'
import { test, expect, sidebar } from './support'
import { SITE } from './fixtures'

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })

async function expectNoSidewaysScroll(page: Page, where: string) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }))
  expect(scroll, `horizontal scroll on ${where}`).toBeLessThanOrEqual(client)
}

/** Is the slide-in navigation drawer on screen? */
async function drawerIsOpen(page: Page) {
  const box = await sidebar(page).boundingBox()
  return !!box && box.x + box.width > 1
}

test('the navigation drawer is closed when a phone opens the dashboard', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: /Welcome back/ })).toBeVisible()
  expect(await drawerIsOpen(page), 'drawer covers the page on arrival').toBe(false)
})

test('bottom navigation reaches the main sections without sideways scrolling', async ({ page, health }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1, name: /Welcome back/ })).toBeVisible()
  // If the drawer is open on arrival (see the test above), close it the way
  // a customer would, so the rest of the phone layout is still covered.
  if (await drawerIsOpen(page)) {
    await sidebar(page).getByRole('button').first().tap()
    await expect.poll(() => drawerIsOpen(page)).toBe(false)
  }

  // The bottom bar is the last navigation landmark on the page.
  const bottomNav = page.getByRole('navigation').last()
  await expect(bottomNav.getByRole('button', { name: 'Home' })).toBeVisible()
  await expectNoSidewaysScroll(page, 'Overview')

  for (const [label, title] of [
    ['Hosting', 'Hosting'],
    ['Domains', 'Domains'],
    ['Settings', 'Settings'],
    ['AI', 'AI Assistant'],
  ] as const) {
    await bottomNav.getByRole('button', { name: label, exact: true }).tap()
    await expect(page.getByRole('main').getByRole('heading', { level: 2 }).first()).toHaveText(title)
    await page.waitForLoadState('networkidle')
    await expectNoSidewaysScroll(page, title)
    health.expectClean(`on ${title} at phone width`)
  }

  await bottomNav.getByRole('button', { name: 'Hosting', exact: true }).tap()
  await page.getByText(SITE.name).tap()
  await expect(page.getByRole('heading', { name: SITE.name })).toBeVisible()
  await page.waitForLoadState('networkidle')
  await expectNoSidewaysScroll(page, 'the website page')
})
