/**
 * Live DNS health for an email service.
 *
 * Provisioning an email service and publishing its DNS are two different
 * things, and only the first one happens on our side. A customer can be
 * fully provisioned, billed, and marked "active" while their domain has no MX
 * record at all — in which case nothing on the internet routes mail to them
 * and the service silently does nothing.
 *
 * That is not hypothetical: a paying customer sat in exactly that state,
 * because the panel handed them the records to publish and then never checked
 * whether they had. Nothing anywhere compared what we told them to publish
 * against what actually resolves.
 *
 * This does that comparison against real DNS, so the customer sees "your MX is
 * missing" instead of an inbox that never fills, and an operator can see it
 * without leaving the panel.
 */
import { promises as dns } from 'dns'
import { emailDnsRecords, mailServerHost } from '@/lib/email-hosting'

export type CheckState = 'ok' | 'missing' | 'wrong' | 'unknown'

export interface DnsCheck {
  record: string
  label: string
  state: CheckState
  /** What is actually published, when something is. */
  found: string | null
  expected: string
  /** Whether mail is broken without it, as opposed to merely weaker. */
  critical: boolean
  detail: string
}

export interface DnsHealth {
  domain: string
  /** True only when every critical record resolves correctly. */
  deliverable: boolean
  checks: DnsCheck[]
  summary: string
  checkedAt: string
}

/** Compare a TXT lookup, tolerating the 255-byte chunking DNS applies. */
async function txtValues(host: string): Promise<string[] | null> {
  try {
    const rows = await dns.resolveTxt(host)
    return rows.map((chunks) => chunks.join('').trim())
  } catch {
    return null
  }
}

export async function checkEmailDns(
  domain: string,
  opts: { dkimValue?: string; dkimSelector?: string } = {}
): Promise<DnsHealth> {
  const expected = emailDnsRecords(domain, opts)
  const host = mailServerHost()
  const checks: DnsCheck[] = []

  // ── MX: the one that decides whether mail arrives at all ──
  const mxExpected = expected.find((r) => r.type === 'MX')
  try {
    const mx = await dns.resolveMx(domain)
    const targets = mx.map((m) => m.exchange.replace(/\.$/, '').toLowerCase())
    const pointsHere = targets.includes(host.toLowerCase())
    checks.push({
      record: 'MX',
      label: 'Mail delivery',
      state: pointsHere ? 'ok' : targets.length ? 'wrong' : 'missing',
      found: targets.join(', ') || null,
      expected: host,
      critical: true,
      detail: pointsHere
        ? 'Mail for this domain is routed here.'
        : targets.length
          ? `Mail is being delivered to ${targets.join(', ')}, not to us. Nothing sent to this domain reaches these mailboxes.`
          : 'No MX record exists, so nothing on the internet can deliver mail to this domain.',
    })
  } catch {
    checks.push({
      record: 'MX',
      label: 'Mail delivery',
      state: 'missing',
      found: null,
      expected: host,
      critical: true,
      detail:
        'No MX record exists, so nothing on the internet can deliver mail to this domain.',
    })
  }

  // ── SPF ──
  const root = await txtValues(domain)
  const spf = root?.find((v) => v.toLowerCase().startsWith('v=spf1')) ?? null
  checks.push({
    record: 'TXT (SPF)',
    label: 'Who may send as your domain',
    state: spf ? (spf.includes(host) || spf.includes('mx') ? 'ok' : 'wrong') : 'missing',
    found: spf,
    expected: expected.find((r) => r.host === '@' && r.type === 'TXT')?.value || '',
    critical: false,
    detail: spf
      ? spf.includes(host) || spf.includes('mx')
        ? 'Senders can verify mail from this domain.'
        : 'An SPF record exists but does not authorise this mail server, so outgoing mail may be marked as spam.'
      : 'Without SPF, mail sent from this domain is far more likely to land in spam.',
  })

  // ── DKIM ──
  const selector = opts.dkimSelector || 'mail'
  const dkim = await txtValues(`${selector}._domainkey.${domain}`)
  const dkimVal = dkim?.find((v) => v.includes('p=')) ?? null
  checks.push({
    record: 'TXT (DKIM)',
    label: 'Signs your outgoing mail',
    state: dkimVal ? 'ok' : 'missing',
    found: dkimVal ? `${dkimVal.slice(0, 40)}…` : null,
    expected: opts.dkimValue ? `${opts.dkimValue.slice(0, 40)}…` : '(generated for you)',
    critical: false,
    detail: dkimVal
      ? 'Outgoing mail is signed.'
      : 'Without DKIM, receivers cannot verify your mail was not tampered with, and it is more likely to be filtered.',
  })

  // ── DMARC ──
  const dmarc = await txtValues(`_dmarc.${domain}`)
  const dmarcVal = dmarc?.find((v) => v.toLowerCase().startsWith('v=dmarc1')) ?? null
  checks.push({
    record: 'TXT (DMARC)',
    label: 'What to do with failures',
    state: dmarcVal ? 'ok' : 'missing',
    found: dmarcVal,
    expected: expected.find((r) => r.host === '_dmarc')?.value || '',
    critical: false,
    detail: dmarcVal
      ? 'A DMARC policy is published.'
      : 'Without DMARC, nobody can stop others spoofing this domain.',
  })

  const criticalBad = checks.filter((c) => c.critical && c.state !== 'ok')
  const otherBad = checks.filter((c) => !c.critical && c.state !== 'ok')

  return {
    domain,
    deliverable: criticalBad.length === 0,
    checks,
    summary: criticalBad.length
      ? `This domain cannot receive mail — ${criticalBad
          .map((c) => c.record)
          .join(', ')} not set correctly.`
      : otherBad.length
        ? `Mail is being delivered, but ${otherBad
            .map((c) => c.record)
            .join(', ')} still need publishing or your mail may be filtered as spam.`
        : 'All records are published correctly.',
    checkedAt: new Date().toISOString(),
  }
}
