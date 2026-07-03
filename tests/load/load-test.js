import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Rate, Trend } from 'k6/metrics'

// ════════════════════════════════════════════════════════════════════════════
// Apsamo Panel — Load Test (k6)
// ════════════════════════════════════════════════════════════════════════════
//
//   Tests the panel's ability to handle concurrent users:
//     - Landing page loads
//     - Login flow
//     - Domain search (rate-limited)
//     - Project list (authenticated)
//     - Pricing endpoint (authenticated)
//
//   Usage:
//     k6 run tests/load/load-test.js
//     k6 run --vus 50 --duration 60s tests/load/load-test.js
//     PANEL_URL=https://yourdomain.com k6 run tests/load/load-test.js
//
//   Install k6: https://k6.io/docs/getting-started/installation/
// ════════════════════════════════════════════════════════════════════════════

const PANEL_URL = __ENV.PANEL_URL || 'http://localhost:3000'
const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'admin@deployhub.io'
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'admin123'

// Custom metrics
const errorRate = new Rate('errors')
const loginDuration = new Trend('login_duration', true)
const searchDuration = new Trend('search_duration', true)

// Test options
export const options = {
  stages: [
    { duration: '30s', target: 20 },   // ramp up to 20 users
    { duration: '1m', target: 20 },    // stay at 20 users
    { duration: '30s', target: 50 },   // ramp up to 50 users
    { duration: '1m', target: 50 },    // stay at 50 users
    { duration: '30s', target: 0 },    // ramp down to 0
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95% of requests must complete < 500ms
    http_req_failed: ['rate<0.05'],    // error rate must be < 5%
    errors: ['rate<0.05'],
  },
}

// Login once per VU and reuse the token
let authToken = null

function login() {
  const res = http.post(
    `${PANEL_URL}/api/auth/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } }
  )
  loginDuration.add(res.timings.duration)

  const success = check(res, {
    'login status 200': (r) => r.status === 200,
    'login has token': (r) => {
      try {
        const body = JSON.parse(r.body)
        return !!body.token
      } catch { return false }
    },
  })

  if (success) {
    try {
      authToken = JSON.parse(res.body).token
    } catch { }
  } else {
    errorRate.add(1)
  }

  return success
}

export default function () {
  // Login if we don't have a token yet
  if (!authToken) {
    if (!login()) {
      sleep(1)
      return
    }
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${authToken}`,
  }

  group('landing page', () => {
    const res = http.get(`${PANEL_URL}/`)
    check(res, {
      'landing 200': (r) => r.status === 200,
    }) || errorRate.add(1)
  })

  sleep(0.5)

  group('project list', () => {
    const res = http.get(`${PANEL_URL}/api/hosting`, { headers })
    check(res, {
      'hosting 200': (r) => r.status === 200,
    }) || errorRate.add(1)
  })

  sleep(0.5)

  group('pricing', () => {
    const res = http.get(`${PANEL_URL}/api/pricing`, { headers })
    check(res, {
      'pricing 200': (r) => r.status === 200,
    }) || errorRate.add(1)
  })

  sleep(0.5)

  group('domain search', () => {
    const domain = `loadtest${__VU}-${__ITER}.com`
    const res = http.get(`${PANEL_URL}/api/domains/search?domain=${domain}`, { headers })
    searchDuration.add(res.timings.duration)

    check(res, {
      'search 200 or 429': (r) => r.status === 200 || r.status === 429,
    }) || errorRate.add(1)
  })

  sleep(1)
}
