/**
 * tests/unit/compose-runners.test.ts
 *
 * The deployer runs `docker compose` with a stripped environment (so compose
 * cannot interpolate the panel's own secrets) and a pinned `-p` project name
 * (so a compose `name:` cannot target another tenant). The pipeline and
 * migration runners used to call compose without either. They now share the
 * same helpers from lib/vps/deploy-safety; this keeps every call site on them.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { COMPOSE_ENV, composeProjectFlag } from '../../src/lib/vps/deploy-safety'

describe('shared compose helpers', () => {
  it('strip the environment and pin the project name', () => {
    expect(COMPOSE_ENV.startsWith('env -i PATH="$PATH" HOME="$HOME" ')).toBe(true)
    expect(COMPOSE_ENV).not.toContain('JWT_SECRET')
    expect(composeProjectFlag('/opt/deployhub/projects/Shop.Online/')).toBe('-p shoponline ')
    expect(composeProjectFlag(null)).toBe('')
  })
})

describe('every compose call in the runners uses them', () => {
  for (const rel of ['src/lib/pipeline-runner.ts', 'src/lib/migration/runner.ts']) {
    it(rel, () => {
      // Command strings only (template literals), not comments.
      const src = readFileSync(path.join(process.cwd(), rel), 'utf8')
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n')
      const calls = [...src.matchAll(/`[^`]*?\bdocker[ -]compose\b[^`]*`/g)].map((m) => m[0])
      const invocations = calls.flatMap((c) => [...c.matchAll(/(\S*)docker[ -]compose (\S+)/g)])
      expect(invocations.length).toBeGreaterThan(0)
      for (const m of invocations) {
        expect(m[1].replace(/^[(`]+/, '')).toBe('${COMPOSE_ENV}')
        expect(m[2].startsWith('${composeProjectFlag(')).toBe(true)
      }
    })
  }
})
