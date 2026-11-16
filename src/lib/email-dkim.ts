/**
 * src/lib/email-dkim.ts
 * ════════════════════════════════════════════════════════════════════════════
 * The ONE place the panel looks up a domain's real DKIM key in Mailcow.
 *
 * Every screen that offers email DNS records must publish the real key or no
 * DKIM record at all. A placeholder value published to DNS is worse than none:
 * receivers treat the broken signature key as a failure and mail goes to spam.
 * ════════════════════════════════════════════════════════════════════════════
 */
import type { MailcowDkimInput } from '@/lib/email-dns'
import { getDomain, isMailcowConfigured } from '@/lib/mailcow'

export type DkimLookup =
  | { ok: true; dkim: MailcowDkimInput }
  | { ok: false; reason: 'mailcow_not_configured' | 'no_key' | 'lookup_failed' }

/** Human-readable explanation for a failed lookup, safe to show a customer. */
export const DKIM_REASON_TEXT: Record<Exclude<DkimLookup, { ok: true }>['reason'], string> = {
  mailcow_not_configured:
    'Email hosting is not connected on this server yet, so there is no DKIM key to publish.',
  no_key:
    'This domain has no DKIM key yet. Set up email hosting for it first; the key is created then.',
  lookup_failed: 'The mail server could not be reached to read the DKIM key. Please try again shortly.',
}

/** Look up the DKIM keypair for `domain`. Never throws. */
export async function lookupMailcowDkim(domain: string): Promise<DkimLookup> {
  if (!isMailcowConfigured()) return { ok: false, reason: 'mailcow_not_configured' }
  try {
    const result = await getDomain(domain)
    if (!result.success) {
      // Not in Mailcow at all = email hosting was never set up for it.
      return { ok: false, reason: /not found/i.test(result.error || '') ? 'no_key' : 'lookup_failed' }
    }
    const dkim = result.domain?.dkim
    if (!dkim?.public) return { ok: false, reason: 'no_key' }
    return { ok: true, dkim: { selector: dkim.selector || 'mail', publicKey: dkim.public } }
  } catch (err) {
    console.error('[email-dkim] Mailcow DKIM lookup failed:', err instanceof Error ? err.message : String(err))
    return { ok: false, reason: 'lookup_failed' }
  }
}
