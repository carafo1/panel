/**
 * The website page: every management section (each mounts lazily as it
 * scrolls into view) loads without errors, the WordPress lists are filled,
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

/** Section ids in page order (src/components/hosting/hosting-panel.tsx). */
const SECTIONS = [
  'databases',
  'email',
  'wordpress',
  'backups',
  'staging',
  'import',
  'files',
  'terminal',
  'resources',
  'domains',
  'cdn',
  'cron',
  'sftp',
  'redirects',
  'security',
]

async function openWebsite(page: Page) {
  await page.goto('/')
  await sidebar(page).getByRole('navigation').getByRole('button', { name: 'Hosting', exact: true }).click()
  await page.getByText(SITE.name).click()
  await expect(page.getByRole('heading', { name: SITE.name })).toBeVisible()
  await page.waitForLoadState('networkidle')
}

/** Scroll a lazy section into view and wait until it has mounted and loaded. */
async function reveal(page: Page, id: string) {
  const section = page.locator(`section#${id}`)
  await section.scrollIntoViewIfNeeded()
  await expect(section).toHaveAttribute('aria-busy', 'false')
  await page.waitForLoadState('networkidle')
  return section
}

test.beforeEach(({ health }) => allowNoMailServer(health))

test('every management section on the website page loads without errors', async ({ page, health }) => {
  await openWebsite(page)
  health.expectClean('when the website page opened')

  for (const id of SECTIONS) {
    await test.step(`#${id}`, async () => {
      const section = await reveal(page, id)
      await expect(section).not.toBeEmpty()
      await expect(section.getByText('Something went wrong')).toHaveCount(0)
      health.expectClean(`after section #${id} loaded`)
    })
  }

  expect(health.errorToasts(), 'error toasts while scrolling the website page').toEqual([])
})

test('the WordPress section lists plugins and themes', async ({ page, health }) => {
  allowMailToast(health)
  await openWebsite(page)
  const wp = await reveal(page, 'wordpress')
  await expect(wp.getByText('Plugins (3)')).toBeVisible()
  await expect(wp.getByText('Akismet Anti-spam')).toBeVisible()
  await wp.getByText('Themes (2)').click()
  await expect(wp.getByText('Twenty Twenty-Four')).toBeVisible()
})

test('a domain stored as both primary and domain row is listed once', async ({ page, health }) => {
  allowMailToast(health)
  await openWebsite(page)
  const domains = await reveal(page, 'domains')
  await expect(domains.getByRole('row').filter({ hasText: SITE.customDomain })).toHaveCount(1)
})

test('the file manager uploads a small file and one over 10 MB', async ({ page, health }) => {
  allowMailToast(health)
  await openWebsite(page)
  const files = await reveal(page, 'files')

  const upload = async (name: string, buffer: Buffer, mimeType: string) => {
    const chooser = page.waitForEvent('filechooser')
    await files.getByRole('button', { name: 'Upload', exact: true }).click()
    await (await chooser).setFiles({ name, mimeType, buffer })
    await expect(page.getByText(`Uploaded ${name}`)).toBeVisible({ timeout: 30_000 })
  }

  await upload('hello-e2e.txt', Buffer.from('hello from the e2e suite\n'), 'text/plain')
  // Uploads over 10 MB once died in the request proxy (silent 10 MB cap).
  await upload('big-e2e.bin', Buffer.alloc(11 * 1024 * 1024, 7), 'application/octet-stream')
})
