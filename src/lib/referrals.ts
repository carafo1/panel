/**
 * Referral programme.
 *
 * Every customer has a personal link (/?ref=CODE). Someone who signs up with
 * it is recorded as their referral. When that person's first real payment
 * clears (markInvoicePaid — invoices settled entirely with credit don't count),
 * the referrer gets account credit, and optionally so does the new customer.
 *
 * Abuse limits: the new customer must have verified their email, the payment
 * must reach a minimum, each person can only ever be referred once, and a
 * referrer is rewarded at most `monthlyCap` times per 30 days. Amounts and
 * limits are set by an admin (Admin → Discounts → Referral programme).
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { adjustCredit } from '@/lib/credit'
import { createNotification } from '@/lib/notifications'

export interface ReferralSettings {
  enabled: boolean
  referrerReward: number
  refereeReward: number
  minPayment: number
  monthlyCap: number
}

const SETTINGS_KEY = 'referral.settings'
export const DEFAULT_REFERRAL_SETTINGS: ReferralSettings = { enabled: true, referrerReward: 10, refereeReward: 0, minPayment: 5, monthlyCap: 20 }

export class ReferralError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

export async function getReferralSettings(): Promise<ReferralSettings> {
  const row = await db.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null)
  if (!row) return { ...DEFAULT_REFERRAL_SETTINGS }
  try {
    return { ...DEFAULT_REFERRAL_SETTINGS, ...(JSON.parse(row.value) as Partial<ReferralSettings>) }
  } catch {
    return { ...DEFAULT_REFERRAL_SETTINGS }
  }
}

export async function saveReferralSettings(input: Record<string, unknown>, adminId: string) {
  const cur = await getReferralSettings()
  const num = (k: keyof ReferralSettings, min: number, max: number) => {
    if (input[k] === undefined) return cur[k] as number
    const n = Number(input[k])
    if (!Number.isFinite(n) || n < min || n > max) throw new ReferralError(`${k} must be between ${min} and ${max}.`)
    return Math.round(n * 100) / 100
  }
  const next: ReferralSettings = {
    enabled: input.enabled === undefined ? cur.enabled : input.enabled === true,
    referrerReward: num('referrerReward', 0, 500),
    refereeReward: num('refereeReward', 0, 500),
    minPayment: num('minPayment', 0, 10_000),
    monthlyCap: Math.round(num('monthlyCap', 0, 1000)),
  }
  await db.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next), updatedBy: adminId },
    update: { value: JSON.stringify(next), updatedBy: adminId },
  })
  return next
}

// Unambiguous characters only (no 0/O, 1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
function newCode() {
  const bytes = crypto.randomBytes(8)
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

export async function ensureReferralCode(userId: string): Promise<string> {
  const existing = await db.referralCode.findUnique({ where: { userId } })
  if (existing) return existing.code
  for (let i = 0; i < 5; i++) {
    try {
      return (await db.referralCode.create({ data: { userId, code: newCode() } })).code
    } catch {
      const again = await db.referralCode.findUnique({ where: { userId } })
      if (again) return again.code
    }
  }
  throw new ReferralError('Could not create a referral code. Please try again.', 500)
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const c = raw.trim().toUpperCase()
  return /^[A-Z0-9]{6,12}$/.test(c) ? c : null
}

/** Called right after sign-up. Never throws: a bad code must not block registration. */
export async function attachReferral(newUserId: string, rawCode: unknown): Promise<boolean> {
  try {
    const code = normalizeCode(rawCode)
    if (!code) return false
    const settings = await getReferralSettings()
    if (!settings.enabled) return false
    const owner = await db.referralCode.findUnique({ where: { code }, include: { user: { select: { id: true, status: true } } } })
    if (!owner || owner.userId === newUserId || owner.user.status !== 'active') return false
    if (await db.referral.findUnique({ where: { referredUserId: newUserId }, select: { id: true } })) return false
    await db.referral.create({ data: { referrerId: owner.userId, referredUserId: newUserId } })
    return true
  } catch (err) {
    console.error('[referrals] attach failed:', err)
    return false
  }
}

