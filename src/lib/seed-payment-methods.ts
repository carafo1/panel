import { db } from '@/lib/db'

export async function seedPaymentMethods() {
  const methods = [
    { method: 'stripe', displayName: 'Credit Card (Stripe)', active: true, icon: 'credit-card', sortOrder: 1 },
    { method: 'waafi', displayName: 'Waafi Pay', active: false, icon: 'wallet', sortOrder: 2 },
    { method: 'manual', displayName: 'Bank Transfer', active: false, icon: 'building', sortOrder: 3 },
  ]

  for (const m of methods) {
    await db.paymentMethodSetting.upsert({
      where: { method: m.method },
      update: {},
      create: m,
    })
  }
  console.log('[seed] Payment methods seeded')
}
