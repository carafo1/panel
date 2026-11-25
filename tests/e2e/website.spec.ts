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

// ─── File manager: server-side actions (demo-mode file tree) ─────────────

/** The file manager, opened in the website folder (site/). */
async function openFiles(page: Page) {
  await openWebsite(page)
  await openArea(page, 'Files')
  const files = await reveal(page, 'files')
  await expect(files.getByRole('navigation', { name: 'Folder path' }).getByText('Website root')).toBeVisible()
  return files
}

type Section = Awaited<ReturnType<typeof reveal>>

const actions = (files: Section, name: string) => files.getByRole('button', { name: `Actions for ${name}`, exact: true })
// `has` is evaluated inside each row, so it must not start from #files again.
const row = (files: Section, name: string) =>
  files.getByRole('row').filter({ has: files.page().getByRole('button', { name: `Actions for ${name}`, exact: true }) })
const toast = (page: Page, text: string | RegExp) => page.getByRole('region', { name: /Notifications/ }).getByText(text)

async function openFolder(page: Page, files: Section, name: string) {
  await actions(files, name).click()
  await page.getByRole('menuitem', { name: 'Open', exact: true }).click()
  await expect(files.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name, exact: true })).toBeVisible()
}

test('the permissions dialog changes a mode and returns focus to the row menu', async ({ page, health }) => {
  allowMailToast(health)
  const files = await openFiles(page)
  const menu = actions(files, 'readme.html')

  await menu.click()
  await page.getByRole('menuitem', { name: 'Permissions…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Change permissions' })
  const mode = dialog.getByRole('textbox', { name: 'Mode' })
  await expect(mode).toHaveValue('644')

  // The checkbox grid and the octal field stay in sync.
  await dialog.getByRole('checkbox', { name: 'Group: write (mode)' }).check()
  await expect(mode).toHaveValue('664')
  // setuid is refused before anything is sent.
  await mode.fill('4755')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Setuid')
  await mode.fill('600')
  await dialog.getByRole('button', { name: 'Apply' }).click()

  await expect(toast(page, 'Permissions set to 600')).toBeVisible()
  await expect(dialog).toBeHidden()
  await expect(menu).toBeFocused()
  await expect(row(files, 'readme.html')).toContainText('rw-------')
})

test('compress a folder to .zip and extract it back into a new folder', async ({ page, health }) => {
  allowMailToast(health)
  const files = await openFiles(page)
  const stamp = Date.now().toString(36)
  const zip = `themes-${stamp}.zip`

  await openFolder(page, files, 'wp-content')
  await actions(files, 'themes').click()
  await page.getByRole('menuitem', { name: 'Compress to .zip…' }).click()
  const compress = page.getByRole('dialog', { name: 'Compress to .zip' })
  await expect(compress.getByLabel('Archive name')).toHaveValue('themes.zip')
  await compress.getByLabel('Archive name').fill(zip)
  await compress.getByRole('button', { name: 'Compress' }).click()
  await expect(toast(page, `Created ${zip}`)).toBeVisible()
  await expect(row(files, zip)).toBeVisible()

  await actions(files, zip).click()
  await page.getByRole('menuitem', { name: 'Extract…' }).click()
  const extract = page.getByRole('dialog', { name: `Extract ${zip}` })
  await extract.getByRole('checkbox', { name: 'Put the files in a new folder' }).check()
  await expect(extract.getByLabel('Folder name')).toHaveValue(`themes-${stamp}`)
  await extract.getByLabel('Folder name').fill(`restored-${stamp}`)
  await extract.getByRole('button', { name: 'Extract', exact: true }).click()
  await expect(toast(page, `Extracted 1 file into site/wp-content/restored-${stamp}/`)).toBeVisible()

  // The archive held themes/twentytwentyfour/style.css.
  await openFolder(page, files, `restored-${stamp}`)
  await openFolder(page, files, 'themes')
  await openFolder(page, files, 'twentytwentyfour')
  await expect(row(files, 'style.css')).toBeVisible()
})

test('copy a file with the folder picker, and preview an image', async ({ page, health }) => {
  allowMailToast(health)
  const files = await openFiles(page)

  await actions(files, 'license.txt').click()
  await page.getByRole('menuitem', { name: 'Copy to…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Copy license.txt' })
  await expect(dialog.getByRole('button', { name: 'Already in this folder' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'wp-admin', exact: true }).click()
  await expect(dialog.getByText('/site/wp-admin', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Copy here' }).click()
  await expect(toast(page, 'Copied 1 item to site/wp-admin/')).toBeVisible()
  await expect(dialog).toBeHidden()
  await openFolder(page, files, 'wp-admin')
  await expect(row(files, 'license.txt')).toBeVisible()

  await files.getByRole('navigation', { name: 'Folder path' }).getByRole('button', { name: 'site', exact: true }).click()
  for (const dir of ['wp-content', 'uploads', '2026', '11']) await openFolder(page, files, dir)
  await files.getByRole('button', { name: 'garden-logo.png', exact: true }).click()
  const preview = page.getByRole('dialog', { name: 'garden-logo.png' })
  const img = preview.getByRole('img', { name: 'Preview of garden-logo.png' })
  await expect(img).toBeVisible()
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
  const res = await page.request.get(`/api/hosting/${SITE.id}/files/site/wp-content/uploads/2026/11/garden-logo.png?action=preview`)
  expect(res.headers()['content-type']).toBe('image/png')
  expect(res.headers()['content-security-policy']).toContain('sandbox')
})

test('a deep link opens the website on its area, and a reload keeps it there', async ({ page, health }) => {
  allowMailToast(health)
  await page.goto(`/?tab=hosting&project=${SITE.id}#files`)
  await expect(page.getByRole('heading', { name: SITE.name })).toBeVisible()
  await expect(siteTabs(page).getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(new RegExp(`\\?tab=hosting&project=${SITE.id}#files$`))

  await openArea(page, 'Domains & SSL')
  await expect(page).toHaveURL(new RegExp(`project=${SITE.id}#domains$`))
  await page.reload()
  await expect(page.getByRole('heading', { name: SITE.name })).toBeVisible()
  await expect(siteTabs(page).getByRole('tab', { name: 'Domains & SSL', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveURL(new RegExp(`project=${SITE.id}#domains$`))

  // Closing the website takes it out of the address bar.
  await page.getByRole('button', { name: 'All websites' }).click()
  await expect(page.getByText(SITE.name).first()).toBeVisible()
  await expect(page).not.toHaveURL(/project=|#/)
})
