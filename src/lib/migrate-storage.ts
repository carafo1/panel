/**
 * One-time migration: rename localStorage/sessionStorage keys from deployhub_* to apsamo_*.
 *
 * Idempotent — safe to run on every app load. Calling it again after the first
 * run is a no-op because the old keys have already been removed.
 *
 * Preserves user sessions (auth JWT token), onboarding state, notification
 * preferences, billing checkout state, and 2FA pending state so existing users
 * are not logged out or disrupted by the DeployHub → APSAMO rebrand.
 *
 * Strategy per key:
 *  - If old key exists and new key does NOT exist → copy old → new, then delete old.
 *  - If BOTH exist (e.g. user logged in on a partially-migrated browser) → keep
 *    the new value, delete the old (no stale duplicates).
 *  - If only new exists → nothing to do.
 *  - If only old exists but storage access throws (private browsing / disabled
 *    cookies) → silently ignore; the app continues with empty storage.
 */
const KEY_MIGRATIONS: Array<{ from: string; to: string; storage: 'local' | 'session' }> = [
  // (Login tokens are no longer kept in storage at all — see
  // upgradeLegacySession in src/store/auth-store.ts.)
  { from: 'deployhub_onboarding_complete', to: 'apsamo_onboarding_complete', storage: 'local' },
  { from: 'deployhub_notification_prefs', to: 'apsamo_notification_prefs', storage: 'local' },
  { from: 'deployhub_pending_checkout', to: 'apsamo_pending_checkout', storage: 'session' },
  { from: 'deployhub_2fa_pending', to: 'apsamo_2fa_pending', storage: 'local' },
]

export function migrateStorageKeys(): { migrated: number; skipped: number } {
  if (typeof window === 'undefined') return { migrated: 0, skipped: 0 }
  let migrated = 0
  let skipped = 0
  for (const { from, to, storage } of KEY_MIGRATIONS) {
    try {
      const store = storage === 'local' ? localStorage : sessionStorage
      const oldValue = store.getItem(from)
      const newValue = store.getItem(to)
      if (oldValue !== null && newValue === null) {
        store.setItem(to, oldValue)
        store.removeItem(from)
        migrated++
      } else if (oldValue !== null && newValue !== null) {
        // Both exist — keep new, delete old
        store.removeItem(from)
        skipped++
      }
    } catch {
      // storage access might throw in private browsing — ignore
    }
  }
  return { migrated, skipped }
}
