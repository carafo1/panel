# Task 10 — Stripe Agent

## Goal
Implement real Stripe payment integration with graceful demo-mode fallback.

## Work Log

### 1. Schema change
- Added `stripeCustomerId String?` to the `Subscription` model in `prisma/schema.prisma`
- Ran `bun run db:push` to apply the schema change and regenerate the Prisma client
- Bumped `SCHEMA_VERSION` in `src/lib/db.ts` to `'2025-06-17-stripe-customer-id-v2'` so the running dev server discards the old PrismaClient instance
- Added a require-cache busting routine in `src/lib/db.ts` so the latest generated client class is loaded (best-effort — Turbopack has its own module cache, so we also use raw SQL as a workaround, see below)

### 2. `/api/billing/checkout` route (`src/app/api/billing/checkout/route.ts`)
- Calls `createCheckoutSession()` from `@/lib/stripe` with plan details, success/cancel URLs, userId, and email
- Builds `successUrl = /api/billing/success?session_id={CHECKOUT_SESSION_ID}` and `cancelUrl = /?tab=billing&payment=cancelled`
- **Demo mode**: simulates success synchronously — creates project/domain records, runs the automation pipeline, marks Payment as `completed`, activates Subscription as `active`, returns full success payload including `sessionId`, `url`, `demo: true`, plus the existing `payment/subscription/project/domain/deployment/automation` fields so the UI keeps working
- **Real Stripe mode**: creates a pending Payment record keyed by the Stripe session ID and returns `{ sessionId, url, demo: false, paymentId, message }` so the frontend can redirect to Stripe Checkout

