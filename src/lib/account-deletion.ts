/**
 * src/lib/account-deletion.ts
 * ════════════════════════════════════════════════════════════════════════════
 * A customer's right to take their data with them, and to leave.
 *
 * exportUserData   everything the panel holds about a person, as JSON —
 *                  without secrets (password hashes, encrypted credentials,
 *                  tokens), which are not "their data" in any useful sense
 *                  and would only be a liability in a downloaded file.
 *
 * deleteAccount    permanent. Websites are torn down, email domains removed,
 *                  subscriptions cancelled, sessions ended, and the person's
 *                  details erased. The User row itself is ANONYMISED, not
 *                  deleted: invoices cascade from it and financial records
 *                  must be kept, and the audit log must still say what
 *                  happened. Nothing left can identify the person.
 * ════════════════════════════════════════════════════════════════════════════
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { purgeProject } from '@/lib/project-teardown'
import { terminateEmailService } from '@/lib/email-hosting'
import { cancelSubscription, isStripeDemoMode } from '@/lib/stripe'
import { revokeAllSessions, hashPassword } from '@/lib/auth'

const SETTLED = ['paid', 'void', 'cancelled', 'refunded', 'draft']
const LIVE_DOMAIN = ['active', 'pending', 'transferring']

/** Reasons the account cannot be deleted yet, each something the customer can fix. */
export async function deletionBlockers(userId: string): Promise<string[]> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } })
  if (!user) return ['Account not found.']
  const blockers: string[] = []

  if (user.role === 'admin' || user.role === 'super_admin') {
    blockers.push('This is an administrator account. Ask another super admin to change your role first.')
  }

  const unpaid = await db.invoice.count({ where: { userId, status: { notIn: SETTLED } } })
  if (unpaid > 0) {
    blockers.push(`You have ${unpaid} unpaid invoice${unpaid === 1 ? '' : 's'}. Settle ${unpaid === 1 ? 'it' : 'them'} in Billing first.`)
  }

  const domains = await db.domain.findMany({
    where: { userId, registrar: { not: 'external' }, status: { in: LIVE_DOMAIN } },
    select: { name: true },
  })
  if (domains.length) {
    blockers.push(
      `These domains are registered through us and would be lost: ${domains.map((d) => d.name).join(', ')}. ` +
        'Transfer them to another registrar first (Domains → the domain → Auth code).'
    )
  }
  return blockers
}

/** Everything about the person, minus secrets. */
export async function exportUserData(userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, role: true, status: true, emailVerified: true,
      twoFactorEnabled: true, creditBalance: true, taxCountry: true, createdAt: true, updatedAt: true,
    },
  })
  if (!user) return null

  const [projects, domains, subscriptions, invoices, payments, credit, notifications, emailServices, teams, apiKeys, sessions, audit] =
    await Promise.all([
      db.project.findMany({
        where: { userId },
        select: {
          id: true, name: true, slug: true, framework: true, stack: true, deploymentMethod: true, status: true,
          subdomain: true, customDomain: true, sslEnabled: true, createdAt: true, updatedAt: true,
        },
      }),
      db.domain.findMany({
        where: { userId },
        select: {
          name: true, status: true, registrar: true, registeredAt: true, expiresAt: true, autoRenew: true, nameservers: true,
          dnsRecords: { select: { type: true, name: true, value: true, ttl: true, priority: true } },
        },
      }),
      db.subscription.findMany({
        where: { userId },
        select: { id: true, status: true, currentPeriodStart: true, currentPeriodEnd: true, cancelAtPeriodEnd: true, plan: { select: { name: true, price: true } }, createdAt: true },
      }),
      db.invoice.findMany({
        where: { userId },
        select: { number: true, status: true, total: true, tax: true, discount: true, currency: true, dueDate: true, paidAt: true, createdAt: true },
      }),
      db.payment.findMany({ where: { userId }, select: { amount: true, currency: true, status: true, method: true, createdAt: true } }),
      db.creditTransaction.findMany({ where: { userId }, select: { amount: true, balanceAfter: true, type: true, description: true, createdAt: true } }),
      db.notification.findMany({ where: { userId }, select: { title: true, message: true, type: true, read: true, createdAt: true } }),
      db.emailService.findMany({ where: { userId }, select: { domain: true, status: true, createdAt: true } }),
      db.teamMember.findMany({ where: { userId }, select: { role: true, team: { select: { name: true } } } }),
      db.apiKey.findMany({ where: { userId }, select: { name: true, lastUsed: true, createdAt: true } }),
      db.session.findMany({ where: { userId }, select: { createdAt: true, lastSeenAt: true, ipAddress: true, userAgent: true, revokedAt: true } }),
      db.auditLog.findMany({ where: { userId }, select: { action: true, resource: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 5000 }),
    ])

  return {
    exportedAt: new Date().toISOString(),
    note: 'Your personal data held by this panel. Passwords, keys and other secrets are not included.',
    account: user,
    websites: projects,
    domains,
    subscriptions,
    invoices,
    payments,
    accountCredit: credit,
    notifications,
    emailHosting: emailServices,
    teams: teams.map((t) => ({ team: t.team?.name, role: t.role })),
    apiKeys,
    signIns: sessions,
    activity: audit,
  }
}

