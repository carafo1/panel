import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader } from '@/lib/auth'
import { generateEmailDnsRecords } from '@/lib/email-dns'
import { lookupMailcowDkim, DKIM_REASON_TEXT } from '@/lib/email-dkim'
import { MAIL_SERVER_HOSTNAME } from '@/lib/brand-config'

/**
 * GET /api/domains/[id]/email-dns[?mx=<mail server hostname>]
 *
 * The MX / SPF / DMARC / DKIM records a domain needs to send and receive mail,
 * in the Domains panel's record shape, ready to merge into its DNS editor.
 *
 * DKIM is included ONLY when Mailcow holds a real key for the domain. The
 * panel used to insert `p=PLACEHOLDER_REPLACE_WITH_DKIM_KEY`; publishing that
 * makes receivers fail DKIM and push the domain's mail to spam. When there is
 * no key, `dkim.available` is false and `dkim.reason` says why.
 *
 * Read-only: it never creates anything in Mailcow or DNS.
 */

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const token = extractTokenFromHeader(request.headers.get('Authorization'))
    if (!token) return NextResponse.json({ error: 'Authorization token required' }, { status: 401 })
    const decoded = await verifyTokenFresh(token)
    if (!decoded) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })

    const { id } = await params
    const domain = await db.domain.findFirst({
      where: { id, userId: decoded.userId },
      select: { name: true },
    })
    if (!domain) return NextResponse.json({ error: 'Domain not found' }, { status: 404 })

    const mxParam = new URL(request.url).searchParams.get('mx')
    const mailServer = (mxParam ?? MAIL_SERVER_HOSTNAME).trim().toLowerCase().replace(/\.+$/, '')
    if (!HOSTNAME.test(mailServer)) {
      return NextResponse.json({ error: 'Mail server must be a valid hostname, e.g. mail.example.com' }, { status: 400 })
    }

    const lookup = await lookupMailcowDkim(domain.name)
    const generated = generateEmailDnsRecords(
      domain.name,
      mailServer,
      undefined,
      'mail',
      undefined,
      lookup.ok ? lookup.dkim : undefined
    )

    const noDot = (v: string) => v.replace(/\.+$/, '')
    const records = [
      { type: 'MX', name: '@', value: noDot(generated.mx.value), ttl: 3600, priority: generated.mx.priority },
      { type: 'TXT', name: '@', value: generated.spf.value, ttl: 3600, priority: null },
      { type: 'TXT', name: generated.dmarc.name, value: generated.dmarc.value, ttl: 3600, priority: null },
    ]
    if (lookup.ok && generated.dkim.value) {
      records.push({ type: 'TXT', name: generated.dkim.name, value: generated.dkim.value, ttl: 3600, priority: null })
    }

    return NextResponse.json({
      domain: domain.name,
      mailServer,
      records,
      dkim: lookup.ok
        ? { available: true, name: generated.dkim.name }
        : { available: false, reason: lookup.reason, message: DKIM_REASON_TEXT[lookup.reason] },
    })
  } catch (error) {
    console.error('[domains/email-dns] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
