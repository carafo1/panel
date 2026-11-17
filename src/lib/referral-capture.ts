/**
 * Browser side of referral links: remember ?ref=CODE (for 30 days) until the
 * visitor registers, then send it with the sign-up. Storage can be blocked,
 * so every access is guarded — a referral must never break the page.
 */
const KEY = 'apsamo_ref'
const TTL_MS = 30 * 86400_000

export function captureReferralCode(): void {
  if (typeof window === 'undefined') return
  try {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('ref')
    if (!code || !/^[A-Za-z0-9]{6,12}$/.test(code)) return
    localStorage.setItem(KEY, JSON.stringify({ code: code.toUpperCase(), at: Date.now() }))
    params.delete('ref')
    const qs = params.toString()
    history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash)
  } catch {
    /* storage unavailable */
  }
}

export function readReferralCode(): string | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return undefined
    const { code, at } = JSON.parse(raw) as { code?: string; at?: number }
    if (!code || !at || Date.now() - at > TTL_MS) {
      localStorage.removeItem(KEY)
      return undefined
    }
    return code
  } catch {
    return undefined
  }
}
