/**
 * Playwright's webServer command: seed the e2e database, then run the panel.
 *
 *   bun tests/e2e/start-server.ts
 *
 * The app runs as a production build (`next build` + `next start`), the way
 * customers get it, rather than `next dev`: a dev server compiles each route
 * on first request (slow, timing-dependent tests) and hides production-only
 * behaviour such as the CSP, the __Host- session cookie and the "registrar
 * not configured" path.
 *
 * Simulation in a production build: `next build` compiles NODE_ENV as
 * "production" into the server bundles, so the non-production demo fallbacks
 * are off. The only switch that still simulates there is the explicit
 * VPS_DEMO_MODE=1 (src/lib/vps/ssh.ts isServerInDemoMode), which env.ts sets.
 * With no registrar key, domain search therefore answers honestly with
 * "couldn't check" instead of invented availability — exactly what customers
 * see when the registrar is down.
 *
 * Build: set E2E_BUILD=1 to run `next build` first (with the e2e env, so no
 * NEXT_PUBLIC_* value comes from a local .env). CI builds in its own step and
 * leaves it unset. Locally the first run needs E2E_BUILD=1.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { buildForE2e } from './build'
import { seed } from './seed'
import { e2eEnv } from './env'
import { E2E_PORT } from './fixtures'

const env = { ...process.env, ...e2eEnv() }
// next build / next start choose NODE_ENV themselves (production).
delete env.NODE_ENV

const nextBin = join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next')
const node = process.env.E2E_NODE || 'node'

await seed()

if (process.env.E2E_BUILD === '1') {
  const status = buildForE2e()
  if (status !== 0) process.exit(status)
}

if (!existsSync(join(process.cwd(), '.next', 'BUILD_ID'))) {
  console.error('e2e: no production build in .next — rerun with E2E_BUILD=1')
  process.exit(1)
}

console.log(`e2e: next start on port ${E2E_PORT}`)
const server = spawn(node, [nextBin, 'start', '-p', String(E2E_PORT), '-H', 'localhost'], {
  env,
  stdio: 'inherit',
})
// (cast: bun-types and @types/node disagree on process.on's overloads)
const proc = process as unknown as NodeJS.EventEmitter
proc.on('SIGINT', () => server.kill('SIGINT'))
proc.on('SIGTERM', () => server.kill('SIGTERM'))
server.on('exit', (code) => process.exit(code ?? 0))
