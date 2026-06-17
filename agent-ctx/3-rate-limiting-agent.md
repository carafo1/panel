---
Task ID: 3
Agent: Rate Limiting Agent
Task: Implement API rate limiting middleware (#8)

Work Log:
- Read existing src/lib/rate-limit.ts (sliding-window limiter for route handlers)
- Read src/middleware.ts.bak (previous attempt — used jsonwebtoken, not Edge-compatible)
- Read current src/middleware.ts (broken — used `import jwt from 'jsonwebtoken'` which fails in Edge runtime)
- Installed jose (already present at v6.2.3, reinstalled as no-op for safety)
- Wrote new src/middleware.ts from scratch:
  - Removed jsonwebtoken import entirely (Edge-incompatible)
  - Removed JWT verification logic (routes do their own auth per task spec)
  - Implemented Edge-compatible in-memory Map rate limiter with 5-min cleanup
  - Per-route limits:
      /api/auth/login          -> 5/min
      /api/auth/register       -> 3/min
      /api/auth/forgot-password -> 3/min
      /api/auth/reset-password  -> 5/min
      /api/domains/search      -> 20/min
      /api/* (default)         -> 100/min
  - Added CORS headers to all /api/* responses (Origin: *, Methods: GET/POST/PUT/PATCH/DELETE/OPTIONS, Headers: Content-Type, Authorization)
  - OPTIONS preflight returns 204 No Content with CORS headers
  - 429 responses include Retry-After + X-RateLimit-* headers
  - Pass-through responses include X-RateLimit-Limit/Remaining/Reset headers
  - Middleware only applies rate limiting / CORS to /api/* (non-API routes pass through untouched)
  - Matcher excludes /_next/static, /_next/image, favicon.ico, and common static asset extensions
- Verified functionality via curl:
  - OPTIONS /api/auth/login -> 204 with CORS headers ✓
  - POST /api/auth/login x6 -> first 5 pass (401 from route), 6th+7th return 429 with Retry-After: 60 ✓
  - POST /api/auth/register -> 201 with CORS + X-RateLimit-* headers ✓
  - GET / (landing page) -> 200 with NO CORS or rate limit headers (pass-through) ✓

Stage Summary:
- New Edge-compatible middleware at src/middleware.ts replaces the broken jsonwebtoken-based version
- No JWT verification in middleware (delegated to route handlers, as required)
- API rate limits enforced per IP + per route type with sliding 1-minute window
- CORS preflight handled with 204 response; CORS headers attached to all /api/* responses
- 429 Too Many Requests includes Retry-After header and informative JSON body
- Non-API routes (landing page, static assets) pass through untouched
- Dev server picks up the new middleware automatically; no build/lint needed
