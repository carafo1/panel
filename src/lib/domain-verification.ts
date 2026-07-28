/**
 * Domain ownership verification
 * =============================
 *
 * Selling email hosting for a domain means accepting that domain's mail. Doing
 * that on the buyer's say-so alone lets anyone claim a domain they don't own:
 * they can't intercept mail without also controlling its MX, but they CAN take
 * the domain in our system and lock the rightful owner out of ever buying it
 * (`EmailService.domain` is globally unique).
 *
 * Proof is a DNS TXT record only the domain's real operator can publish. The
 * token is a keyed hash of (user, domain), so it is:
 *   - specific to one buyer — publishing it does not let anyone else claim it
 *   - stateless, needing no pending-verification table or expiry sweep
 *   - stable, so a customer can publish it once and retry whenever
 *
 * A domain already registered to the buyer inside the panel is accepted
 * without DNS: we are its registrar, which is stronger proof than a TXT record.
 */
import crypto from 'crypto'
import { promises as dns } from 'dns'
import { db } from '@/lib/db'

/** Subdomain the TXT record is published at. */
const VERIFY_HOST_PREFIX = '_apsamo-verify'
const VALUE_PREFIX = 'apsamo-domain-verification='

function secret(): string {
  // JWT_SECRET is required at boot, so it is always present. This is a
  // low-value token (it proves DNS control, not identity) and a rotation
  // simply means customers republish, so no separate secret is warranted.
  return process.env.JWT_SECRET || 'apsamo-dev-verification-secret'
}

export function normaliseDomainName(value: string): string {
  return value.toLowerCase().trim().replace(/\.+$/, '')
}

/** The token a given user must publish for a given domain. */
export function verificationToken(userId: string, domain: string): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`${userId}:${normaliseDomainName(domain)}`)
    .digest('hex')
    .slice(0, 40)
}

export interface VerificationRecord {
  type: 'TXT'
  host: string
  /** Host as most DNS panels want it — relative to the zone. */
  name: string
  value: string
}

export function verificationRecord(
  userId: string,
  domain: string
): VerificationRecord {
  const d = normaliseDomainName(domain)
  return {
    type: 'TXT',
    host: `${VERIFY_HOST_PREFIX}.${d}`,
    name: VERIFY_HOST_PREFIX,
    value: `${VALUE_PREFIX}${verificationToken(userId, d)}`,
  }
}

/** True when the panel already knows this domain belongs to this user. */
export async function isDomainOwnedInPanel(
  userId: string,
  domain: string
): Promise<boolean> {
  const d = normaliseDomainName(domain)
  const [owned, service] = await Promise.all([
    db.domain.findFirst({ where: { name: d, userId }, select: { id: true } }),
    db.emailService.findFirst({
      where: { domain: d, userId },
      select: { id: true },
    }),
  ])
  return Boolean(owned || service)
}

export interface OwnershipCheck {
  verified: boolean
  /** Why it failed, safe to show the customer. */
  reason?: string
  record: VerificationRecord
}

/**
 * Look up the TXT record and compare it to the expected token.
 *
 * DNS failures are reported as "not verified yet" rather than as errors:
 * NXDOMAIN simply means the record has not been published (or hasn't
 * propagated), which is the normal state while a customer is setting up.
 */
export async function checkDomainOwnership(
  userId: string,
  domain: string
): Promise<OwnershipCheck> {
  const record = verificationRecord(userId, domain)

  let records: string[][]
  try {
    records = await dns.resolveTxt(record.host)
  } catch (err) {
    const code = (err as { code?: string })?.code
    return {
      verified: false,
      reason:
        code === 'ENOTFOUND' || code === 'ENODATA'
          ? 'No verification record found yet. DNS changes can take a few minutes to appear.'
          : 'Could not read DNS for this domain yet. Please try again shortly.',
      record,
    }
  }

  // Each answer is an array of strings that must be concatenated: long TXT
  // values are split into 255-byte chunks by the protocol.
  const found = records.map((chunks) => chunks.join('').trim())
  const expected = record.value.trim()
  if (found.some((v) => v === expected)) {
    return { verified: true, record }
  }

  return {
    verified: false,
    reason: found.length
      ? 'A verification record exists but does not match. Check it was copied exactly.'
      : 'No verification record found yet.',
    record,
  }
}

/**
 * The single gate used before selling or provisioning email for a domain:
 * either the panel already knows it is theirs, or DNS proves it.
 */
export async function assertDomainControl(
  userId: string,
  domain: string
): Promise<OwnershipCheck> {
  if (await isDomainOwnedInPanel(userId, domain)) {
    return { verified: true, record: verificationRecord(userId, domain) }
  }
  return checkDomainOwnership(userId, domain)
}
