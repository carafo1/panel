/**
 * Sign in and sign out through the real form, from a browser with no session.
 */
import { test, expect, signIn, sidebar, SIGNED_OUT_ALLOW } from './support'
import { BASE_URL, CUSTOMER } from './fixtures'

test.use({ storageState: { cookies: [], origins: [] } })

test.beforeEach(({ health }) => {
  for (const a of SIGNED_OUT_ALLOW) health.allow(a.pattern, a.reason)
})

test('a wrong password is refused with a visible error and no session', async ({ page, health }) => {
  health.allow(/^http: 401 POST \/api\/auth\/login$/, 'the wrong password is supposed to be refused')
  health.allow(/^toast: .*Invalid email or password/, 'the refusal is shown as an error toast')

  await signIn(page, CUSTOMER.email, 'definitely-not-the-password')

  await expect(page.getByText('Invalid email or password')).toBeVisible()
  // Still on the sign-in form, not in the dashboard.
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(sidebar(page)).toHaveCount(0)
  expect(health.errorToasts()).toEqual([expect.stringContaining('Invalid email or password')])

  const me = await page.request.get('/api/auth/me')
  expect(me.status()).toBe(401)
})

test('the customer signs in, sees the dashboard, and signs out', async ({ page, context, playwright }) => {
  await signIn(page)

  await expect(sidebar(page).getByText(CUSTOMER.name)).toBeVisible()
  await expect(sidebar(page).getByText(CUSTOMER.email)).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Dashboard' })).toBeVisible()

  // The session lives in an httpOnly cookie that page scripts cannot read.
  const session = (await context.cookies()).find((c) => /apsamo_session$/.test(c.name))
  expect(session, 'session cookie').toBeTruthy()
  expect(session!.httpOnly).toBe(true)
  expect(await page.evaluate(() => document.cookie)).not.toContain('apsamo_session')

  await sidebar(page).getByRole('button', { name: 'Sign out' }).click()

  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(sidebar(page)).toHaveCount(0)

  // Signed out for real: a reload does not bring the dashboard back, and the
  // API no longer accepts this browser.
  await page.reload()
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
  await expect(sidebar(page)).toHaveCount(0)
  expect((await page.request.get('/api/auth/me')).status()).toBe(401)

  // The old session token itself was revoked on the server, not just
  // deleted from this browser: replaying it is refused.
  const replay = await playwright.request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { Cookie: `${session!.name}=${session!.value}` },
  })
  try {
    expect((await replay.get('/api/auth/me')).status()).toBe(401)
  } finally {
    await replay.dispose()
  }
})
