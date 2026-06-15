# Task ID: 19 - Settings Page Agent

## Task: Build Settings page with profile, security, API keys, and notification preferences

## Work Completed

### API Endpoints Created

1. **`/src/app/api/user/profile/route.ts`** - PATCH
   - Updates user name and/or email
   - Validates email format and uniqueness
   - Resets `emailVerified` to false when email changes
   - Auth required via JWT token verification

2. **`/src/app/api/user/password/route.ts`** - PATCH
   - Requires `currentPassword` and `newPassword`
   - Verifies current password using `verifyPassword` from `@/lib/auth`
   - Hashes new password using `hashPassword` from `@/lib/auth`
   - Minimum 8 character validation for new password
   - Auth required

3. **`/src/app/api/user/api-keys/route.ts`** - GET and POST
   - GET: Lists all API keys for user (only shows prefix, not full key)
   - POST: Creates new API key with `dh_` prefix using `crypto.randomBytes(32)`
   - Full key returned only once upon creation
   - Auth required

4. **`/src/app/api/user/api-keys/[keyId]/route.ts`** - DELETE
   - Deletes an API key by ID
   - Ownership verification - users can only delete their own keys
   - Auth required

### Settings Panel Component

Created `/src/components/settings/settings-panel.tsx` with 4 tabs using shadcn Tabs:

1. **Profile Tab**: Name/email inputs (pre-filled), avatar with first letter, email change warning, verified badge display
2. **Security Tab**: Password change form with show/hide toggles, visual password strength indicator (weak → very strong), confirm password matching validation
3. **API Keys Tab**: Key listing with prefix masking, create dialog, one-time key display with copy button and warning, delete with AlertDialog confirmation, empty state
4. **Notifications Tab**: 5 toggle preferences (deployment, domain, billing, security alerts, email digest) stored in localStorage, save functionality

### Dashboard Integration

- Added `'settings'` to `DashboardTab` type in `/src/store/app-store.ts`
- Added Settings nav item with `Settings` icon to `NAV_ITEMS` array in `/src/app/page.tsx`
- Added `case 'settings': return <SettingsPanel />` to `renderPanel()` switch
- Imported `SettingsPanel` component and `Settings` icon from lucide-react

## Verification

- Lint passes cleanly (`bun run lint` - no errors)
- Dev server compiling without errors
- All API endpoints follow existing auth patterns
