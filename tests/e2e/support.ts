/**
 * Shared Playwright fixtures for the e2e specs.
 *
 * Every test gets a `health` fixture that records, for the whole test:
 *   - uncaught page errors (exceptions thrown in the browser)
 *   - console.error messages
 *   - same-origin responses with status >= 400
 *   - same-origin /api requests that failed outright (no response)
 *   - every error toast (sonner, data-type="error"), as it appears — toasts
 *     vanish after a few seconds, so checking the DOM at the end misses them
 * and fails the test at teardown if anything was recorded that the test did
 * not explicitly allow with `health.allow(...)`.
 */
import { test as base, expect, type Page } from '@playwright/test'
import { BASE_URL, CUSTOMER } from './fixtures'

type Problem = { kind: 'pageerror' | 'console' | 'http' | 'requestfailed' | 'toast'; text: string }

export interface Health {
  /** Allow problems whose text matches. Use only for behaviour that is correct. */
  allow(pattern: RegExp, reason: string): void
  /** Everything recorded so far that is not allowed. */
  problems(): Problem[]
  /** Error toasts seen so far (allowed or not). */
  errorToasts(): string[]
  /** Fail now if anything unexpected was recorded. */
  expectClean(context?: string): void
}

/**
 * Problems that are expected in every test, each with the reason.
 */
const GLOBAL_ALLOW: Array<{ pattern: RegExp; reason: string }> = [
  {
    // src/lib/socket.ts connects straight to the realtime service on :3003.
    // That separate service (mini-services/realtime-service) is not started
    // by the e2e setup; the client is documented to degrade to polling.
    pattern: /localhost:3003\/socket\.io|WebSocket connection to 'ws:\/\/localhost:3003/,
    reason: 'realtime service is not part of the e2e setup',
  },
  {
    // The browser repeats every >= 400 response as a console error. Those are
    // checked (with their URL) as 'http' problems instead.
    pattern: /^console: Failed to load resource: the server responded with a status of/,
    reason: 'duplicate of the http check',
  },
]

/**
 * Expected while nobody is signed in: the app asks /api/auth/me on every load
 * to find out whether there is a session, and "no" is a 401.
 */
export const SIGNED_OUT_ALLOW: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^http: 401 GET \/api\/auth\/me$/, reason: 'session probe while signed out' },
]

function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

export const test = base.extend<{ health: Health }>({
  health: [
    async ({ page }, use, testInfo) => {
      // Each test is its own client device. src/proxy.ts rate-limits ALL
      // /api traffic per client IP (100/min, keyed on X-Forwarded-For, which
      // Caddy sets in production); without this every test shares one bucket
      // and the suite trips it within a minute. Documentation-range address.
      const n = (testInfo.workerIndex * 1000 + testInfo.repeatEachIndex * 100 + hash(testInfo.testId)) % 250
      await page.context().setExtraHTTPHeaders({ 'x-forwarded-for': `198.51.100.${n + 1}` })

      const recorded: Problem[] = []
      const toasts: string[] = []
      const allowed: Array<{ pattern: RegExp; reason: string }> = [...GLOBAL_ALLOW]

      const fmt = (p: Problem) => `${p.kind}: ${p.text}`
      const isAllowed = (p: Problem) => allowed.some((a) => a.pattern.test(fmt(p)))

      await page.exposeFunction('__e2eErrorToast', (text: string) => {
        toasts.push(text)
        recorded.push({ kind: 'toast', text })
      })
      await page.addInitScript(() => {
        // Skip the first-login onboarding wizard; it is not under test here.
        try {
          localStorage.setItem('apsamo_onboarding_complete', 'true')
        } catch {
          /* storage unavailable */
        }
        const seen = new WeakSet<Element>()
        const report = (el: Element) => {
          if (seen.has(el)) return
          seen.add(el)
          // Text is filled in on the next frame; read it then.
          requestAnimationFrame(() => {
            const text = (el.textContent || '').trim() || '(empty error toast)'
            ;(window as unknown as { __e2eErrorToast: (t: string) => void }).__e2eErrorToast(text)
          })
        }
        const scan = (root: ParentNode) => {
          root.querySelectorAll?.('[data-sonner-toast][data-type="error"]').forEach(report)
        }
        new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type === 'attributes' && m.target instanceof Element) {
              if (m.target.matches('[data-sonner-toast][data-type="error"]')) report(m.target)
            }
            m.addedNodes.forEach((n) => {
              if (!(n instanceof Element)) return
              if (n.matches('[data-sonner-toast][data-type="error"]')) report(n)
              scan(n)
            })
          }
        }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-type'] })
      })

      page.on('pageerror', (err) => recorded.push({ kind: 'pageerror', text: `${err.name}: ${err.message}` }))
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return
        const where = msg.location()?.url ? ` (${msg.location().url})` : ''
        recorded.push({ kind: 'console', text: `${msg.text()}${where}` })
      })
      page.on('response', (res) => {
        const url = res.url()
        if (!url.startsWith(BASE_URL) || res.status() < 400) return
        recorded.push({ kind: 'http', text: `${res.status()} ${res.request().method()} ${url.slice(BASE_URL.length)}` })
      })
      page.on('requestfailed', (req) => {
        const url = req.url()
        const failure = req.failure()?.errorText || 'failed'
        // Requests cancelled by a navigation or an unmount are not failures.
        if (!url.startsWith(`${BASE_URL}/api/`) || /ERR_ABORTED|NS_BINDING_ABORTED/.test(failure)) return
        recorded.push({ kind: 'requestfailed', text: `${req.method()} ${url.slice(BASE_URL.length)} ${failure}` })
      })

      const health: Health = {
        allow(pattern, reason) {
          if (!reason) throw new Error('health.allow needs a reason')
          allowed.push({ pattern, reason })
        },
        problems: () => recorded.filter((p) => !isAllowed(p)),
        errorToasts: () => [...toasts],
        expectClean(context) {
          const bad = health.problems().map(fmt)
          expect(bad, `unexpected browser/API errors${context ? ` ${context}` : ''}`).toEqual([])
        },
      }

      await use(health)

      // Teardown: catch anything that happened after the last explicit check.
      health.expectClean('(at end of test)')
    },
    { auto: true },
  ],
})

export { expect }

/** Fill the sign-in form (the dialog opened by /#login) and submit it. */
export async function signIn(page: Page, email: string = CUSTOMER.email, password: string = CUSTOMER.password) {
  await page.goto('/#login')
  await expect(page.getByLabel('Email')).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
}

/** The desktop sidebar (the <aside> landmark). */
export const sidebar = (page: Page) => page.getByRole('complementary')

/** The title in the dashboard's top bar, which names the open section. */
export const sectionTitle = (page: Page) => page.getByRole('main').getByRole('heading', { level: 2 }).first()
