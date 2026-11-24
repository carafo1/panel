/**
 * Every customer sidebar section opens without a crash, an uncaught browser
 * error, a failed API call or an error toast; and the customer only ever sees
 * their own data.
 */
import { test, expect, sidebar, sectionTitle } from './support'
import { OTHER_TENANT, SITE } from './fixtures'

/** Sidebar label → the title the top bar shows for it. */
const SECTIONS: Array<[label: string, title: string]> = [
  ['Overview', 'Dashboard'],
  ['Hosting', 'Hosting'],
  ['Email Hosting', 'Email Hosting'],
  ['Domains', 'Domains'],
  ['Deployments', 'Deployments'],
  ['GitHub', 'GitHub'],
  ['Pipelines', 'Pipelines'],
  ['Billing', 'Billing'],
  ['Webhooks', 'Webhooks'],
  ['Teams', 'Teams'],
  ['Analytics', 'Analytics'],
  ['Monitoring', 'Monitoring'],
  ['Support', 'Support'],
  ['Settings', 'Settings'],
  ['AI Assistant', 'AI Assistant'],
]

test('every sidebar section loads cleanly', async ({ page, health }) => {
  await page.goto('/')
  await expect(sidebar(page).getByText('Erin Example')).toBeVisible()

  // A customer sees exactly these sections — no operator-only ones.
  const nav = sidebar(page).getByRole('navigation')
  await expect(nav.getByRole('button')).toHaveText(SECTIONS.map(([label]) => label))

  for (const [label, title] of SECTIONS) {
    await test.step(label, async () => {
      await nav.getByRole('button', { name: label, exact: true }).click()
      await expect(sectionTitle(page)).toHaveText(title)
      await page.waitForLoadState('networkidle')
      await expect(page.getByText('Something went wrong'), `${label} crashed`).toHaveCount(0)
      health.expectClean(`in the ${label} section`)
    })
  }
})

test('the customer sees only their own websites', async ({ page }) => {
  await page.goto('/')
  await sidebar(page).getByRole('navigation').getByRole('button', { name: 'Hosting', exact: true }).click()
  await expect(page.getByText(SITE.name)).toBeVisible()
  await expect(page.getByText(OTHER_TENANT.projectName)).toHaveCount(0)

  // The API agrees, and refuses another tenant's website outright.
  const list = await page.request.get('/api/hosting')
  expect(list.ok()).toBe(true)
  const body = JSON.stringify(await list.json())
  expect(body).toContain(SITE.id)
  expect(body).not.toContain(OTHER_TENANT.projectId)

  for (const path of [
    `/api/hosting/${OTHER_TENANT.projectId}`,
    `/api/hosting/${OTHER_TENANT.projectId}/files`,
    `/api/hosting/${OTHER_TENANT.projectId}/domains`,
  ]) {
    const res = await page.request.get(path)
    expect([403, 404], `${path} answered ${res.status()}`).toContain(res.status())
  }
})
