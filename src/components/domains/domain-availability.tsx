'use client'

/**
 * Shared, honest presentation of domain availability and domain lifecycle
 * states, used by every search box and domain list in the customer UI.
 *
 * Contract (GET/POST /api/domains/search, GET /api/provisioning/check-domain):
 *   status     'available' | 'unavailable' | 'premium' | 'unknown'
 *   available  true | false | null (null = registrar did not answer)
 *   sellable   true only when available AND the TLD has an active price row
 *   price / registrationPrice  only present for sellable results
 *   503        registrar unreachable / not configured ("availability unknown")
 *   429        rate limited ({ error, message, retryAfter })
 *
 * The rule enforced here: a result is buyable only when it is `available`
 * AND carries a positive price. Premium, unknown, unpriced and taken results
 * never show a price or a buy action.
 */
import { CheckCircle2, XCircle, Sparkles, HelpCircle, Ban } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { ApiRequestError } from '@/store/auth-store'
import { cn } from '@/lib/utils'

export type AvailabilityState = 'available' | 'not_sold' | 'unavailable' | 'premium' | 'unknown'

export interface AvailabilityInput {
  status?: string | null
  available?: boolean | null
  premium?: boolean | null
  sellable?: boolean | null
  /** Registration price in whichever field the endpoint uses. */
  price?: number | null
}

/** Classify one search result. Unknown is the default for anything unclear. */
export function availabilityOf(r: AvailabilityInput): AvailabilityState {
  const status = r.status ?? null
  if (status === 'unknown' || r.available === null) return 'unknown'
  if (status === 'premium' || r.premium) return 'premium'
  if (status === 'unavailable') return 'unavailable'
  if (status === 'available' || (status === null && r.available === true)) {
    const priced = typeof r.price === 'number' && r.price > 0
    if (r.sellable === false || !priced) return 'not_sold'
    return 'available'
  }
  if (status === null && r.available === false) return 'unavailable'
  return 'unknown'
}

/** Only an available, priced domain may be added to a cart or bought. */
export function isPurchasable(r: AvailabilityInput): boolean {
  return availabilityOf(r) === 'available'
}

export const AVAILABILITY_COPY: Record<AvailabilityState, { label: string; detail: string }> = {
  available: { label: 'Available', detail: 'Ready to register.' },
  not_sold: {
    label: 'Not sold here',
    detail: 'This name is free, but we do not currently sell this extension.',
  },
  unavailable: { label: 'Taken', detail: 'Someone has already registered this name.' },
  premium: {
    label: 'Premium',
    detail: 'This is a premium name and cannot be purchased here.',
  },
  unknown: {
    label: 'Couldn’t check',
    detail: 'We couldn’t confirm availability right now. Please try again in a moment.',
  },
}

const BADGE_STYLE: Record<AvailabilityState, string> = {
  available: 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
  not_sold: 'bg-gray-500/15 text-gray-600 dark:text-gray-400 border-gray-500/30',
  unavailable: 'bg-gray-500/15 text-gray-600 dark:text-gray-400 border-gray-500/30',
  premium: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  unknown: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
}

const ICON: Record<AvailabilityState, React.ElementType> = {
  available: CheckCircle2,
  not_sold: Ban,
  unavailable: XCircle,
  premium: Sparkles,
  unknown: HelpCircle,
}

/** Icon + text badge, so the state never depends on colour alone. */
export function AvailabilityBadge({
  state,
  className,
}: {
  state: AvailabilityState
  className?: string
}) {
  const Icon = ICON[state]
  return (
    <Badge variant="outline" className={cn(BADGE_STYLE[state], className)}>
      <Icon className="h-3 w-3 me-1" aria-hidden="true" />
      {AVAILABILITY_COPY[state].label}
    </Badge>
  )
}

export function AvailabilityIcon({ state, className }: { state: AvailabilityState; className?: string }) {
  const Icon = ICON[state]
  return <Icon className={className} aria-hidden="true" />
}

/**
 * Turn a failed availability lookup into something a customer can act on.
 * Accepts an ApiRequestError, a plain Error, or an HTTP status + body (for
 * callers that use `fetch` directly).
 */
export function availabilityErrorMessage(
  err: unknown,
  fallback = 'Something went wrong while checking that domain. Please try again.'
): string {
  const status = err instanceof ApiRequestError ? err.status : undefined
  if (status === 429) {
    const wait = err instanceof ApiRequestError ? err.retryAfter : undefined
    return wait
      ? `You’re searching a little fast. Please wait ${wait} second${wait === 1 ? '' : 's'} and try again.`
      : 'You’re searching a little fast. Please wait a moment and try again.'
  }
  if (status === 503 || status === 502 || status === 504) {
    return AVAILABILITY_COPY.unknown.detail
  }
  if (status === 400 && err instanceof Error && err.message) return err.message
  if (status && status >= 500) return fallback
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/** Same as above for raw `fetch` responses. */
export function availabilityErrorFromResponse(status: number, body: unknown): string {
  return availabilityErrorMessage(new ApiRequestError(status, body))
}

// ─── Domain lifecycle (Domain rows and domain orders) ────────────────────────

/**
 * Wording for Domain.status, DomainOrder.status and the connection states the
 * /api/domains list derives for external domains. Nothing reads as
 * "registered" before the domain is actually active.
 */
export function domainStatusLabel(status: string): string {
  switch (status) {
    case 'active': return 'Active'
    case 'completed': return 'Active'
    case 'connected': return 'Connected'
    case 'pending_dns': return 'Awaiting DNS'
    case 'not_connected': return 'Not connected'
    case 'pending_verification': return 'Pending verification'
    case 'pending_payment': return 'Awaiting payment'
    case 'pending': return 'Pending'
    case 'processing': return 'Registering'
    case 'retry_pending': return 'Retrying'
    case 'transfer_pending':
    case 'transferring': return 'Transfer in progress'
    case 'manual_review': return 'Being checked by our team'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
    case 'expired': return 'Expired'
    case 'suspended': return 'Suspended'
    case 'deleted': return 'Deleted'
    default: return status ? status.replace(/_/g, ' ') : 'Unknown'
  }
}

export function domainStatusColor(status: string): string {
  switch (status) {
    case 'active': case 'completed': case 'connected':
      return 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
    case 'pending': case 'pending_payment': case 'pending_verification': case 'pending_dns':
    case 'processing': case 'retry_pending': case 'transfer_pending': case 'transferring':
    case 'manual_review':
      return 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30'
    case 'failed': case 'expired': case 'suspended': case 'deleted':
      return 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30'
    default:
      return 'bg-gray-500/15 text-gray-600 dark:text-gray-400 border-gray-500/30'
  }
}

/** One sentence explaining a non-final state, or null when none is needed. */
export function domainStatusHint(status: string): string | null {
  switch (status) {
    case 'pending': case 'pending_payment':
      return 'Waiting for payment to be confirmed before we register it.'
    case 'processing': case 'retry_pending':
      return 'We are registering this domain now.'
    case 'transfer_pending': case 'transferring':
      return 'The transfer has been accepted and usually completes within 5–7 days.'
    case 'manual_review':
      return 'Our team is confirming this order with the registry. No action is needed from you.'
    case 'failed':
      return 'This order could not be completed. Contact support and we will sort it out.'
    default:
      return null
  }
}
