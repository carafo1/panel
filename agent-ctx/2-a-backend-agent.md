# Task 2-a: Webhooks API Routes

## Summary
Created 4 API route files for the Webhooks system following existing project patterns.

## Files Created

1. **`/src/app/api/webhooks/route.ts`** - GET (list) + POST (create)
   - GET: Lists user's webhooks with project info and delivery count
   - POST: Creates webhook with crypto-generated secret, validates URL/events/project ownership

2. **`/src/app/api/webhooks/[id]/route.ts`** - GET + PATCH (update + delete)
   - GET: Single webhook with 10 recent deliveries
   - PATCH: Update fields or delete with `{ _delete: true }`
   - No DELETE export (avoiding Next.js issues per task requirement)

3. **`/src/app/api/webhooks/[id]/deliveries/route.ts`** - GET (paginated)
   - Page/limit query params, default 20, max 100
   - Returns parsed JSON payloads + pagination metadata

4. **`/src/app/api/webhooks/[id]/test/route.ts`** - POST (test)
   - Simulates delivery with fake 200 response and random duration
   - Updates lastTriggeredAt, validates webhook is active

## Key Patterns Used
- `params: Promise<{ id: string }>` with `const { id } = await params`
- `verifyToken` / `extractTokenFromHeader` auth pattern
- `db` from `@/lib/db`
- All ESLint clean
