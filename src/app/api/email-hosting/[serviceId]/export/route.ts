/**
 * GET /api/email-hosting/[serviceId]/export
 *
 * A downloadable snapshot of everything the panel knows about a service:
 * plan and limits, mailboxes and their quotas, aliases and distribution lists,
 * the catch-all, each mailbox's auto-reply, and the DNS to publish.
 *
 * This is a CONFIGURATION export, not a mail backup — stored messages are not
 * included and could not be, at this size, through a JSON endpoint. That
 * distinction is stated in the file itself so nobody mistakes it for a way to
 * recover their mail. Copying mail belongs to an IMAP-level migration.
 *
 * Passwords are deliberately absent: the panel never holds mailbox passwords
 * in plaintext, and app passwords exist only as hashes inside Mailcow.
 */
import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import {
  resolveEmailService,
  emailServiceErrorResponse,
} from '@/lib/email-service-guard'
import {
  effectiveLimits,
  getEmailUsage,
  emailDnsRecords,
  addonMonthlyCost,
} from '@/lib/email-hosting'
import { listMailboxes, getDomain } from '@/lib/mailcow'
import { listAliases } from '@/lib/mailcow-manage'
import { getAutoReply } from '@/lib/mailcow-mailbox'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ serviceId: string }> }
) {
  const { serviceId } = await params
  try {
    const { service, auth, domains } = await resolveEmailService(request, serviceId)

    const [plan, boxes, aliasList, usage, domainInfo] = await Promise.all([
      db.plan.findUnique({
        where: { id: service.planId },
        select: { name: true, slug: true, price: true, currency: true },
      }),
      listMailboxes(service.domain),
      listAliases(domains).catch(() => []),
      getEmailUsage(service).catch(() => null),
      getDomain(service.domain).catch(() => null),
    ])

    const mailboxes = boxes.success ? boxes.mailboxes || [] : []

    // Auto-replies are per mailbox and each is a separate Mailcow read, so
    // fetch them together rather than serially.
    const autoReplies = await Promise.all(
      mailboxes.map(async (b) => ({
        address: b.address,
        autoReply: await getAutoReply(b.address).catch(() => null),
      }))
    )
    const replyByAddress = new Map(autoReplies.map((r) => [r.address, r.autoReply]))

    const dkim = domainInfo?.success ? domainInfo.domain?.dkim : undefined

    const payload = {
      _about:
        'Apsamo email hosting — configuration export. This describes the setup of ' +
        'your mail domain. It does NOT contain stored messages, and cannot be used ' +
        'to restore mail. Passwords are not included.',
      exportedAt: new Date().toISOString(),
      service: {
        domain: service.domain,
        status: service.status,
        createdAt: service.createdAt,
        provisioned: service.mailcowDomainCreated,
        dkimGenerated: service.dkimGenerated,
      },
      plan,
      limits: effectiveLimits(service),
      addons: {
        extraMailboxes: service.extraMailboxes,
        extraStorageGB: service.extraStorageGB,
        monthlyCost: addonMonthlyCost(service),
      },
      usage,
      mailboxes: mailboxes.map((b) => ({
        address: b.address,
        name: b.name,
        active: b.active,
        quotaBytes: b.quota,
        usedBytes: b.usedQuota,
        autoReply: replyByAddress.get(b.address) ?? null,
      })),
      aliases: aliasList
        .filter((a) => !a.isCatchAll)
        .map((a) => ({
          address: a.address,
          destinations: a.destinations,
          active: a.active,
          isDistributionList: a.destinations.length > 1,
        })),
      catchAll:
        aliasList.find((a) => a.isCatchAll)?.destinations?.[0] ?? null,
      dns: emailDnsRecords(service.domain, {
        dkimValue: dkim?.public,
        dkimSelector: dkim?.selector,
      }),
    }

    await logAudit({
      userId: auth.userId,
      action: 'email.export',
      resource: 'emailService',
      resourceId: service.id,
      req: request,
      status: 'success',
      metadata: { domain: service.domain, mailboxes: mailboxes.length },
    })

    const filename = `apsamo-email-${service.domain}-${new Date()
      .toISOString()
      .slice(0, 10)}.json`

    return new NextResponse(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const { error, status } = emailServiceErrorResponse(err)
    return NextResponse.json({ error }, { status })
  }
}
