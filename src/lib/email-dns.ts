/**
 * Email DNS record helper.
 *
 * Used by:
 *  - #20 Email DNS helper — generate the standard MX/SPF/DKIM/DMARC records
 *    that a domain needs in order to send and receive mail through APSAMO's
 *    Mailcow instance, plus the A/CNAME records a domain needs in order to
 *    host a website through APSAMO's hosting layer.
 *
 * The records produced here are designed to match what Mailcow itself
 * documents (https://mailcow.github.io/mailcow-dockerized-docs/prerequisite-dns/)
 * so that a domain owner can copy/paste them straight into their DNS provider.
 *
 * This module is pure (no network, no env, no DB) — it only generates strings.
 * Validation (`validateDnsRecords`) works against a caller-provided list of
 * resolved records (e.g. from `src/lib/dns.ts` `getDnsRecords`), so it can be
 * used both for live verification and for "DNS checklist" UIs.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single MX record. */
export interface MxRecord {
  type: 'MX'
  name: string
  value: string
  priority: number
}

/** A single TXT record (SPF, DKIM, DMARC are all TXT). */
export interface TxtRecord {
  type: 'TXT'
  name: string
  value: string
}

/** The four email-related DNS records a fully configured domain needs. */
export interface EmailDnsRecords {
  mx: MxRecord
  spf: TxtRecord
  dmarc: TxtRecord
  /** `name` is e.g. `mail._domainkey.example.com.` */
  dkim: TxtRecord
}

/** A hosting A/CNAME record. */
export interface HostingRecord {
  type: 'A' | 'CNAME'
  name: string
  value: string
}

