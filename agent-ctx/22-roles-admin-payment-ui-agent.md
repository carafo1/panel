# Task 22 — Roles + Admin Payment UI Agent

## Goal
1. Update the admin panel to add a Payment Methods management section for super admins.
2. Update the auth system to properly handle the `super_admin` role (alongside `admin`).
3. Create a super-admin settings panel (Payment Methods panel).
4. Allow super_admin to manage user roles.
5. Wire the billing checkout UI to the multi-payment-method system (Stripe / Waafi / Manual).

## Files Read (for context)
- `/home/z/my-project/worklog.md` (last 200 lines) — understood tasks 16/17/18/19/20 — PaymentMethodSetting model + multi-payment billing lib + admin routes already existed.
- `/home/z/my-project/src/components/admin/admin-panel.tsx` — admin panel structure (Tabs: Users / Jobs / Servers), RoleBadge helper, fetchAll pattern.
- `/home/z/my-project/src/app/api/admin/stats/route.ts` — admin auth pattern (`if (decoded.role !== 'admin') return 403`).
- `/home/z/my-project/src/lib/auth.ts` — `verifyToken`/`extractTokenFromHeader` helpers; role stored in JWT payload as string.
- `/home/z/my-project/src/components/billing/billing-panel.tsx` (first ~100 lines + CheckoutDialog) — existing Stripe-only checkout flow.
- `/home/z/my-project/src/app/api/admin/payment-methods/route.ts` + `[method]/route.ts` — already required super_admin (with admin fallback).
- `/home/z/my-project/src/lib/payment-methods.ts` — `getActivePaymentMethods` + `processPayment` dispatch table.
- `/home/z/my-project/src/app/api/billing/methods/route.ts` — public GET endpoint returning active methods.
- `/home/z/my-project/src/app/api/billing/checkout/route.ts` — accepts `method` in body; returns either demo-mode success payload or unified `{ status, redirectUrl, transactionId }` shape.
- `/home/z/my-project/prisma/schema.prisma` (User model + PaymentMethodSetting model) — User.role comment lists `"super_admin", "client", "user", "admin"`.

## Files Created

### `/home/z/my-project/src/components/admin/payment-methods-panel.tsx` (~360 LOC)
Super-admin-only panel rendered inside the Admin tab.
- Lists every payment method (stripe, waafi, manual) as a Card with: icon, display name, `active` Switch toggle, Configure button.
- Switch calls `PATCH /api/admin/payment-methods/[method]` with `{ active: boolean }`.
- Configure opens a `Dialog` to edit: Display name, Icon key, Sort order, and a JSON textarea for method-specific config (Waafi merchantId, Manual bank details, Stripe empty). JSON is validated client-side before sending.
- Header shows live active-count Badge (green / yellow / red based on count).
- Warning shown inline when disabling the last active method (browser `confirm` with explicit warning).
- Warning banner shown when zero methods are active ("Users will not be able to complete checkout").
- Per-method inline "Last active method" warning.
- Icons resolved via `getMethodIcon(method, icon)` map — falls back to method-based default (Stripe → CreditCard, Waafi → Wallet, Manual → Building).
- Uses shadcn/ui: Card, Switch, Button, Dialog, Input, Label, Badge, Textarea, Skeleton.
- Lucide icons: CreditCard, Wallet, Building, Settings, AlertTriangle, Loader2, RefreshCw.

### `/home/z/my-project/src/app/api/admin/users/[userId]/role/route.ts` (~155 LOC)
- `PATCH /api/admin/users/[userId]/role` with body `{ role: "super_admin" | "admin" | "client" | "user" }`.
- Auth: `super_admin` ONLY — `admin` role is explicitly NOT allowed to change roles (prevents privilege escalation).
- Prevents self role-change (`userId === decoded.userId` → 400 "You cannot change your own role").
- Validates role against `VALID_ROLES` whitelist.
- Returns the refreshed user record `{ id, name, email, role }`.
- Writes an `admin.user.role.update` audit log entry with previousRole + newRole + target email.
- No-op short-circuit when role is unchanged (avoids audit spam).

## Files Modified

### `/home/z/my-project/src/components/admin/admin-panel.tsx`
- Added imports: `DropdownMenu*` (5 parts), `CreditCard`, `ChevronDown`, `Crown`, `User as UserIcon`, `Building2`, `useAuthStore`, `PaymentMethodsPanel`.
- Replaced the binary `RoleBadge` with a 4-role system:
  - `ROLE_STYLES` map: `super_admin` (purple, Crown), `admin` (emerald, ShieldCheck), `client` (blue, Building2), `user` (gray, User).
  - `roleLabel()` helper for human-readable labels ("Super Admin", "Admin", "Client", "User").
- Added viewer-role awareness via `useAuthStore`: `currentRole`, `currentUserId`, `isSuperAdmin`.
- Added `roleLoading` state + `handleChangeRole()` that calls the new PATCH endpoint and updates the local users array optimistically.
- Added "Payment Methods" tab trigger (only rendered when `isSuperAdmin`).
- Added an "Actions" column to the users table (only when `isSuperAdmin`).
- For each user row, when `isSuperAdmin && u.id !== currentUserId`, the role cell renders as a `DropdownMenu` trigger (button showing current role badge + chevron) with the 4 roles as menu items. The current role is highlighted with a check icon.
- For the current user (self) and non-super_admin viewers, the role cell renders a plain `RoleBadge`.
- The "No users found" empty row uses `colSpan={isSuperAdmin ? 7 : 6}` so the Actions column is covered.
- New `<TabsContent value="payment-methods">` at the bottom renders `<PaymentMethodsPanel />`.

