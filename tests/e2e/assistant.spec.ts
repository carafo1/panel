/**
 * The AI assistant with no AI provider configured (no ANTHROPIC_API_KEY, no
 * .z-ai-config): it must still answer — honestly saying AI is off and
 * pointing at the customer's own data — instead of failing with an error.
 */
import { test, expect, sidebar } from './support'

test('the assistant answers without error when no AI provider is configured', async ({ page, health }) => {
  await page.goto('/')
  await sidebar(page).getByRole('navigation').getByRole('button', { name: 'AI Assistant', exact: true }).click()

  const input = page.getByPlaceholder('Ask about hosting, deployment, DNS...')
  await expect(input).toBeEnabled()

  const replied = page.waitForResponse(
    (r) => r.url().endsWith('/api/assistant/chat') && r.request().method() === 'POST'
  )
  await input.fill('What websites do I have?')
  await input.press('Enter')

  const res = await replied
  expect(res.status()).toBe(200)
  const data = await res.json()
  expect(data.aiAvailable).toBe(false)

  await expect(page.getByText('What websites do I have?')).toBeVisible()
  await expect(page.getByText(/AI answers are not switched on for this panel yet/)).toBeVisible()
  // The offline answer still uses the customer's own account data.
  // (src/app/api/assistant/chat/route.ts offlineReply → getUserSummary)
  expect(data.response).toContain('Here is what I can see on your account')
  expect(data.response).toMatch(/Total projects: 1 \(1 running\)/)
  await expect(input).toBeEnabled()

  expect(health.errorToasts()).toEqual([])
})
