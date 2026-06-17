# Task ID: 18 — Multi-Payment Billing Agent

## Task
Implement a multi-payment-method billing system with Stripe, Waafi Pay, and manual payments. Super admins can toggle which methods are active.

## Files Read (context)
- `/home/z/my-project/src/lib/stripe.ts` — existing Stripe client wrapper (demo mode + real Stripe)
- `/home/z/my-project/src/app/api/billing/checkout/route.ts` — original Stripe-only checkout (demo + real)
- `/home/z/my-project/src/app/api/billing/subscription/route.ts` — subscription GET/POST/DELETE
- `/home/z/my-project/src/app/api/billing/history/route.ts` — payment history listing
- `/home/z/my-project/src/components/billing/billing-panel.tsx` — checkout dialog UI (first 100 lines for context)
- `/home/z/my-project/prisma/schema.prisma` — `Payment` model (already had `method` + `transactionId` columns) and `PaymentMethodSetting` model
- `/home/z/my-project/src/lib/auth.ts`, `/src/lib/audit.ts`, `/src/lib/notifications.ts`, `/src/lib/automation.ts` — supporting libraries
- `/home/z/my-project/src/app/api/billing/success/route.ts` — Stripe success redirect handler (referenced for response shape parity)
- `/home/z/my-project/.env` — appended Waafi env vars

## Files Created
1. **`/home/z/my-project/src/lib/waafi.ts`** — Waafi Pay API client. Native `fetch` (no new packages). Demo mode when `WAAFI_API_URL`/`WAAFI_MERCHANT_ID`/`WAAFI_API_KEY`/`WAAFI_API_USER_ID` are unset. Exports: `isWaafiConfigured`, `isWaafiDemoMode`, `createPayment`, `verifyPayment`, `getPaymentStatus`. Uses Waafi's request envelope (`requestType`, `merchantId`, `apiUserId`, `apiKey`). Normalises Waafi status strings into `pending` | `completed` | `failed`.

2. **`/home/z/my-project/src/lib/payment-methods.ts`** — unified payment manager. Exports: `PaymentMethod` interface, `getActivePaymentMethods`, `getAllPaymentMethods`, `getPaymentMethod`, `togglePaymentMethod`, `updatePaymentMethodConfig`, `ensurePaymentMethodsSeeded`, `resolveActiveMethod`, `processPayment`. Seeds 3 default methods (Stripe active by default, Waafi + manual off by default). `processPayment` dispatches to Stripe (`createCheckoutSession`), Waafi (`createPayment`), or manual (creates pending Payment + reference, no redirect). All providers create a Payment row with `method` + `transactionId` set.

3. **`/home/z/my-project/src/app/api/billing/methods/route.ts`** — public `GET` that returns all active payment methods. Strips sensitive config; for `manual` it exposes the instructions + bank details so the checkout UI can render them. No auth required.

4. **`/home/z/my-project/src/app/api/admin/payment-methods/route.ts`** — super-admin `GET` (returns all methods incl. inactive) + `PATCH` (toggle `active`, update `config`/`displayName`/`icon`/`sortOrder`). Writes an audit log entry on PATCH. Permissive fallback: accepts both `super_admin` and `admin` roles during transition.

5. **`/home/z/my-project/src/app/api/admin/payment-methods/[method]/route.ts`** — super-admin `GET`/`PATCH` for a single method. Same body shape as the collection PATCH. Returns the refreshed method in the PATCH response.

6. **`/home/z/my-project/src/app/api/billing/waafi/callback/route.ts`** — Waafi callback endpoint. `POST` (server-to-server) and `GET` (browser redirect) handlers. Re-verifies the transaction with Waafi before granting access (defence-in-depth). Idempotent: returns 200 if the payment is already completed. On success: marks Payment `completed`, activates the user's pending Subscription, drives the automation pipeline (`payment_success` event), notifies the user.

## Files Modified
7. **`/home/z/my-project/src/app/api/billing/checkout/route.ts`** — rewritten to:
   - Accept `method` in the request body (defaults to `"stripe"` for backward compatibility).
   - Validate the requested method is active via `resolveActiveMethod`.
   - Route through `processPayment` from `lib/payment-methods.ts`.
   - **Backward-compatible demo-mode path preserved**: when method is `stripe` and `STRIPE_SECRET_KEY` is unset, the original inline-success behaviour (immediate project/domain creation, immediate Payment `completed`, immediate `processEvent`) is kept so the existing UI flow and success state continue to work unchanged.
   - **Unified path** (real Stripe redirect, Waafi redirect, manual pending): dispatches through `processPayment` and returns a generic shape with `method`, `status` (`redirect_required` | `pending`), `redirectUrl`, `transactionId`, `paymentId` plus legacy `sessionId`/`url`/`demo` fields for UI backward compatibility.

8. **`/home/z/my-project/.env`** — appended `WAAFI_API_URL`, `WAAFI_MERCHANT_ID`, `WAAFI_API_KEY`, `WAAFI_API_USER_ID` (empty by default → demo mode).

## Architecture Decisions
- `processPayment` is the single entry point — API routes never call Stripe/Waafi directly.
- Default method seeding is idempotent (`ensurePaymentMethodsSeeded` is called from every read/write helper).
- Manual payments create a Payment row with `status: 'pending'`, a `MAN-…` reference stored on `transactionId`, and bank details / instructions embedded in the metadata JSON. No redirect — admin manually confirms later (separate admin endpoint / UI to be added by a follow-up task).
- Waafi callback is public (Waafi can't authenticate against our JWT) but **always re-verifies** the transaction via `verifyPayment()` before completing it. A forged callback alone cannot complete a payment.
- `super_admin` is the canonical role; `admin` is accepted during the transition window per the task brief.
- All Payment rows created by `processPayment` set both `method` and `transactionId` so the schema's new columns are uniformly populated and the admin panel / payment history can group by method.

## Backward Compatibility
- Existing Stripe demo-mode UI flow (immediate project + domain + deployment creation, immediate `completed` Payment, `processEvent('payment_success')`) is preserved verbatim.
- Existing response shape from `/api/billing/checkout` (with `sessionId`, `url`, `demo`, `payment`, `subscription`, `project`, `domain`, `deployment`, `automation`) is preserved for the demo path.
- New response shape for the unified path adds `method`, `status`, `redirectUrl`, `transactionId`, `paymentId` so the UI can branch on `status === 'pending'` (manual) vs `status === 'redirect_required'` (stripe/waafi).
- `GET /api/billing/subscription`, `/api/billing/history`, `/api/billing/plans`, `/api/billing/success`, `/api/billing/portal`, `/api/billing/webhook` are untouched.