const mask = (email: string) => {
  const [name, domain] = email.split('@')
  return `${name.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, name.length - 2)))}@${domain ?? ''}`
}

/**
 * After a payment clears. Idempotent: the status guard means a referral is
 * rewarded at most once even if two payments land at the same moment.
 */
export async function qualifyReferral(userId: string, amountPaid: number): Promise<void> {
  const ref = await db.referral.findUnique({
    where: { referredUserId: userId },
    include: { referred: { select: { email: true, emailVerified: true } } },
  })
  if (!ref || ref.status !== 'signed_up') return
  const s = await getReferralSettings()
  if (!(amountPaid > 0) || amountPaid < s.minPayment) return // wait for a qualifying payment
  if (!ref.referred.emailVerified) return // wait until they verify

  let note: string | null = null
  if (!s.enabled) note = 'Referral programme was off when the payment cleared.'
  else {
    const recent = await db.referral.count({ where: { referrerId: ref.referrerId, status: 'rewarded', rewardedAt: { gte: new Date(Date.now() - 30 * 86400_000) } } })
    if (recent >= s.monthlyCap) note = `Monthly limit of ${s.monthlyCap} rewarded referrals reached.`
  }

  const claimed = await db.referral.updateMany({
    where: { id: ref.id, status: 'signed_up' },
    data: note
      ? { status: 'not_rewarded', note }
      : { status: 'rewarded', rewardedAt: new Date(), referrerReward: s.referrerReward, refereeReward: s.refereeReward },
  })
  if (!claimed.count || note) return

  if (s.referrerReward > 0) {
    await adjustCredit({ userId: ref.referrerId, amount: s.referrerReward, type: 'adjustment', description: `Referral reward: ${mask(ref.referred.email)} became a customer` })
    await createNotification({ userId: ref.referrerId, title: 'Referral reward', message: `You earned $${s.referrerReward.toFixed(2)} credit — someone you referred became a customer.`, type: 'success', link: '/?tab=billing' }).catch(() => {})
  }
  if (s.refereeReward > 0) {
    await adjustCredit({ userId, amount: s.refereeReward, type: 'adjustment', description: 'Welcome credit for joining with a referral link' })
  }
}

export async function referralSummary(userId: string) {
  const [code, settings, rows] = await Promise.all([
    ensureReferralCode(userId),
    getReferralSettings(),
    db.referral.findMany({
      where: { referrerId: userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { referred: { select: { email: true } } },
    }),
  ])
  const base = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '')
  return {
    enabled: settings.enabled,
    code,
    link: `${base}/?ref=${code}`,
    referrerReward: settings.referrerReward,
    refereeReward: settings.refereeReward,
    minPayment: settings.minPayment,
    totals: {
      signedUp: rows.length,
      rewarded: rows.filter((r) => r.status === 'rewarded').length,
      earned: Math.round(rows.reduce((a, r) => a + (r.status === 'rewarded' ? r.referrerReward || 0 : 0), 0) * 100) / 100,
    },
    referrals: rows.map((r) => ({ id: r.id, who: mask(r.referred.email), status: r.status, reward: r.referrerReward, createdAt: r.createdAt, rewardedAt: r.rewardedAt })),
  }
}

export async function adminReferralOverview() {
  const [settings, rows] = await Promise.all([
    getReferralSettings(),
    db.referral.findMany({
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { referrer: { select: { email: true } }, referred: { select: { email: true } } },
    }),
  ])
  return {
    settings,
    referrals: rows.map((r) => ({
      id: r.id,
      referrer: r.referrer.email,
      referred: r.referred.email,
      status: r.status,
      reward: r.referrerReward,
      note: r.note,
      createdAt: r.createdAt,
      rewardedAt: r.rewardedAt,
    })),
  }
}
