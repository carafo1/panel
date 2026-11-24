/**
 * Test data shared by the e2e seed (tests/e2e/seed.ts) and the specs.
 *
 * The password below is a throwaway value that exists only in the isolated
 * e2e database this suite builds in a temp directory. It is not, and must
 * never become, a password for any real account.
 */
export const E2E_PORT = Number(process.env.E2E_PORT || 3100)
export const BASE_URL = `http://localhost:${E2E_PORT}`

export const CUSTOMER = {
  id: 'e2e-customer',
  name: 'Erin Example',
  email: 'e2e-customer@example.test',
  password: 'E2e-Only-Pass-7391!',
} as const

/** A second tenant whose data the customer must never see. */
export const OTHER_TENANT = {
  id: 'e2e-other-tenant',
  name: 'Olly Other',
  email: 'e2e-other@example.test',
  password: 'E2e-Other-Pass-2468!',
  projectId: 'e2e-other-project',
  projectName: 'Other Tenant Shop',
} as const

export const PLAN = { id: 'e2e-plan', name: 'E2E Starter', slug: 'e2e-starter' } as const

/**
 * The customer's WordPress website. It has no server, so every server-side
 * operation (files, WordPress, terminal, backups...) runs in the panel's
 * simulated demo mode (VPS_DEMO_MODE=1) and nothing needs Docker or SSH.
 */
export const SITE = {
  id: 'e2e-wp-site',
  name: 'Erin Garden Shop',
  slug: 'erin-garden-shop',
  subdomain: 'erin-garden-shop.apsamo.test',
  deployPath: '/opt/apsamo/sites/erin-garden-shop',
  // Stored both as the legacy project.customDomain AND as a WebsiteDomain
  // row: the case that once listed the domain twice on the website page.
  customDomain: 'erin-garden-shop.example.com',
} as const

/** Session file written by auth.setup.ts and reused by signed-in specs. */
export const CUSTOMER_STATE = 'tests/e2e/.auth/customer.json'
