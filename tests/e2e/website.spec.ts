/**
 * The website page: every management area (tab) loads without errors, the WordPress lists are filled,
 * the domain is listed once, and the file manager uploads.
 */
import type { Page } from '@playwright/test'
import { test, expect, sidebar, type Health } from './support'
import { SITE } from './fixtures'

/**
 * The e2e panel has no mail server (MAILCOW_* blank), so the mail endpoints
 * answer 503 "Email hosting is not configured" — the honest API answer.
 * How the PAGE shows that is still checked: no error toast is allowed in the
 * all-sections test below.
 */
function allowNoMailServer(health: Health) {
  health.allow(
    /^http: 503 GET \/api\/hosting\/[^/]+\/email\//,
    'no mail server in the e2e environment; the API reports 503 honestly'
  )
}

/** For tests about one other section: the email section's toast is covered by the all-sections test. */
function allowMailToast(health: Health) {
  health.allow(/^toast: Email hosting is not configured/, 'asserted by the all-sections test, not this one')
}

/**
 * Every management area (tab) and, inside it, the section ids it renders
 * (src/components/hosting/site/site-view.tsx). Advanced tools are tabs of
 * their own inside the Advanced area.
 */
const AREAS: Array<{ tab: string; sections: string[]; advanced?: string[] }> = [
  { tab: 'Overview', sections: [] },
  { tab: 'WordPress', sections: ['wordpress'] },
  { tab: 'Files', sections: ['files', 'sftp'] },
  { tab: 'Domains & SSL', sections: ['domains', 'ssl', 'redirects', 'cdn'] },
  { tab: 'Email', sections: ['email'] },
  { tab: 'Databases', sections: ['databases'] },
  { tab: 'Backups', sections: ['backups', 'staging', 'import'] },
  {
    tab: 'Advanced',
    sections: [],
    advanced: ['Deployments', 'Environment', 'Container & logs', 'Terminal', 'Cron jobs', 'Resource usage', 'IP blocker', 'Settings'],
  },
]

async function openWebsite(page: Page, hash = '') {
  await page.goto('/' + hash)
  await sidebar(page).getByRole('navigation').getByRole('button', { name: 'Hosting', exact: true }).click()
  await page.getByText(SITE.name).click()
  await expect(page.getByRole('heading', { name: SITE.name })).toBeVisible()
  await page.waitForLoadState('networkidle')
}

const siteTabs = (page: Page) => page.getByRole('tablist', { name: 'Website management' })

/** Open an area tab and wait until its sections have mounted and loaded. */
async function openArea(page: Page, tab: string) {
  await siteTabs(page).getByRole('tab', { name: tab, exact: true }).click()
  await expect(siteTabs(page).getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.waitForLoadState('networkidle')
  return page.getByRole('tabpanel', { name: tab, exact: true })
}

/** A (possibly lazily mounted) section inside the open area. */
async function reveal(page: Page, id: string) {
  const section = page.locator(`#${id}`)
  await section.scrollIntoViewIfNeeded()
  await expect(section).not.toHaveAttribute('aria-busy', 'true')
  await page.waitForLoadState('networkidle')
  return section
}

test.beforeEach(({ health }) => allowNoMailServer(health))

test('every management area on the website page loads without errors', async ({ page, health }) => {
  await openWebsite(page)
  health.expectClean('when the website page opened')

  for (const area of AREAS) {
    await test.step(area.tab, async () => {
      const panel = await openArea(page, area.tab)
      await expect(panel).not.toBeEmpty()
      for (const id of area.sections) {
        const section = await reveal(page, id)
        await expect(section).not.toBeEmpty()
      }
      for (const tool of area.advanced ?? []) {
        await panel.getByRole('tab', { name: tool }).click()
        await page.waitForLoadState('networkidle')
      }
      await expect(page.getByText('Something went wrong')).toHaveCount(0)
      health.expectClean(`after the ${area.tab} area loaded`)
    })
  }

  expect(health.errorToasts(), 'error toasts while opening the website areas').toEqual([])
})

test('old section links open the area that holds them', async ({ page, health }) => {
  allowMailToast(health)
  await openWebsite(page)
  await openArea(page, 'Files')
  await expect(page).toHaveURL(/#files$/)
  await page.evaluate(() => (window.location.hash = '#cron'))
  await expect(siteTabs(page).getByRole('tab', { name: 'Advanced', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator("#cron")).toBeVisible()
})

test('the WordPress section lists plugins and themes', async ({ page, health }) => {
  allowMailToast(health)
  await openWebsite(page)
  await openArea(page, 'WordPress')
  const wp = await reveal(page, 'wordpress')
  await expect(wp.getByText('Plugins (3)')).toBeVisible()
  await expect(wp.getByText('Akismet Anti-spam')).toBeVisible()
  await wp.getByText('Themes (2)').click()
  await expect(wp.getByText('Twenty Twenty-Four')).toBeVisible()
})

test('a domain stored as both primary and domain row is listed once', async ({ page, health }) => {
  allowMailToast(health)
  await openWebsite(page)
  await openArea(page, 'Domains & SSL')
  const domains = await reveal(page, 'domains')
  await expect(domains.getByRole('row').filter({ hasText: SITE.customDomain })).toHaveCount(1)
})

test('the file manager uploads a small file and one over 10 MB', async ({ page, health }) => {
  allowMailToast(health)
  await openWebsite(page)
  await openArea(page, 'Files')
  const files = await reveal(page, 'files')

  const upload = async (name: string, buffer: Buffer, mimeType: string) => {
    const chooser = page.waitForEvent('filechooser')
    await files.getByRole('button', { name: 'Upload', exact: true }).click()
    await (await chooser).setFiles({ name, mimeType, buffer })
    // The success toast (the file manager also announces it to screen readers).
    await expect(
      page.getByRole('region', { name: /Notifications/ }).getByText(`Uploaded ${name}`)
    ).toBeVisible({ timeout: 30_000 })
  }

  await upload('hello-e2e.txt', Buffer.from('hello from the e2e suite\n'), 'text/plain')
  // Uploads over 10 MB once died in the request proxy (silent 10 MB cap).
  await upload('big-e2e.bin', Buffer.alloc(11 * 1024 * 1024, 7), 'application/octet-stream')
})