### `/home/z/my-project/src/components/billing/billing-panel.tsx`
- Added imports: `Building`, `Wallet`, `AlertTriangle`.
- Extended `CheckoutResult` interface with unified multi-payment fields: `method`, `status`, `redirectUrl`, `transactionId`.
- Added `PaymentMethodOption` interface + `getMethodIcon(method, icon)` resolver (same map as the admin panel).
- `CheckoutDialog`:
  - New state: `paymentMethods`, `selectedMethod`, `methodsLoading`, `methodsError`.
  - `useEffect` on `open` — fetches `/api/billing/methods` (public). Auto-selects when exactly one method is active. Falls back to first method if the current selection is no longer valid.
  - `handlePurchase` now:
    1. Requires `selectedMethod` (toast error otherwise).
    2. Sends `method: selectedMethod` in the checkout body.
    3. Branches the response: `manual` + `pending` → show "Awaiting Confirmation" success state; `url` (real Stripe) → redirect; `redirect_required` + `redirectUrl` (Waafi) → redirect; otherwise demo success.
  - `handleClose` resets `selectedMethod`.
- New "Payment Method" section in the form (between project input and total):
  - Loading skeleton while methods load.
  - Red error card on fetch failure.
  - Amber "No payment methods available. Contact support." card when zero active.
  - Responsive `RadioGroup` (1 col for 1 method, 2 cols for 2, 3 cols for 3+) with each method as a clickable Label card showing the method icon + display name. Selected card gets emerald border + bg.
  - Extra note for manual method explaining the admin confirmation flow.
- Complete Purchase button disabled when: loading, methodsLoading, methodsError, no methods available, or no method selected.
- Success state expanded to render a distinct "Payment Awaiting Confirmation" view for manual payments — shows reference number (`transactionId`), amount due, and explanation that the admin will activate the subscription after transfer verification. Uses amber theme (vs. the emerald "Purchase Complete!" theme).

### `/home/z/my-project/src/app/page.tsx`
- Admin nav item filter now allows both `admin` and `super_admin`: `!item.adminOnly || user?.role === 'admin' || user?.role === 'super_admin'`.
- Admin panel render gate similarly allows both: `user?.role === 'admin' || user?.role === 'super_admin' ? <AdminPanel /> : <OverviewPanel />`.

### Admin route role-check updates (backward compatible: `admin` OR `super_admin`)
Updated `if (decoded.role !== 'admin')` → `if (decoded.role !== 'admin' && decoded.role !== 'super_admin')` in:
- `/home/z/my-project/src/app/api/admin/stats/route.ts`
- `/home/z/my-project/src/app/api/admin/users/route.ts`
- `/home/z/my-project/src/app/api/admin/jobs/route.ts`
- `/home/z/my-project/src/app/api/admin/jobs/[id]/retry/route.ts`
- `/home/z/my-project/src/app/api/admin/servers/route.ts`
- `/home/z/my-project/src/app/api/admin/jobs/process/route.ts`

(Note: the payment-methods admin routes from Task 18 already allowed both `super_admin` and `admin` per their `requireSuperAdmin` helper. Left unchanged per the original transition logic.)

## Backward Compatibility
- All existing `admin` users keep working — every admin route now allows BOTH `admin` and `super_admin`.
- Existing Stripe demo-mode checkout flow is unchanged (the demo branch in `/api/billing/checkout` returns the same shape as before — `demo: true`, `sessionId`, `url`, `payment`, `subscription`, `project`, `domain`, `deployment`).
- Existing Stripe real-mode redirect still works (the `result.url` branch).
- New: Waafi redirect + Manual pending states handled cleanly.
- The Payment Methods tab and inline role-change UI are additive — they only appear when the viewer is `super_admin`, so `admin` and `user` viewers see no change.

## Verification
- Each modified file passed `bun build --no-bundle <file>` syntax check (no errors).
- Dev server log (`tail /home/z/my-project/dev.log`) shows no compile errors after the changes.
- Per task instructions: did NOT run `bun run lint` or `bun run build`.

## Stage Summary
- `super_admin` role now properly recognized across the platform: nav gate, admin panel gate, all admin API routes.
- New super-admin-only Payment Methods panel lets the highest-privilege users toggle Stripe / Waafi / Manual on/off and edit each method's display name, icon, sort order, and JSON config — with explicit warnings when disabling the last active method.
- New `/api/admin/users/[userId]/role` endpoint allows super admins to promote/demote users between the four roles, with self-lockout protection and audit logging.
- Billing checkout dialog now fetches active payment methods from the public `/api/billing/methods` endpoint, renders a radio-card picker (auto-selects when only one method), shows an amber "No payment methods available" message when zero are active, and routes the response correctly: Stripe real → redirect, Waafi → redirect, Manual → pending confirmation state, Stripe demo → existing in-app success state.
- All existing admin functionality preserved; no breaking changes to existing API contracts or UI flows.
