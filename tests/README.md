# Apsamo Panel — Tests

> Automated test suite for the Apsamo Panel. Run with [Bun's built-in test runner](https://bun.sh/docs/test).

## Quick start

```bash
# Run unit tests only (no panel required)
bun run test

# Run integration tests (requires panel running on localhost:3000)
bun run test:integration

# Run all tests
bun run test:all

# Run security scan
bun run test:security
```

## Test structure

```
tests/
├── unit/                    # Unit tests (no external dependencies)
│   ├── security.test.ts     # Tests for src/lib/security.ts
│   └── auth.test.ts         # Tests for src/lib/auth.ts
├── integration/             # Integration tests (require running panel)
│   └── api-security.test.ts # End-to-end API security tests
├── load/                    # Load tests (require k6)
│   └── load-test.js         # k6 load test script
└── fixtures/                # Test fixtures (sample data)
```

## Unit tests

Test individual modules in isolation. No database, no network, no panel required.

```bash
bun test tests/unit/
```

What's covered:
- **`security.test.ts`** — `sanitizeError`, `isAdmin`, `isSuperAdmin`, `sanitizeProjectForCustomer`, `sanitizeServerForCustomer`, `maskSecret`, `isSafeRedirectUrl`, `safeCompare`
- **`auth.test.ts`** — `hashPassword`, `verifyPassword`, `generateToken`, `verifyToken`, `extractTokenFromHeader`

## Integration tests

Test the full API against a running panel instance. The panel must be running on `http://localhost:3000` with the default seed data (admin user: `admin@deployhub.io` / `admin123`, test user: `testuser@apsamo.io` / `Test1234!`).

```bash
# Start the panel first
bun run dev &

# Wait for it to be ready
sleep 15

# Run integration tests
bun test tests/integration/
```

What's covered:
- Authentication required on all protected endpoints
- Admin-only access enforced (regular users get 403)
- Pricing endpoint hides wholesale/markup from non-admins
- Domain search rate-limited + doesn't leak Dynadot brand
- Domain name FQDN validation
- Cross-tenant isolation (user A can't see user B's projects)
- HTTP security headers present (no X-Powered-By, HSTS, X-Frame-Options)
- Webhook signing secrets masked in list responses

## Load tests

Load testing with [k6](https://k6.io). Simulates concurrent users hitting the panel.

### Install k6

```bash
# macOS
brew install k6

# Linux
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt update && sudo apt install k6
```

### Run load tests

```bash
# Local panel
k6 run tests/load/load-test.js

# Remote panel (production)
PANEL_URL=https://yourdomain.com k6 run tests/load/load-test.js

# Custom load profile
k6 run --vus 100 --duration 2m tests/load/load-test.js
```

### What the load test does

- Ramps up from 0 → 20 → 50 concurrent users over 3.5 minutes
- Each user:
  1. Logs in (gets JWT)
  2. Loads the landing page
  3. Lists their projects
  4. Fetches pricing
  5. Searches for a domain
- Reports: request count, avg duration, p95 duration, error rate
- **Pass criteria:** p95 < 500ms, error rate < 5%

## CI/CD

Tests run automatically on every push + PR via GitHub Actions (`.github/workflows/ci.yml`):

1. **Lint** — ESLint
2. **Security audit** — custom scan + npm audit + hardcoded secret check
3. **Build** — Next.js production build
4. **Test** — unit tests

All jobs must pass before merge to `main`.

## Adding new tests

### Unit test template

```typescript
import { describe, it, expect } from 'bun:test'
import { myFunction } from '../../src/lib/my-module'

describe('my-module', () => {
  it('does the right thing', () => {
    expect(myFunction('input')).toBe('expected output')
  })
})
```

### Integration test template

```typescript
import { describe, it, expect, beforeAll } from 'bun:test'

const PANEL_URL = process.env.PANEL_URL || 'http://localhost:3000'

describe('My Feature', () => {
  it('works end-to-end', async () => {
    const res = await fetch(`${PANEL_URL}/api/my-endpoint`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})
```

## Coverage goals

| Area | Coverage |
|---|---|
| **Security helpers** (`src/lib/security.ts`) | 100% |
| **Auth** (`src/lib/auth.ts`) | 100% |
| **API security** (auth, ownership, role checks) | All 161 routes |
| **Domain section** | All 20 routes |
| **Billing section** | All 9 routes |
| **Admin section** | All 20 routes |

Run coverage report:
```bash
bun test --coverage tests/unit/
```