/**
 * Permanently delete the account. Callers must have checked the password and
 * deletionBlockers() first. Returns cleanup problems that need an operator.
 */
export async function deleteAccount(userId: string): Promise<{ warnings: string[] }> {
  const warnings: string[] = []

  // ── Websites (containers, files, databases, proxy entries) ──
  const projects = await db.project.findMany({ where: { userId }, select: { id: true, name: true } })
  for (const p of projects) {
    try {
      const r = await purgeProject(p.id)
      warnings.push(...r.warnings.map((w) => `${p.name}: ${w}`))
    } catch (err) {
      warnings.push(`${p.name}: ${err instanceof Error ? err.message : 'teardown failed'}`)
    }
  }

  // ── Email hosting ──
  const services = await db.emailService.findMany({ where: { userId, status: { not: 'cancelled' } }, select: { id: true, domain: true } })
  for (const s of services) {
    const r = await terminateEmailService(s.id).catch((e: unknown) => ({ success: false, error: String(e) }))
    if (!r.success) warnings.push(`email ${s.domain}: ${r.error}`)
  }

  // ── Billing: stop future charges ──
  const subs = await db.subscription.findMany({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
    select: { id: true, stripeSubId: true },
  })
  for (const s of subs) {
    if (s.stripeSubId && !isStripeDemoMode()) {
      await cancelSubscription(s.stripeSubId).catch((e: unknown) => warnings.push(`Stripe ${s.stripeSubId}: ${String(e)}`))
    }
    await db.subscription.update({
      where: { id: s.id },
      data: { status: 'cancelled', cancelAtPeriodEnd: false, cancellationReason: 'account_deleted', cancelRequestedAt: new Date() },
    })
  }

  // ── SSH keys: take them off every website first (including team sites) ──
  {
    const { deleteKey } = await import('@/lib/sftp-access')
    for (const k of await db.sshKey.findMany({ where: { userId }, select: { id: true } })) {
      await deleteKey(userId, k.id).catch((err) => console.error('[account-deletion] ssh key removal failed:', err))
    }
  }

  // ── Everything else that is about the person ──
  await db.$transaction([
    db.domain.deleteMany({ where: { userId, OR: [{ registrar: 'external' }, { status: { notIn: LIVE_DOMAIN } }] } }),
    db.teamMember.deleteMany({ where: { userId } }),
    db.apiKey.deleteMany({ where: { userId } }),
    db.sshKey.deleteMany({ where: { userId } }),
    db.notification.deleteMany({ where: { userId } }),
    db.githubIntegration.deleteMany({ where: { userId } }),
    db.webhook.deleteMany({ where: { userId } }),
    db.backupDestination.deleteMany({ where: { userId } }),
  ])
  // Teams they own: remove the team (their projects are already gone).
  const owned = await db.team.findMany({ where: { ownerId: userId }, select: { id: true } })
  for (const t of owned) {
    await db.teamMember.deleteMany({ where: { teamId: t.id } })
    await db.project.updateMany({ where: { teamId: t.id }, data: { teamId: null } })
    await db.team.delete({ where: { id: t.id } }).catch(() => warnings.push(`team ${t.id} could not be removed`))
  }

  // ── End every login, then erase identity ──
  await revokeAllSessions(userId, 'account_deleted')
  await db.user.update({
    where: { id: userId },
    data: {
      email: `deleted-${userId}@deleted.invalid`,
      name: 'Deleted account',
      password: await hashPassword(crypto.randomBytes(32).toString('hex')),
      status: 'closed',
      statusReason: 'Deleted at the customer’s request',
      statusChangedAt: new Date(),
      emailVerified: false,
      emailVerificationToken: null,
      emailVerificationExpiresAt: null,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      avatar: null,
      twoFactorEnabled: false,
      twoFactorSecret: null,
      twoFactorBackupCodes: null,
      taxCountry: null,
    },
  })

  return { warnings }
}
