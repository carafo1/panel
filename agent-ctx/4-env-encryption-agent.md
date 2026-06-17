---
Task ID: 4
Agent: Env Encryption Agent
Task: Integrate env var encryption into hosting routes

Work Log:
- Read worklog.md, encryption.ts (AES-256-GCM encrypt/decrypt helpers from Wave 1), existing env route.ts (GET/POST), env/[varId]/route.ts (PATCH/DELETE), and hosting-panel.tsx env var section.
- Updated `src/app/api/hosting/[id]/env/route.ts`:
  - Imported `encrypt`, `decrypt` from `@/lib/encryption`.
  - Changed `maskValue` format from `****last4` to `first2 + ****` (e.g. `sk****`) per task spec, with `****` fallback for very short values.
  - Added `revealValue(stored, encrypted)` helper that decrypts when the `encrypted` flag is true and gracefully falls back to the raw stored value (legacy) on decrypt failure, so old unencrypted rows still render.
  - GET: decrypts each row before returning; returns plaintext only when `?reveal=true`, otherwise returns the masked form.
  - POST: always calls `encrypt(value)` before persisting, forces `encrypted: true`. The client-provided `encrypted` flag is ignored. Response returns the masked plaintext (not the ciphertext).
- Updated `src/app/api/hosting/[id]/env/[varId]/route.ts`:
  - Imported `encrypt`, `decrypt` and added the same `maskValue` + `revealValue` helpers.
  - PATCH: when a new `value` is provided, encrypts it and sets `encrypted: true`. If `value` is omitted, existing stored value/encrypted flag is preserved. Response decrypts and masks the (possibly updated) stored value.
  - DELETE: unchanged.
- Updated `src/components/hosting/hosting-panel.tsx`:
  - Replaced the "Encrypted" Switch in the env var create/edit dialog with an emerald info card stating "Encrypted at rest with AES-256-GCM" + descriptive subtext. Encryption is now always on (transparent), so the user toggle is no longer needed.
  - Added an "AES-256" Badge with Lock icon next to the Environment Variables card title and updated the card description to mention encryption at rest.
  - Kept the existing Reveal/Hide button (already fetches with `?reveal=true`), the per-row Encrypted/Plain badge, and the lock icon indicator.
- Did not run lint/build per task instructions. Verified dev.log shows no compile errors after edits.

Stage Summary:
- Env var values are now transparently encrypted at rest with AES-256-GCM via the Wave 1 `encryption.ts` library.
- GET returns masked (`sk****`) values by default and plaintext only when `?reveal=true` is passed.
- POST/PATCH encrypt on write and set `encrypted=true`; legacy unencrypted rows are still readable (graceful fallback).
- UI clearly communicates encryption status with an AES-256 badge in the header and an info card in the dialog, replacing the now-redundant user encryption toggle.
- Existing functionality (CRUD, auth, project ownership checks, duplicate-key validation, reveal toggle) remains intact.

Files Modified:
1. `src/app/api/hosting/[id]/env/route.ts`
2. `src/app/api/hosting/[id]/env/[varId]/route.ts`
3. `src/components/hosting/hosting-panel.tsx`

Notes for Downstream Agents:
- The `EnvironmentVariable.encrypted` boolean is now a server-controlled flag indicating whether the stored `value` is an AES-256-GCM base64 payload. New rows are always encrypted.
- Any code that reads `EnvironmentVariable.value` directly from the DB must call `decrypt()` (gated on the `encrypted` flag) to get the plaintext. Use the `revealValue(stored, encrypted)` pattern from these routes as the canonical helper.
- The `?reveal=true` query param on GET returns plaintext over the wire - treat the response as sensitive and only request it from trusted, authenticated UI flows.
- The client `envEncrypted` state in hosting-panel.tsx is now legacy dead-data sent in the request body; the server ignores it. Safe to remove in a future cleanup but leaving it avoids breaking unrelated code paths.