/** Generic DNS record used by `generateAllDnsRecords` and `validateDnsRecords`. */
export interface DnsRecord {
  type: string
  name: string
  value: string
  priority?: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalise the DKIM public key into a single-line `v=DKIM1; ...; p=<base64>`
 * TXT value.
 *
 * Mailcow's `/get/dkim/{domain}` endpoint returns the public key either as:
 *  - a bare base64 string (just the `p=` portion), or
 *  - the full `v=DKIM1; k=rsa; t=s; s=email; p=<base64>` string (this is what
 *    the demo-mode fake key in src/lib/mailcow.ts produces).
 *
 * Both forms are accepted here; if the input already starts with `v=DKIM1`
 * we treat it as the finished value and just collapse any embedded newlines
 * (DKIM TXT records must be a single logical line — DNS providers split long
 * values into 255-char chunks themselves).
 */
function formatDkimTxtValue(publicKey: string): string {
  const trimmed = publicKey.trim()
  if (/^v=DKIM1/i.test(trimmed)) {
    // Already a full DKIM record — collapse whitespace/newlines.
    return trimmed.replace(/\s+/g, '')
  }
  // Bare base64 — wrap it in the standard DKIM prefix.
  const bare = trimmed.replace(/\s+/g, '')
  return `v=DKIM1; k=rsa; t=s; s=email; p=${bare}`
}

/**
 * Strip a trailing dot from a DNS name so the caller always gets a "bare"
 * hostname. Most DNS providers accept both forms, but mixing them makes
 * equality checks flaky, so we normalise to no trailing dot internally.
 */
function stripTrailingDot(name: string): string {
  return name.replace(/\.+$/, '')
}

// ---------------------------------------------------------------------------
// Email record generation
// ---------------------------------------------------------------------------

/**
 * Generate the standard email DNS records for a domain.
 *
 * @param domain               The apex domain, e.g. `example.com`.
 * @param mailServerHostname   The MX target, e.g. `mail.example.com`.
 * @param dkimPublicKey        (Optional) base64 DKIM public key from Mailcow.
 *                             If omitted, no DKIM record is emitted (the
 *                             returned `dkim` field will have an empty value).
 * @param dkimSelector         (Optional) DKIM selector, default `mail`.
 * @param serverIp             (Optional) hosting server IP. When provided the
 *                             SPF record includes an explicit `ip4:` mechanism
 *                             for the server (recommended); when omitted the
 *                             SPF relies on the `mx` + `a` mechanisms only.
 */
export function generateEmailDnsRecords(
  domain: string,
  mailServerHostname: string,
  dkimPublicKey?: string,
  dkimSelector: string = 'mail',
  serverIp?: string
): EmailDnsRecords {
  const apex = stripTrailingDot(domain.toLowerCase())
  const mxHost = stripTrailingDot(mailServerHostname.toLowerCase())
  const selector = (dkimSelector || 'mail').trim().toLowerCase()

  const mx: MxRecord = {
    type: 'MX',
    name: '@',
    value: `${mxHost}.`,
    priority: 10,
  }

  // SPF: include the server IP explicitly when known so receivers don't have
  // to do extra A/MX lookups. The `mx a` mechanisms stay as a fallback so the
  // record keeps working even if the IP changes.
  const spfValue = serverIp
    ? `v=spf1 mx a ip4:${serverIp} -all`
    : 'v=spf1 mx a -all'

  const spf: TxtRecord = {
    type: 'TXT',
    name: '@',
    value: spfValue,
  }

  const dmarc: TxtRecord = {
    type: 'TXT',
    name: `_dmarc`,
    value:
      `v=DMARC1; p=quarantine; rua=mailto:admin@${apex}; ` +
      `ruf=mailto:admin@${apex}; fo=1`,
  }

  // DKIM is optional — only emit when a public key is provided.
  const dkim: TxtRecord = {
    type: 'TXT',
    name: `${selector}._domainkey`,
    value: dkimPublicKey ? formatDkimTxtValue(dkimPublicKey) : '',
  }

  return { mx, spf, dmarc, dkim }
}

// ---------------------------------------------------------------------------
// Hosting record generation
// ---------------------------------------------------------------------------

/**
 * Generate the DNS records a domain needs in order to host a website on the
 * APSAMO platform:
 *
 *   - A     @    → serverIp           (apex domain)
 *   - A     www  → serverIp           (www subdomain)
 *   - A     mail → serverIp           (mail server on the same box; if the
 *                                      mail server is on a different IP the
 *                                      caller should override this record)
 *
 * The names are returned as relative names (`@`, `www`, `mail`) so they can
 * be pasted straight into most DNS provider UIs. Callers that need absolute
 * names can append `.{domain}.` themselves.
 */
export function generateHostingDnsRecords(
  domain: string,
  serverIp: string
): HostingRecord[] {
  // `domain` is kept for API symmetry & future CNAME generation; the relative
  // names below don't actually need it because DNS providers interpret `@` /
  // bare subdomain names relative to the zone apex.
  void domain
  return [
    { type: 'A', name: '@', value: serverIp },
    { type: 'A', name: 'www', value: serverIp },
    { type: 'A', name: 'mail', value: serverIp },
  ]
}

// ---------------------------------------------------------------------------
// Combined record generation
// ---------------------------------------------------------------------------

/**
 * Generate every DNS record a fully-provisioned APSAMO domain needs:
 * hosting (A records) + email (MX, SPF, DMARC, DKIM).
 *
 * The returned array is in a sensible display order (A records first, then
 * MX, then TXT records), and each entry has a stable shape `{ type, name,
 * value, priority? }` so it can be rendered as a generic table.
 */
export function generateAllDnsRecords(opts: {
  domain: string
  serverIp: string
  mailServerHostname: string
  dkimPublicKey?: string
  dkimSelector?: string
}): DnsRecord[] {
  const {
    domain,
    serverIp,
    mailServerHostname,
    dkimPublicKey,
    dkimSelector,
  } = opts

  const hosting = generateHostingDnsRecords(domain, serverIp)
  const email = generateEmailDnsRecords(
    domain,
    mailServerHostname,
    dkimPublicKey,
    dkimSelector,
    serverIp
  )

  const records: DnsRecord[] = []

  // Hosting A records first
  for (const r of hosting) {
    records.push({ type: r.type, name: r.name, value: r.value })
  }

  // MX
  records.push({
    type: email.mx.type,
    name: email.mx.name,
    value: email.mx.value,
    priority: email.mx.priority,
  })

  // SPF
  records.push({
    type: email.spf.type,
    name: email.spf.name,
    value: email.spf.value,
  })

  // DMARC
  records.push({
    type: email.dmarc.type,
    name: email.dmarc.name,
    value: email.dmarc.value,
  })

  // DKIM (only if a public key was supplied)
  if (email.dkim.value) {
    records.push({
      type: email.dkim.type,
      name: email.dkim.name,
      value: email.dkim.value,
    })
  }

  return records
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Normalise a DNS name for comparison: lowercase, strip trailing dots, and
 * treat `@` as the apex domain. The apex is provided by the caller so we
 * can expand `@` into the actual domain name when needed.
 */
function normaliseName(name: string, apex: string): string {
  const lower = name.trim().toLowerCase().replace(/\.+$/, '')
  if (lower === '@' || lower === '') return apex
  if (lower === apex) return apex
  // If the name is `<sub>.<apex>` keep the sub prefix; if it's just `<sub>`
  // (e.g. "mail" or "www" or "_dmarc"), expand to `<sub>.<apex>`.
  if (lower.endsWith(`.${apex}`)) return lower
  return `${lower}.${apex}`
}

/**
 * Normalise a TXT/MX value for comparison: lowercase, collapse internal
 * whitespace, strip a trailing dot for MX targets. For TXT records we only
 * compare the meaningful prefix (`v=spf1`, `v=dmarc1`, `v=dkim1`) so that
 * small cosmetic differences (extra spaces, trailing `;`, etc.) don't make
 * the validation fail.
 */
function normaliseValue(type: string, value: string): string {
  const lower = value.trim().toLowerCase().replace(/\s+/g, ' ')
  if (type === 'MX') return lower.replace(/\.+$/, '')
  if (type === 'TXT') {
    // Extract the version tag if present (v=spf1|v=dkim1|v=dmarc1).
    const m = lower.match(/^v=(spf1|dkim1|dmarc1)/)
    if (m) return m[1]
    // Otherwise just return the cleaned-up value.
    return lower
  }
  if (type === 'A' || type === 'AAAA') return lower
  if (type === 'CNAME') return lower.replace(/\.+$/, '')
  return lower
}

interface ValidationResult {
  valid: boolean
  missing: string[]
  present: string[]
}

/**
 * Validate that all the DNS records APSAMO expects for a domain are
 * present in a list of resolved records.
 *
 * The expected set is derived from `generateAllDnsRecords` (apex A, www A,
 * mail A, MX, SPF, DMARC, and — if a DKIM public key would have been
 * generated — DKIM). For each expected record we look for a matching entry
 * in the `records` list; matches are based on type + name + a "tag" for TXT
 * records (so SPF/DMARC/DKIM are distinguished by their `v=` prefix rather
 * than by exact string equality, which would be too brittle).
 *
 * @param records  The records actually resolved at the DNS provider
 *                 (typically fetched via `src/lib/dns.ts` `getDnsRecords`).
 * @param domain   The apex domain we're validating against.
 * @param expected (Optional) The expected record set. If omitted, this
 *                 function generates a default set using sensible defaults
 *                 (mail server on the same IP as the apex A record, no
 *                 DKIM). Supply this when you have the real server IP /
 *                 DKIM key available.
 */
export function validateDnsRecords(
  records: Array<{ type: string; name: string; value: string }>,
  domain: string,
  expected?: DnsRecord[]
): ValidationResult {
  const apex = stripTrailingDot(domain.toLowerCase())

  // Default expected set if none provided — matches what
  // generateAllDnsRecords would produce for a self-hosted mail setup with no
  // DKIM key on file.
  const expectedRecords: DnsRecord[] = expected ?? [
    { type: 'A', name: '@', value: '' }, // value left blank → only name+type checked
    { type: 'A', name: 'www', value: '' },
    { type: 'A', name: 'mail', value: '' },
    { type: 'MX', name: '@', value: '', priority: 10 },
    { type: 'TXT', name: '@', value: 'v=spf1' },
    { type: 'TXT', name: '_dmarc', value: 'v=DMARC1' },
  ]

  // Build a lookup of resolved records, normalised for comparison.
  const resolved = records.map((r) => ({
    type: r.type.toUpperCase(),
    name: normaliseName(r.name, apex),
    value: normaliseValue(r.type, r.value),
  }))

  const missing: string[] = []
  const present: string[] = []

  for (const exp of expectedRecords) {
    const expType = exp.type.toUpperCase()
    const expName = normaliseName(exp.name, apex)
    const expValue = normaliseValue(exp.type, exp.value)

    const found = resolved.some((r) => {
      if (r.type !== expType) return false
      if (r.name !== expName) return false
      // If the expected value is blank (e.g. for A records when we don't know
      // the server IP ahead of time), match on type+name only.
      if (!expValue) return true
      // For TXT records we already collapsed both sides to just the v= tag
      // (spf1|dkim1|dmarc1) in normaliseValue, so a substring match is enough.
      if (expType === 'TXT') {
        return r.value === expValue
      }
      // For MX records, also compare the target hostname (ignoring priority,
      // since some providers return priority as a separate field).
      if (expType === 'MX') {
        return r.value === expValue || r.value.includes(expValue)
      }
      // For A/CNAME records require an exact value match.
      return r.value === expValue
    })

    const label = `${expType} ${exp.name === '@' ? apex : exp.name}${
      expValue ? ` → ${exp.value}` : ''
    }`
    if (found) {
      present.push(label)
    } else {
      missing.push(label)
    }
  }

  return {
    valid: missing.length === 0,
    missing,
    present,
  }
}
