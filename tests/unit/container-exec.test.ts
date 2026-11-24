/**
 * tests/unit/container-exec.test.ts
 *
 * The web terminal and cron jobs run customer commands. On a localhost server
 * they used to run straight on the panel host as root, with the panel's own
 * secrets in the environment. They now run only through
 * buildContainerExecCommand (lib/vps/terminal.ts): `docker exec` into the
 * project's container, docker CLI started with `env -i`, refused when the
 * container is not running.
 *
 * The shell tests use a fake `docker` on PATH that records nothing and runs
 * the inner `sh -c` locally, so they check quoting, the environment and the
 * refusal path without a Docker daemon.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildContainerExecCommand,
  isSafeContainerName,
  parseTerminalOutput,
  TERMINAL_SCRIPT,
  CONTAINER_NOT_RUNNING_MARKER,
  TerminalError,
} from '../../src/lib/vps/terminal'

describe('isSafeContainerName', () => {
  it('accepts the names the deployer creates', () => {
    expect(isSafeContainerName('deployhub-my-shop')).toBe(true)
    expect(isSafeContainerName('deployhub_shop.1')).toBe(true)
  })
  it('refuses empty, option-like and shell-meaningful names', () => {
    for (const n of ['', null, undefined, '-rm', '--privileged', 'a;b', 'a b', '$(id)', 'a/b']) {
      expect(isSafeContainerName(n as string)).toBe(false)
    }
  })
})

describe('buildContainerExecCommand', () => {
  it('always goes through docker exec with a minimal environment', () => {
    const cmd = buildContainerExecCommand('deployhub-shop', TERMINAL_SCRIPT, ['/app', 'ls'])
    expect(cmd).toContain('docker exec deployhub-shop sh -c ')
    expect(cmd).toContain('env -i PATH="$PATH"')
    expect(cmd).toContain("docker container inspect -f '{{.State.Running}}' deployhub-shop")
    expect(cmd).toContain(CONTAINER_NOT_RUNNING_MARKER)
  })
  it('throws a 409 TerminalError for a missing or unsafe container name', () => {
    expect(() => buildContainerExecCommand('', 'true')).toThrow(TerminalError)
    try {
      buildContainerExecCommand('--privileged', 'true')
    } catch (e) {
      expect((e as TerminalError).status).toBe(409)
    }
  })
})

describe('parseTerminalOutput', () => {
  it('splits output, exit code and cwd', () => {
    expect(parseTerminalOutput('hello\n\n__APSAMO_EXIT:3:/var/www\n')).toEqual({
      body: 'hello',
      exitCode: 3,
      cwd: '/var/www',
    })
  })
  it('handles empty output', () => {
    expect(parseTerminalOutput('\n__APSAMO_EXIT:0:/app\n')).toEqual({ body: '', exitCode: 0, cwd: '/app' })
  })
  it('returns the raw output when the trailer is missing (e.g. the command ran `exit`)', () => {
    expect(parseTerminalOutput('a\n')).toEqual({ body: 'a\n', exitCode: null, cwd: null })
  })
})

describe('container exec through a shell (fake docker)', () => {
  let dir: string
  const canRun = process.platform !== 'win32'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'apsamo-fake-docker-'))
    writeFileSync(
      join(dir, 'docker'),
      [
        '#!/bin/sh',
        'if [ "$1" = container ] && [ "$2" = inspect ]; then',
        '  case "$5" in stopped-*) echo false;; *) echo true;; esac; exit 0',
        'fi',
        'if [ "$1" = exec ]; then',
        '  [ -n "$PANEL_SECRET_FOR_TEST" ] && echo LEAKED >&2',
        '  shift 2; exec "$@"',
        'fi',
        'exit 9',
      ].join('\n')
    )
    chmodSync(join(dir, 'docker'), 0o755)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const run = (cmd: string) => {
    const r = Bun.spawnSync(['bash', '-lc', cmd], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PANEL_SECRET_FOR_TEST: 'secret' },
    })
    return { stdout: r.stdout.toString(), stderr: r.stderr.toString(), exitCode: r.exitCode }
  }

  it.skipIf(!canRun)('runs the command, keeps cd, reports exit code and cwd', () => {
    const r = run(buildContainerExecCommand('deployhub-shop', TERMINAL_SCRIPT, ['/tmp', "cd / && echo 'hi there'; false"]))
    const p = parseTerminalOutput(r.stdout)
    expect(p.body).toBe('hi there')
    expect(p.exitCode).toBe(1)
    expect(p.cwd).toBe('/')
  })

  it.skipIf(!canRun)('does not pass the panel environment to the docker CLI', () => {
    const r = run(buildContainerExecCommand('deployhub-shop', TERMINAL_SCRIPT, ['', 'echo "[$PANEL_SECRET_FOR_TEST]"']))
    expect(r.stderr).not.toContain('LEAKED')
    expect(parseTerminalOutput(r.stdout).body).toBe('[]')
  })

  it.skipIf(!canRun)('quotes the customer command: it cannot break out of the argument', () => {
    const marker = join(dir, 'pwned')
    run(buildContainerExecCommand('deployhub-shop', TERMINAL_SCRIPT, ['/tmp', `x'; touch ${marker}; '`]))
    expect(existsSync(marker)).toBe(false)
  })

  it.skipIf(!canRun)('refuses when the container is not running', () => {
    const r = run(buildContainerExecCommand('stopped-shop', TERMINAL_SCRIPT, ['/tmp', 'echo should-not-run']))
    expect(r.exitCode).toBe(125)
    expect(r.stderr).toContain(CONTAINER_NOT_RUNNING_MARKER)
    expect(r.stdout).not.toContain('should-not-run')
  })

  it.skipIf(!canRun)('cron script folds stderr into the output', () => {
    const r = run(buildContainerExecCommand('deployhub-shop', 'eval "$1" 2>&1', ['echo ok; echo err >&2']))
    expect(r.stdout).toBe('ok\nerr\n')
  })
})
