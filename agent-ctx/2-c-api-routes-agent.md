# Task 2-c: API Routes for Deployment SSE, Forgot-Password, Reset-Password

## Summary
Created three new API route files following existing project patterns.

## Files Created

### 1. `/src/app/api/deployments/[id]/events/route.ts`
- **SSE endpoint** for real-time deployment progress tracking
- GET handler with JWT auth (Authorization header)
- Polls DB every 2 seconds, sends SSE `data:` events
- Event format: `{ id, status, buildLog, deployUrl, duration, updatedAt }`
- Closes stream on terminal status: `live`, `failed`, `rolled_back`
- SSE headers: `text/event-stream`, `no-cache`, `keep-alive`
- Uses `ReadableStream` + `TextEncoder` for streaming
- `const { id } = await params` for Next.js 16 Promise params
- **Demo simulation**: if deployment is "queued", automatically progresses through `building→deploying→live` with fake build log lines every 2 seconds

### 2. `/src/app/api/auth/forgot-password/route.ts`
- POST endpoint accepting `{ email }`
- Finds user by email, generates `crypto.randomBytes(32)` token
- Stores token in `emailVerificationToken` field
- Returns `{ message, token }` for demo (simulated email)
- Prevents email enumeration with generic success message

### 3. `/src/app/api/auth/reset-password/route.ts`
- POST endpoint accepting `{ token, newPassword }`
- Validates token existence and password length (min 8)
- Finds user by `emailVerificationToken` match
- Hashes password with `bcrypt.hash(newPassword, 12)`
- Updates password and clears token
- Returns success message

## Verification
- All three files pass ESLint with no errors
- Follow existing auth patterns: `verifyToken`, `extractTokenFromHeader`, `db`
- Follow existing route parameter pattern: `params: Promise<{ id: string }>`
