/**
 * tests/unit/path-confine.test.ts — the file manager must not follow symlinks
 * out of a site (src/lib/vps/path-confine.ts).
 *
 * Builds a real temp directory:
 *   <tmp>/secret.env               (stands in for /opt/apsamo/.env)
 *   <tmp>/site/                    (the website base)
 *   <tmp>/site/index.html
 *   <tmp>/site/leak -> ../secret.env
 *   <tmp>/site/outdir -> <tmp>     (directory symlink escaping the site)
 *   <tmp>/site/inner -> sub        (symlink staying inside)
 *   <tmp>/site/dangling -> <tmp>/nowhere
 *
 * Symlink creation needs a POSIX host (or Windows developer mode); the tests
 * are skipped where symlinks cannot be created.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import {
  assertConfinedLocal,
  confinementGuardScript,
  guardFailureMessage,
  PathConfinementError,
  GUARD_EXIT_ESCAPE,
  GUARD_EXIT_SYMLINK,
} from '../../src/lib/vps/path-confine'

let root = ''
let site = ''
let symlinksOk = true

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'apsamo-confine-'))
  site = path.join(root, 'site')
  mkdirSync(path.join(site, 'sub'), { recursive: true })
  writeFileSync(path.join(root, 'secret.env'), 'JWT_SECRET=do-not-leak\n')
  writeFileSync(path.join(site, 'index.html'), '<h1>hi</h1>')
  writeFileSync(path.join(site, 'sub', 'a.txt'), 'a')
  try {
    symlinkSync('../secret.env', path.join(site, 'leak'))
    symlinkSync(root, path.join(site, 'outdir'), 'dir')
    symlinkSync('sub', path.join(site, 'inner'), 'dir')
    symlinkSync(path.join(root, 'nowhere'), path.join(site, 'dangling'))
  } catch {
    symlinksOk = false
  }
})

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

const p = (...parts: string[]) => path.join(site, ...parts)

async function refused(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch (err) {
    return err instanceof PathConfinementError
  }
}

describe('assertConfinedLocal', () => {
  it('allows ordinary files and new files inside the site', async () => {
    await assertConfinedLocal(site, p('index.html'), 'read')
    await assertConfinedLocal(site, p('new-dir', 'new.txt'), 'write')
    await assertConfinedLocal(site, p('sub'), 'list')
    await assertConfinedLocal(site, p('index.html'), 'remove')
  })

  it('refuses to read a symlink to a secret outside the site', async () => {
    if (!symlinksOk) return
    expect(await refused(() => assertConfinedLocal(site, p('leak'), 'read'))).toBe(true)
  })

  it('refuses to write through a symlink', async () => {
    if (!symlinksOk) return
    expect(await refused(() => assertConfinedLocal(site, p('leak'), 'write'))).toBe(true)
  })

  it('refuses paths that traverse a directory symlink leaving the site', async () => {
    if (!symlinksOk) return
    expect(await refused(() => assertConfinedLocal(site, p('outdir', 'secret.env'), 'read'))).toBe(true)
    expect(await refused(() => assertConfinedLocal(site, p('outdir', 'planted.txt'), 'write'))).toBe(true)
    expect(await refused(() => assertConfinedLocal(site, p('outdir'), 'list'))).toBe(true)
    expect(await refused(() => assertConfinedLocal(site, p('outdir', 'secret.env'), 'remove'))).toBe(true)
  })

  it('refuses writing beneath a dangling symlink', async () => {
    if (!symlinksOk) return
    expect(await refused(() => assertConfinedLocal(site, p('dangling', 'x.txt'), 'write'))).toBe(true)
  })

  it('allows symlinks that stay inside the site, and deleting a symlink itself', async () => {
    if (!symlinksOk) return
    await assertConfinedLocal(site, p('inner', 'a.txt'), 'read')
    await assertConfinedLocal(site, p('inner'), 'list')
    // Removing the link never touches its target.
    await assertConfinedLocal(site, p('leak'), 'remove')
  })
})

describe('confinementGuardScript (bash, used for SSH and local exec)', () => {
  const hasBash =
    process.platform !== 'win32' &&
    spawnSync('bash', ['-c', 'realpath -m / >/dev/null'], { encoding: 'utf8' }).status === 0

  const run = (target: string, mode: 'read' | 'write' | 'list' | 'remove') =>
    spawnSync('bash', ['-c', `${confinementGuardScript(site, target, mode)}\necho OK`], {
      encoding: 'utf8',
    })

  it('maps exit codes to messages', () => {
    expect(guardFailureMessage(GUARD_EXIT_ESCAPE)).toBeTruthy()
    expect(guardFailureMessage(GUARD_EXIT_SYMLINK)).toBeTruthy()
    expect(guardFailureMessage(0)).toBeNull()
    expect(guardFailureMessage(1)).toBeNull()
  })

  it('quotes paths so they cannot inject shell', () => {
    const s = confinementGuardScript('/srv/site', "/srv/site/a'; touch /tmp/x; '", 'read')
    expect(s).toContain("'/srv/site/a'\\''; touch /tmp/x; '\\'''")
  })

  it('lets inside paths through and blocks escapes', () => {
    if (!hasBash || !symlinksOk) return
    expect(run(p('index.html'), 'read').stdout.trim()).toBe('OK')
    expect(run(p('new', 'file.txt'), 'write').stdout.trim()).toBe('OK')
    expect(run(p('leak'), 'read').status).toBe(GUARD_EXIT_ESCAPE)
    expect(run(p('outdir', 'x'), 'write').status).toBe(GUARD_EXIT_ESCAPE)
    expect(run(p('inner'), 'read').status).toBe(GUARD_EXIT_SYMLINK)
    expect(run(p('leak'), 'remove').stdout.trim()).toBe('OK')
  })
})
