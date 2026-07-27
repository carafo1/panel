/**
 * POST /api/admin/domains/reconcile
 *
 * Reconciles what the panel CLAIMS about domain ownership against what the
 * registrar actually holds, and demotes the liars.
 *
 * Why this exists: `provider` and `registrar` used to default to "dynadot", so
 * every Domain row created without explicit values — by a seed, an admin, a
 * half-finished flow — presented itself as registered with us. The panel then
 * offered renew / nameserver / lock / WHOIS / auth-code controls for domains
 * the registrar had never heard of, and every one of those calls failed with
 * "could not find domain in your account".
 *
 * A row is only treated as ours when the registrar confirms it by name. The
 * schema default is now "external", so this is a repair tool for existing data
 * rather than a recurring necessity.
 *
 * Body: { dryRun?: boolean }  — dryRun defaults to TRUE. Nothing is written
 * unless the caller explicitly asks for it, because this rewrites ownership
 * on live customer records.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { ok, apiError } from '@/lib/api-response'
import { isAdmin } from '@/lib/security'
import { listDomains, isDynadotDemoMode } from '@/lib/dynadot'
import { looksLikeSubdomain } from '@/lib/domain-ownership'
import { logAudit } from '@/lib/audit'

interface ReconcileFinding {
  id: string
  name: string
  claimed: string
  verdict: 'confirmed' | 'demoted' | 'subdomain'
  reason: string
}

export async function POST(request: Request) {
  const user = await authenticateRequest(request)
  if (!user) return apiError.unauthorized()
  if (!isAdmin(user.role)) return apiError.forbidden()

  if (isDynadotDemoMode()) {
    return apiError.badRequest(
      'No registrar API key is configured, so ownership cannot be verified.'
    )
  }

  try {
    const body = await request.json().catch(() => ({}))
    // Default to a dry run: this rewrites ownership on live records.
    const dryRun = body?.dryRun !== false

    // ── What the registrar actually holds ────────────────────────────
    let accountDomains: Set<string>
    try {
      const listed = await listDomains()
      accountDomains = new Set(
        [...listed.main, ...listed.deleted]
          .map((d) => (d.name || '').toLowerCase().trim())
          .filter(Boolean)
      )
    } catch (err) {
      console.error('[admin/domains/reconcile] registrar list failed:', err)
      return apiError.serverError(
        'Could not read the registrar account. Nothing was changed.'
      )
    }

    if (accountDomains.size === 0) {
      // Refuse to act on an empty list — a transient API hiccup that returned
      // nothing would otherwise demote every domain we own in one shot.
      return apiError.serverError(
        'The registrar returned an empty domain list. Refusing to reconcile against it.'
      )
    }

    // ── What the panel claims ────────────────────────────────────────
    const claimed = await db.domain.findMany({
      where: { provider: 'dynadot' },
      select: {
        id: true,
        name: true,
        provider: true,
        registrar: true,
        externalId: true,
        expiresAt: true,
        autoRenew: true,
      },
    })

    const findings: ReconcileFinding[] = []

    for (const row of claimed) {
      const name = row.name.toLowerCase().trim()

      if (accountDomains.has(name)) {
        // Backfill the registrar id when it's missing.
        //
        // Ownership is decided by `externalId`, so a genuinely-ours domain
        // whose row predates that field — or was created by a flow that never
        // set it — classifies as EXTERNAL and silently loses its registrar
        // controls. Confirming it against the account and leaving the row
        // unrepaired would keep the panel wrong in the opposite direction.
        //
        // Dynadot addresses domains by name; the name IS the registrar's
        // identifier here, and we only reach this line when the account has
        // confirmed it.
        const needsBackfill = !row.externalId || !row.externalId.trim()
        if (needsBackfill && !dryRun) {
          await db.domain.update({
            where: { id: row.id },
            data: { externalId: name, provider: 'dynadot', registrar: 'dynadot' },
          })
          await db.domainLog
            .create({
              data: {
                domainId: row.id,
                userId: user.userId,
                action: 'ownership.reconcile',
                status: 'success',
                message: 'Confirmed at the registrar; restored registrar id.',
              },
            })
            .catch(() => {})
        }
        findings.push({
          id: row.id,
          name: row.name,
          claimed: 'dynadot',
          verdict: 'confirmed',
          reason: needsBackfill
            ? dryRun
              ? 'Present in the registrar account — registrar id is missing and would be restored.'
              : 'Present in the registrar account — registrar id was missing and has been restored.'
            : 'Present in the registrar account.',
        })
        continue
      }

      // Distinguish "subdomain of something we own" from "someone else's
      // domain" exactly, rather than by label count — `edma.apsamo.com` and
      // `example.co.uk` both have three labels, so counting cannot tell them
      // apart. If dropping the leftmost label lands on a domain that IS in the
      // account, this is a hostname inside our own zone.
      const parent = name.split('.').slice(1).join('.')
      const isSub = accountDomains.has(parent) || looksLikeSubdomain(name)
      findings.push({
        id: row.id,
        name: row.name,
        claimed: 'dynadot',
        verdict: isSub ? 'subdomain' : 'demoted',
        reason: isSub
          ? 'Not a registrable domain — this is a hostname inside another zone.'
          : 'Not in the registrar account; registered with another provider.',
      })

      if (!dryRun) {
        await db.domain.update({
          where: { id: row.id },
          data: {
            provider: 'external',
            registrar: 'external',
            // Expiry and auto-renew are the registrar's facts to state. For a
            // domain we don't hold, any value here is a guess, and a wrong
            // expiry drives false renewal reminders and false suspensions.
            expiresAt: null,
            autoRenew: false,
            externalId: null,
          },
        })
        await db.domainLog
          .create({
            data: {
              domainId: row.id,
              userId: user.userId,
              action: 'ownership.reconcile',
              status: 'success',
              message: `Reclassified as external — ${
                isSub ? 'not a registrable domain' : 'not in the registrar account'
              }.`,
            },
          })
          .catch(() => {})
      }
    }

    const demoted = findings.filter((f) => f.verdict !== 'confirmed')

    if (!dryRun && demoted.length > 0) {
      await logAudit({
        userId: user.userId,
        action: 'domain.ownership.reconcile',
        resource: 'domain',
        req: request,
        metadata: {
          demoted: demoted.map((d) => d.name),
          confirmed: findings.length - demoted.length,
        },
      })
    }

    const repaired = findings.filter(
      (f) => f.verdict === 'confirmed' && f.reason.includes('registrar id')
    ).length

    return ok(
      {
        dryRun,
        registrarDomainCount: accountDomains.size,
        checked: findings.length,
        confirmed: findings.length - demoted.length,
        reclassified: demoted.length,
        repaired,
        findings,
      },
      dryRun
        ? `Dry run: ${demoted.length} of ${findings.length} would be reclassified as external. Re-run with {"dryRun": false} to apply.`
        : `Reclassified ${demoted.length} as external${
            repaired > 0 ? `, restored the registrar id on ${repaired}` : ''
          }.`
    )
  } catch (error) {
    console.error('[admin/domains/reconcile] error:', error)
    return apiError.serverError()
  }
}