### 3. `/api/billing/webhook` route (`src/app/api/billing/webhook/route.ts`)
- Reads the raw request body and the `stripe-signature` header
- Calls `constructWebhookEvent()` to verify the signature (logs a DEMO MODE warning if the secret isn't set)
- Handles 5 Stripe event types:
  - `checkout.session.completed` — marks the matching Payment as `completed`, activates any pending Subscription, drives the automation pipeline, sends a success notification
  - `customer.subscription.updated` — updates the local Subscription status (mapped from Stripe status), `currentPeriodStart/End`, and `cancelAtPeriodEnd`
  - `customer.subscription.deleted` — marks Subscription as `cancelled`, runs the `subscription_cancelled` automation event, notifies the user
  - `invoice.payment_succeeded` — records a new Payment for renewals (dedupes by charge ID), notifies the user
  - `invoice.payment_failed` — records a failed Payment, marks Subscription as `past_due`, runs the `payment_failed` automation event, sends an error notification
- Maintains backward compatibility with the legacy demo webhook payload shape (`{ type, data: { userId, paymentId, ... } }`)

### 4. `/api/billing/subscription` route (`src/app/api/billing/subscription/route.ts`)
- **GET**: also returns `stripeSubId` and `stripeCustomerId` so the UI can show a Stripe badge
- **POST**: 
  - Looks up the user's existing `stripeCustomerId` (via `findMany` + JS filter to avoid issues with the cached Prisma client not knowing about the new column)
  - If none, calls `createCustomer()` to make one (or falls back to a placeholder in demo mode)
  - Resolves a `priceId` from the request body, env var `STRIPE_PRICE_ID_{SLUG_UPPER}`, or `STRIPE_PRICE_ID_DEFAULT`
  - Calls `createSubscription()` (real Stripe call in production; simulated in demo mode)
  - Creates the local Subscription record (omitting `stripeCustomerId` because the running dev server's cached Prisma client doesn't know about the new column), then uses `db.$executeRaw` to set `stripeCustomerId` directly via SQL — works regardless of cached client version
  - Creates a Payment record (`completed` in demo mode, `pending` in real Stripe mode)
  - Sends a notification and records an audit log
- **DELETE** (new): calls `cancelSubscription()` from `@/lib/stripe` (cancel at period end), updates the local Subscription to `cancelled` + `cancelAtPeriodEnd: true`, notifies the user, records an audit log

### 5. `/api/billing/history` route (`src/app/api/billing/history/route.ts`)
- Returns real Payment records including `stripePaymentId`, `stripeInvoiceId`, parsed `metadata`, and the related plan
- Safe JSON parsing of the `metadata` field (returns `null` on parse failure instead of crashing)

### 6. New route: `/api/billing/portal` (`src/app/api/billing/portal/route.ts`)
- POST creates a Stripe Customer Portal session via `stripe.billingPortal.sessions.create()` and returns `{ url }`
- Demo mode: returns `{ url: null, demo: true, message: '...', subscription: {...} }` so the frontend can show an explanatory toast
- Requires the user to have a `stripeCustomerId` on their Subscription record

### 7. New route: `/api/billing/success` (`src/app/api/billing/success/route.ts`)
- GET handler — Stripe redirects here after a successful Checkout
- Demo mode: just redirects to `/?tab=billing&payment=success` (the Payment was already marked completed at checkout time)
- Real Stripe mode:
  - Calls `retrieveSession()` to verify payment status
  - If `payment_status !== 'paid'`: redirects to `/?tab=billing&payment=failed`
  - Updates the matching Payment (found by `stripePaymentId = sessionId`) to `completed` and stores the actual `payment_intent` ID
  - Activates any pending Subscription
  - Drives the automation pipeline (`payment_success` event — creates project/domain/deployment)
  - Sends a success notification
  - Redirects to `/?tab=billing&payment=success`
- All error paths redirect to `/?tab=billing&payment=error`

### 8. `src/components/billing/billing-panel.tsx`
- Extended `CheckoutResult` interface to include `sessionId?`, `url?`, `demo?`, `paymentId?`, `message?`
- Added a new `PortalResult` interface
- Extended `Subscription` interface with `cancelAtPeriodEnd?`, `stripeSubId?`, `stripeCustomerId?`
- Extended `Payment` interface with `stripePaymentId?`, `stripeInvoiceId?`
- Added new icons: `Settings2`, `Ban`, `ShieldCheck`
- `handlePurchase` now branches:
  - If `result.demo === false && result.url`: redirects `window.location.href = result.url` (real Stripe Checkout)
  - Else: shows the in-app success dialog (demo mode — existing behavior preserved)
- Added `handleManageSubscription` — POSTs to `/api/billing/portal`, redirects to the returned URL, or shows a demo-mode info toast
- Added `handleCancelSubscription` — confirms with the user, DELETEs `/api/billing/subscription`, refreshes data
- Redesigned the Current Plan card:
  - Status badge now reflects `active | past_due | pending | Cancelling` (when `cancelAtPeriodEnd` is true)
  - Shows a `Stripe` badge when the subscription has a `stripeSubId`
  - Shows "Cancels on" vs "Renews" depending on `cancelAtPeriodEnd`
  - Added "Manage Subscription" button (opens Stripe Customer Portal)
  - Added "Cancel Subscription" button (hidden if already cancelling)
  - Added "Change Plan" ghost button
- Added a "Transaction ID" column to the payment history table (shows `stripePaymentId` / `stripeInvoiceId` / `checkoutSessionId`, hidden on mobile)
- Extended `PaymentStatusBadge` to handle `past_due` and `cancelled` statuses
- Added a useEffect that refreshes billing data when the URL has `?payment=success` (toast notifications are handled centrally by `page.tsx`)

### 9. `src/app/page.tsx`
- Added a useEffect that reads `?tab=` and `?payment=` URL params on mount
- Sets the dashboard tab from `?tab=` (e.g. `?tab=billing`)
- Shows a toast notification based on `?payment=` value: `success | cancelled | failed | error`
- Cleans the URL after handling

## Endpoint test results

All endpoints tested end-to-end in demo mode:

```
POST /api/billing/checkout             → 201 (demo: full success payload)
POST /api/billing/subscription         → 201 (creates Subscription + Payment, stores stripeCustomerId via raw SQL)
DELETE /api/billing/subscription       → 200 (cancels via Stripe in demo mode)
GET  /api/billing/subscription         → 200 (returns active subscription)
GET  /api/billing/history              → 200 (returns real payment records with Stripe IDs)
POST /api/billing/portal               → 200 (demo: returns message + subscription info)
POST /api/billing/webhook              → 200 (handles all 5 Stripe event types)
GET  /api/billing/success?session_id=… → 307 (redirects to /?tab=billing&payment=success)
```

## Notable decisions

1. **Cached Prisma client workaround**: The running dev server had an older Prisma client cached that didn't know about the new `stripeCustomerId` column. To work around this without restarting the dev server:
   - Bumped `SCHEMA_VERSION` in `db.ts` to force a fresh PrismaClient instance
   - Added a require-cache busting routine in `db.ts` (best-effort, Turbopack uses its own module cache)
   - Used `db.$executeRaw` SQL to set `stripeCustomerId` after creating a Subscription (bypasses Prisma's runtime field validation)
   - Used `db.subscription.findMany` + JS filter instead of `findFirst({ where: { stripeCustomerId: { not: null } } })` for the lookup
   - Once the dev server is restarted, all of these workarounds become no-ops and the code uses the normal Prisma API

2. **Demo vs real Stripe mode detection**: `isStripeDemoMode()` from `@/lib/stripe` returns `true` when `STRIPE_SECRET_KEY` is not set. All routes branch on this so the same code works in both modes.

3. **Backward compatibility**: The checkout endpoint in demo mode returns the SAME response shape as before (payment/subscription/project/domain/deployment/automation) PLUS the new Stripe fields (sessionId/url/demo). The frontend uses `result.demo` to decide whether to redirect to Stripe or show the success dialog. This preserves the existing UI behavior in demo mode while enabling real Stripe Checkout in production.

4. **URL routing**: The app is a single-page app rendered at `/` with the dashboard tab managed by Zustand. All Stripe redirects use `/?tab=billing&payment=...` instead of `/dashboard?tab=billing&payment=...`. The root `page.tsx` reads these params and switches the tab + shows a toast.

5. **Webhook signature verification**: In production (with `STRIPE_WEBHOOK_SECRET` set), the webhook handler strictly verifies signatures. In demo mode, it logs a warning and accepts the raw payload — this is intentional so the demo flow can be exercised without a real Stripe account.

## Files modified
- `prisma/schema.prisma` — added `stripeCustomerId` to Subscription
- `src/lib/db.ts` — schema version bump + require-cache busting
- `src/app/api/billing/checkout/route.ts` — real Stripe Checkout + demo fallback
- `src/app/api/billing/webhook/route.ts` — full Stripe event handling
- `src/app/api/billing/subscription/route.ts` — POST creates customer+sub, DELETE cancels
- `src/app/api/billing/history/route.ts` — returns real payment records
- `src/app/api/billing/portal/route.ts` — NEW: Customer Portal session
- `src/app/api/billing/success/route.ts` — NEW: Stripe Checkout redirect handler
- `src/components/billing/billing-panel.tsx` — Stripe redirect, manage button, cancel button, transaction ID column
- `src/app/page.tsx` — handles `?tab=` and `?payment=` URL params
