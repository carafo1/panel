/**
 * Signs the seeded customer in once through the real sign-in form and saves
 * the session (an httpOnly cookie) for the signed-in specs. Signing in once
 * also keeps the suite well under the login rate limit (10 per minute).
 */
import { test as setup, expect, signIn, sidebar, SIGNED_OUT_ALLOW } from './support'
import { CUSTOMER_STATE } from './fixtures'

setup('sign in as the seeded customer', async ({ page, health }) => {
  for (const a of SIGNED_OUT_ALLOW) health.allow(a.pattern, a.reason)
  await signIn(page)
  await expect(sidebar(page).getByText('Erin Example')).toBeVisible()
  await page.context().storageState({ path: CUSTOMER_STATE })
})
