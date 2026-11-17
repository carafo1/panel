/**
 * FTP accounts are system users inside the project's container. The old code
 * ran BusyBox-only `adduser -D -H` and swallowed every error, so on a
 * Debian/Ubuntu-based container no user was created while the panel reported
 * success. These tests run the real scripts against stub tools that behave
 * like each distro, so the branching is exercised without Docker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildFtpCreateUserScript,
  buildFtpSetPasswordScript,
  buildFtpDeleteUserScript,
} from '../../src/lib/vps/ftp'

const SH = Bun.which('sh')

let dir: string
let log: string

/** POSIX form of a path (Git Bash on Windows wants /c/Users/..., not C:\Users\...). */
const posix = (p: string) =>
  process.platform === 'win32' ? p.replace(/^([A-Za-z]):\\/, (_, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : p

/**
 * Install stub commands. Each appends "<name> <args>" to the log. Stubs use
 * only shell built-ins, because the scripts run with the stub dir as the
 * ONLY entry on PATH (see run()).
 */
function stub(name: string, body = '') {
  const file = join(dir, name)
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${posix(log)}"\n${body}\n`)
  chmodSync(file, 0o755)
}

/**
 * Run a script with ONLY the stub dir on PATH. A real Linux machine (CI) has
 * useradd/userdel/chpasswd in /usr/sbin; if those stay reachable they shadow
 * a missing stub and the "no such tool" branches can never be tested. (On
 * Windows, Git Bash also puts its own /usr/bin first, so PATH is set inside
 * the script rather than in the spawn environment.)
 */
function run(script: string, stdinLog = false) {
  // chpasswd records what it read on stdin so we can check the password line.
  if (stdinLog) stub('chpasswd', `while IFS= read -r line || [ -n "$line" ]; do echo "$line" >> "${posix(log)}"; done`)
  const r = Bun.spawnSync([SH!, '-c', `PATH="${posix(dir)}"; export PATH\n${script}`], {
    env: { ...process.env, HOME: dir },
  })
  return { code: r.exitCode, stderr: r.stderr.toString(), log: existsSync(log) ? readFileSync(log, 'utf8') : '' }
}

describe.skipIf(!SH)('FTP container scripts', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ftp-stubs-'))
    log = join(dir, 'calls.log')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('Debian/Ubuntu: uses useradd, not BusyBox adduser flags', () => {
    stub('id', 'exit 1') // user does not exist yet
    stub('useradd')
    stub('adduser', 'echo "adduser: unknown option -D" >&2; exit 1') // Debian's Perl adduser
    const r = run(buildFtpCreateUserScript('bob_site', 's3cret!'), true)
    expect(r.code).toBe(0)
    expect(r.log).toContain('useradd -M -s /bin/false bob_site')
    expect(r.log).not.toContain('adduser -D')
    expect(r.log).toContain('bob_site:s3cret!')
  })

  it('Alpine/BusyBox: falls back to adduser -D -H', () => {
    stub('id', 'exit 1')
    stub('adduser')
    const r = run(buildFtpCreateUserScript('bob_site', 'pw123456'), true)
    expect(r.code).toBe(0)
    expect(r.log).toContain('adduser -D -H -s /bin/false bob_site')
    expect(r.log).toContain('bob_site:pw123456')
  })

  it('does not recreate a user that already exists, just sets the password', () => {
    stub('id', 'exit 0')
    stub('useradd')
    const r = run(buildFtpCreateUserScript('bob_site', 'pw123456'), true)
    expect(r.code).toBe(0)
    expect(r.log).not.toContain('useradd')
    expect(r.log).toContain('bob_site:pw123456')
  })

  it('FAILS (non-zero) when user creation fails, instead of reporting success', () => {
    stub('id', 'exit 1')
    stub('useradd', 'echo "useradd: cannot lock /etc/passwd" >&2; exit 1')
    stub('chpasswd')
    const r = run(buildFtpCreateUserScript('bob_site', 'pw123456'))
    expect(r.code).not.toBe(0)
    expect(r.stderr).toContain('cannot lock')
    expect(r.log).not.toContain('chpasswd') // never got as far as the password
  })

  it('fails clearly when the container has no user-management tools', () => {
    stub('id', 'exit 1')
    const r = run(buildFtpCreateUserScript('bob_site', 'pw123456'))
    expect(r.code).toBe(3)
    expect(r.stderr).toContain('neither useradd nor adduser')
  })

  it('fails clearly when chpasswd is missing', () => {
    const r = run(buildFtpSetPasswordScript('bob_site', 'pw123456'))
    expect(r.code).toBe(4)
  })

  it('passes passwords with quotes and spaces through intact', () => {
    const pw = `it's a "pass" $HOME`
    const r = run(buildFtpSetPasswordScript('bob_site', pw), true)
    expect(r.code).toBe(0)
    expect(r.log).toContain(`bob_site:${pw}`)
  })

  it('delete: prefers userdel (Debian), falls back to deluser (Alpine), ok if already gone', () => {
    stub('id', 'exit 0')
    stub('userdel')
    stub('deluser')
    expect(run(buildFtpDeleteUserScript('bob_site')).log).toContain('userdel bob_site')

    rmSync(join(dir, 'userdel'))
    rmSync(log, { force: true })
    expect(run(buildFtpDeleteUserScript('bob_site')).log).toContain('deluser bob_site')

    stub('id', 'exit 1')
    rmSync(log, { force: true })
    const gone = run(buildFtpDeleteUserScript('bob_site'))
    expect(gone.code).toBe(0)
    expect(gone.log).not.toContain('deluser')
  })

  it('delete reports failure instead of hiding a still-live account', () => {
    stub('id', 'exit 0')
    stub('userdel', 'echo "userdel: user bob_site is currently used by process 42" >&2; exit 8')
    const r = run(buildFtpDeleteUserScript('bob_site'))
    expect(r.code).toBe(8)
  })
})
