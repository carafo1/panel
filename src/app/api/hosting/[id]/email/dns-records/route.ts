import { NextResponse } from 'next.server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { generateEmailDnsRecords } from '@/lib/email-dns'

/**
 * Project Email DNS Records Endpoint
 * ====================================
 *
 *   GET  /api/hosting/[id]/email/dns-records?domain=<domainName>
 *
 * Returns the standard MX/SPF/DMARC/(DKIM) records the given domain needs in
 * order to send and receive mail through the Apsamo Panel Mailcow instance.
 *
 * The MX target hostname is derived from the `MAIL_SERVER_HOSTNAME` env var
 * (falling back to `mail.<domain>` when unset), so the records produced here
 * are ready to copy/paste straight into a DNS provider.
 */

function normaliseDomain(value: string): string {
  return value.toLowerCase().trim().replace(/\.+$/, '')
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const domainParam = normaliseDomain(url.searchParams.get('domain') || '')
    if (!domainParam) {
      return NextResponse.json(
        { error: 'Missing ?domain= query parameter.' },
        { status: 400 }
      )
    }

    const mailHost =
      process.env.MAIL_SERVER_HOSTNAME?.trim() || `mail.${domainParam}`

    const records = generateEmailDnsRecords(domainParam, mailHost)

    return NextResponse.json({
      domain: domainParam,
      mailServer: mailHost,
      records: {
        mx: records.mx,
        spf: records.spf,
        dmarc: records.dmarc,
        // DKIM public key is not stored at the panel level (Mailcow holds it).
        // We still return the record name + a hint value so the UI can prompt
        // the user to fetch the key from their Mailcow admin.
        dkim: {
          type: records.dkim.type,
          name: records.dkim.name,
          value: records.dkim.value || '(generate the DKIM key in Mailcow first)',
        },
      },
    })
  } catch (error) {
    console.error('Get email DNS records error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
