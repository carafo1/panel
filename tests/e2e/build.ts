/**
 * Production build for the e2e suite, made with the e2e environment
 * (tests/e2e/env.ts) so no NEXT_PUBLIC_* value or secret comes from a local
 * .env file.
 *
 *   bun tests/e2e/build.ts
 *
 * CI runs this as its own step; locally, E2E_BUILD=1 makes start-server.ts
 * run it before starting the server.
 */
import { join } from 'node:path'
import { e2eEnv } from './env'

export function buildForE2e(): number {
  const env: Record<string, string | undefined> = { ...process.env, ...e2eEnv() }
  delete env.NODE_ENV // next build sets production itself
  const nextBin = join(process.cwd(), 'node_modules', 'next', 'dist', 'bin', 'next')
  console.log('e2e: next build')
  const r = Bun.spawnSync([process.env.E2E_NODE || 'node', nextBin, 'build'], {
    env,
    stdout: 'inherit',
    stderr: 'inherit',
  })
  return r.exitCode ?? 1
}

if (import.meta.main) {
  process.exit(buildForE2e())
}
