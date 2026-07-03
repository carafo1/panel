import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { generateEmailDnsRecords, type MailcowDkimInput } from '@/lib/email-dns'
import { getDomain, isMailcowConfigured } from '@/lib/mailcow'

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
 *
 * DKIM auto-fetch: when `MAILCOW_API_URL` + `MAILCOW_API_KEY` are configured
 * AND the domain exists in Mailcow AND has a DKIM keypair, the real DKIM
 * public key is fetched live from Mailcow's `GET /api/v1/get/dkim/{domain}`
 * endpoint and embedded in the returned DKIM TXT record. Otherwise the DKIM
 * record value falls back to a clear placeholder note instructing the user
 * to generate the key in Mailcow first.
 */

function normaliseDomain(value: string): string {
  return value.toLowerCase().trim().replace(/\.+$/, '')
}

/**
 * Best-effort fetch of the Mailcow DKIM keypair for `domain`. Returns null
 * when Mailcow isn't configured, the domain isn't in Mailcow, or Mailcow
 * has no DKIM key for it yet. Never throws — DKIM is a nice-to-have.
 */
async function fetchMailcowDkim(
  domain: string
): Promise<MailcowDkimInput | null> {
  if (!isMailcowConfigured()) return null
  try {
    const result = await getDomain(domain)
    if (!result.success || !result.domain) return null
    const dkim = result.domain.dkim
    if (!dkim || !dkim.public) return null
    return {
      selector: dkim.selector || 'mail',
      publicKey: dkim.public,
    }
  } catch (err) {
    console.error(
      '[email/dns-records] Mailcow DKIM fetch failed:',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
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

    // Best-effort: fetch the real DKIM public key from Mailcow.
    const mailcowDkim = await fetchMailcowDkim(domainParam)

    const records = generateEmailDnsRecords(
      domainParam,
      mailHost,
      undefined, // legacy dkimPublicKey — superseded by mailcowDkim when present
      'mail',    // legacy dkimSelector  — superseded by mailcowDkim when present
      undefined, // serverIp (not known at this layer; SPF falls back to `mx a`)
      mailcowDkim ?? undefined
    )

    // Build the DKIM value with a clear fallback note when no real key is
    // available, so the UI can prompt the user appropriately.
    const dkimValue =
      records.dkim.value ||
      (isMailcowConfigured()
        ? '(no DKIM key found for this domain in Mailcow — generate one in Mailcow → Configuration → ARC/DKIM first)'
        : '(Mailcow API not configured — set MAILCOW_API_URL + MAILCOW_API_KEY, then generate a DKIM key in Mailcow → Configuration → ARC/DKIM)')

    return NextResponse.json({
      domain: domainParam,
      mailServer: mailHost,
      records: {
        mx: records.mx,
        spf: records.spf,
        dmarc: records.dmarc,
        dkim: {
          type: records.dkim.type,
          name: records.dkim.name,
          value: dkimValue,
        },
      },
      // Expose whether the DKIM value is real or a placeholder so the UI can
      // style it differently (e.g. warning chip vs success chip).
      dkimSource: mailcowDkim ? 'mailcow' : 'placeholder',
    })
  } catch (error) {
    console.error('Get email DNS records error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
