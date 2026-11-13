/**
 * Whether simulated behaviour (payments that succeed without a gateway,
 * servers that "deploy" without credentials) may run at all.
 *
 * Demo paths exist so the panel can be developed and demonstrated without real
 * Stripe, Waafi or VPS credentials. In production they are dangerous: a
 * missing STRIPE_SECRET_KEY made checkout report success, activate the plan
 * and provision a real container and a real registrar purchase without taking
 * any money. So production never simulates: a gateway or server that is not
 * configured is simply unavailable.
 */
export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

/** Simulated payments are allowed only outside production. */
export function demoPaymentsAllowed(): boolean {
  return !isProduction()
}
