/**
 * /api/email-hosting/verify-domain
 *   GET  ?domain=…  — the TXT record to publish, and whether it is live yet
 *   POST { domain } — re-check now (what the "Check again" button calls)
 *
 * Both do the same work; POST exists so the UI can retry without a cacheable
 * GET sitting in front of a live DNS lookup.
 */
import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import {
  assertDomainControl,
  normaliseDomainName,
  verificationRecord,
} from '@/lib/domain-verification'

const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z]{2,}$/i

async function handle(request: Request, domainRaw: string) {
  const auth = await authenticateRequest(request)
  if (!auth) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  const domain = normaliseDomainName(domainRaw || '')
  if (!domain || !DOMAIN_RE.test(domain)) {
    return NextResponse.json(
      { error: 'That does not look like a valid domain name' },
      { status: 400 }
    )
  }

  const result = await assertDomainControl(auth.userId, domain)
  return NextResponse.json({
    domain,
    verified: result.verified,
    reason: result.reason,
    // Always returned so the UI can show the record before the first check.
    record: result.record || verificationRecord(auth.userId, domain),
  })
}

export async function GET(request: Request) {
  const domain = new URL(request.url).searchParams.get('domain') || ''
  return handle(request, domain)
}

export async function POST(request: Request) {
  let domain = ''
  try {
    const body = (await request.json()) as { domain?: string }
    domain = body.domain || ''
  } catch {
    /* handled as invalid below */
  }
  return handle(request, domain)
}
