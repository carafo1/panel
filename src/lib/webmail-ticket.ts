/**
 * Single-use tickets for browser-opened webmail sign-in.
 *
 * The webmail SSO page is opened by the browser (a link or window.open), which
 * cannot attach the panel's Authorization header — so the URL itself has to
 * carry proof. A ticket is that proof: it is minted only after the normal
 * Bearer-authenticated check has confirmed the caller owns the mailbox.
 *
 * Deliberately in-memory rather than a database table:
 *   - it must not outlive the process, and a crash should invalidate everything
 *   - it is consumed within seconds, so persistence buys nothing
 *   - nothing here is worth recovering after a restart
 *
 * A ticket is worthless on its own — it names a mailbox but carries no
 * credential — yet it is still treated as a secret: 32 random bytes, single
 * use, and short-lived, so a leaked link in a chat log or shoulder-surfed URL
 * is dead long before anyone could try it.
 */
import crypto from 'crypto'

interface Ticket {
  userId: string
  serviceId: string
  address: string
  expiresAt: number
}

const TTL_MS = 30_000
const tickets = new Map<string, Ticket>()

/** Drop anything expired. Cheap, and keeps the map from growing unbounded. */
function sweep(now: number): void {
  for (const [key, t] of tickets) {
    if (t.expiresAt <= now) tickets.delete(key)
  }
}

export function issueWebmailTicket(claim: {
  userId: string
  serviceId: string
  address: string
}): { ticket: string; expiresInSeconds: number } {
  const now = Date.now()
  sweep(now)

  const ticket = crypto.randomBytes(32).toString('base64url')
  tickets.set(ticket, {
    userId: claim.userId,
    serviceId: claim.serviceId,
    address: claim.address.toLowerCase().trim(),
    expiresAt: now + TTL_MS,
  })
  return { ticket, expiresInSeconds: Math.floor(TTL_MS / 1000) }
}

/**
 * Redeem a ticket. Returns null if unknown, expired, or already used —
 * redemption deletes it, so a replayed URL fails even within the window.
 */
export function consumeWebmailTicket(ticket: string): Ticket | null {
  if (!ticket) return null
  const now = Date.now()
  const found = tickets.get(ticket)
  if (!found) return null

  // Consume unconditionally: an expired ticket should not linger either.
  tickets.delete(ticket)
  if (found.expiresAt <= now) return null
  return found
}
