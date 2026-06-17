# Task 7 — 2FA Agent

## Goal
Implement Two-Factor Authentication (TOTP) for the DeployHub platform, including setup/disable UI, login challenge flow, and single-use backup codes.

## What I built

### Backend (`src/app/api/auth/2fa/*`)
- **setup/route.ts** — POST, requires auth. Generates a fresh TOTP secret + QR code data URL via `generateSecret()` / `generateQRCode()` from `@/lib/totp`. Does NOT persist the secret; the client must round-trip it through `/verify` so half-enrolled states are impossible.
- **verify/route.ts** — POST, requires auth. Body: `{ secret, token }`. Verifies the token, then persists `twoFactorSecret`, sets `twoFactorEnabled=true`, and stores 10 bcrypt-hashed backup codes (`hashBackupCodes()`). Returns the plaintext backup codes exactly once.
- **disable/route.ts** — POST, requires auth. Body: `{ token }`. Requires a valid TOTP token from the user's existing authenticator so a stolen session can't silently disable 2FA. Clears secret + backup codes.
- **verify-backup/route.ts** — POST. Body: `{ email, backupCode }`. For login with a backup code when the user has lost their authenticator. Uses `consumeBackupCode()` so the code is removed in the same transaction; issues a full 7-day JWT.
- **login-verify/route.ts** — POST. Body: `{ tempToken, token }`. Second step of 2FA login. Verifies the 5-minute `tempToken`, then the TOTP code, then issues the full 7-day JWT and returns the user record.

### Login route update (`src/app/api/auth/login/route.ts`)
- After password verification, checks `user.twoFactorEnabled`. If enabled, returns `{ requiresTwoFactor: true, tempToken }` instead of the session JWT. The temp token is a JWT signed with `kind: '2fa-temp'`, expires in 5 minutes, and carries only the `userId`.

### Auth helpers (`src/lib/auth.ts`)
- `generateTwoFactorTempToken(userId)` — short-lived JWT (5m) for the 2FA login flow.
- `verifyTwoFactorTempToken(token)` — validates the temp token and confirms the `kind` claim.

### Auth store (`src/store/auth-store.ts`)
- `login()` now returns a discriminated union: `{ requiresTwoFactor: true, tempToken } | { requiresTwoFactor: false, user, token }`. The modal inspects this to decide whether to show the 2FA input.
- Added `completeTwoFactorLogin(tempToken, token)` and `loginWithBackupCode(email, backupCode)` actions.
- `User` interface now includes optional `twoFactorEnabled`.

### Auth modal (`src/components/auth/auth-modal.tsx`)
- Added `'two-factor'` mode (also added to the `AuthMode` union in `src/store/app-store.ts`).
- Uses shadcn `InputOTP` / `InputOTPGroup` / `InputOTPSlot` for the 6-digit code entry.
- "Use a backup code instead" link flips to a backup-code input.
- "Back to sign in" link clears state and returns to the password screen.

### Settings panel (`src/components/settings/settings-panel.tsx`)
- New `TwoFactorSection` card placed under the existing "Change Password" card in the Security tab.
- Shows enabled/disabled status with an icon + badge.
- **Enable flow**: dialog with QR code image, manual-entry code (with copy button), 6-digit verify input. On success, transitions to a "Save your backup codes" view with Download (.txt) and Copy All buttons.
- **Disable flow**: separate dialog requiring a valid TOTP code, with an amber warning alert.
- Refreshes the 2FA status from `/api/auth/me` on mount (the `/me` endpoint now returns `twoFactorEnabled`).

## Dependency change
- Downgraded `otplib` from v13.4.1 → v12.0.1. The provided `src/lib/totp.ts` (from Wave 1) uses the v12 `authenticator` API (`authenticator.options`, `authenticator.keyuri`, `authenticator.verify({ token, secret })`), which doesn't exist in v13. Downgrading keeps `totp.ts` untouched as the task instructions require.

## End-to-end verification (manual)
Ran a Node script against the live dev server that exercised the full lifecycle:
1. Login → 200, normal session
2. Setup → 200, secret (16 chars) + QR data URL
3. Generate TOTP token from secret
4. Verify → 200, 10 backup codes returned
5. Login again → 200, `{ requiresTwoFactor: true, tempToken }`
6. Login-verify → 200, full JWT + user
7. Backup-code login → 200, JWT
7b. Reuse same backup code → 401 (single-use confirmed)
8. Disable 2FA → 200
9. Final login → 200, no 2FA challenge

All steps passed. Backward compatibility confirmed: users without 2FA still log in normally with a single password step.

## Files touched
- `src/lib/auth.ts` (added 2 helpers)
- `src/app/api/auth/login/route.ts` (added 2FA gate)
- `src/app/api/auth/me/route.ts` (added `twoFactorEnabled` to response)
- `src/store/auth-store.ts` (login returns union, added 2FA actions)
- `src/store/app-store.ts` (added `'two-factor'` to AuthMode)
- `src/components/auth/auth-modal.tsx` (added 2FA + backup-code screens)
- `src/components/settings/settings-panel.tsx` (added TwoFactorSection)
- `src/app/api/auth/2fa/setup/route.ts` (new)
- `src/app/api/auth/2fa/verify/route.ts` (new)
- `src/app/api/auth/2fa/disable/route.ts` (new)
- `src/app/api/auth/2fa/verify-backup/route.ts` (new)
- `src/app/api/auth/2fa/login-verify/route.ts` (new)
- `package.json` + `bun.lock` (otplib downgrade)

## Notes for downstream agents
- The `tempToken` returned from `/api/auth/login` for 2FA users expires in 5 minutes. The auth-modal handles expiry by surfacing the API's "Your session has expired" error to the user.
- Backup codes are stored as a JSON array of bcrypt hashes in `User.twoFactorBackupCodes`. They can never be retrieved again after enable — the UI must prompt the user to save them.
- The 2FA status is now part of the `/api/auth/me` response (`user.twoFactorEnabled`). Any component that caches the user object should refresh from `/me` after toggling 2FA.
