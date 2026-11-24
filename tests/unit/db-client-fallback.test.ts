/**
 * The Database Studio runs whichever MySQL-family client the container has:
 * mysql:8 images have no `mariadb` binary, which made every query fail.
 */
import { describe, it, expect } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mysqlFamilyClient } from '@/lib/db-engine/exec'

const SH = process.platform === 'win32' ? 'C:/Users/kct/dev/git/bin/bash.exe' : '/bin/sh'

describe.skipIf(process.platform === 'win32' || !existsSync(SH))('MySQL-family client selection', () => {
  const run = (bins: string[], args: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'dbclient-'))
    for (const b of bins) {
      writeFileSync(join(dir, b), `#!/bin/sh\necho "${b}:$*"\n`)
      chmodSync(join(dir, b), 0o755)
    }
    const [cmd, ...rest] = mysqlFamilyClient('mariadb', 'mysql')
    const r = Bun.spawnSync([cmd, ...rest, ...args], { env: { PATH: `${dir}:/usr/bin:/bin` } })
    rmSync(dir, { recursive: true, force: true })
    return r.stdout.toString().trim()
  }

  it('uses mariadb when present', () => {
    expect(run(['mariadb', 'mysql'], ['-uuser', '--batch', 'db'])).toBe('mariadb:-uuser --batch db')
  })

  it('falls back to mysql in a MySQL image', () => {
    expect(run(['mysql'], ['-uuser', '--batch', 'db'])).toBe('mysql:-uuser --batch db')
  })

  it('passes arguments as data, never as shell code', () => {
    expect(run(['mysql'], ['-u$(touch /tmp/pwned)', 'db;rm'])).toBe('mysql:-u$(touch /tmp/pwned) db;rm')
  })
})

describe('addresses published in customer DNS', () => {
  it('only public IPv4 addresses qualify', async () => {
    const { isPublicIpv4 } = await import('@/lib/custom-domains')
    for (const ip of ['89.58.2.127', '8.8.8.8', '203.0.113.9']) expect(isPublicIpv4(ip)).toBe(true)
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.4', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '256.1.1.1', 'localhost', ''])
      expect(isPublicIpv4(ip)).toBe(false)
  })
})
