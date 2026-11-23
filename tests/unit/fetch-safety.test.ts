/**
 * tests/unit/fetch-safety.test.ts
 *
 * "Import from URL" used to run `curl -fsSL <url>` as root on the server: it
 * followed redirects and re-resolved the host after the SSRF check, so a URL
 * could land on cloud metadata or localhost. lib/migration/fetch-safety
 * re-checks the address, pins curl/git to it and never follows redirects.
 */
import { describe, it, expect } from 'bun:test'
import {
  resolvePinnedTarget,
  buildSafeDownloadCommand,
  parseDownloadStatus,
  safeGitCloneConfig,
  CURL_STATUS_MARKER,
} from '../../src/lib/migration/fetch-safety'

const lookupTo = (...addresses: string[]) => async () => addresses.map((address) => ({ address }))

describe('resolvePinnedTarget', () => {
  it('pins to a public address, preferring IPv4', async () => {
    const t = await resolvePinnedTarget('https://files.example.com/b.zip', lookupTo('2606:4700::1', '93.184.216.34'))
    expect(t).toEqual({ host: 'files.example.com', port: 443, address: '93.184.216.34', isIpLiteral: false })
    const h = await resolvePinnedTarget('http://files.example.com:8080/b.zip', lookupTo('93.184.216.34'))
    expect(h.port).toBe(8080)
  })

  it('refuses when ANY resolved address is private (DNS rebinding / mixed answers)', async () => {
    for (const bad of ['169.254.169.254', '127.0.0.1', '10.0.0.5', '::1']) {
      await expect(resolvePinnedTarget('https://evil.example/x', lookupTo('93.184.216.34', bad))).rejects.toThrow()
    }
  })

  it('refuses private IP literals and non-http schemes', async () => {
    await expect(resolvePinnedTarget('http://169.254.169.254/latest/meta-data/')).rejects.toThrow()
    await expect(resolvePinnedTarget('http://[::1]/x')).rejects.toThrow()
    await expect(resolvePinnedTarget('file:///etc/passwd')).rejects.toThrow()
    await expect(resolvePinnedTarget('not a url')).rejects.toThrow()
  })
})

describe('buildSafeDownloadCommand', () => {
  const target = { host: 'files.example.com', port: 443, address: '93.184.216.34', isIpLiteral: false }

  it('never follows redirects, limits protocols and pins the address', () => {
    const cmd = buildSafeDownloadCommand('https://files.example.com/b.zip', '/opt/m/w/b.zip', target)
    expect(cmd).toContain('--proto =https,http')
    expect(cmd).toContain('--max-redirs 0')
    expect(cmd).not.toMatch(/(^|\s)-[a-zA-Z]*L/)
    expect(cmd).not.toContain('--location')
    expect(cmd).toContain('--resolve files.example.com:443:93.184.216.34')
    expect(cmd).toContain('--url https://files.example.com/b.zip')
    expect(cmd).toContain('-o /opt/m/w/b.zip')
  })

  it('brackets IPv6 pins, skips --resolve for IP-literal URLs, and quotes hostile URLs', () => {
    const v6 = buildSafeDownloadCommand('https://h.example/x', '/d', { ...target, host: 'h.example', address: '2606:4700::1' })
    expect(v6).toContain(`--resolve 'h.example:443:[2606:4700::1]'`)
    const lit = buildSafeDownloadCommand('https://93.184.216.34/x', '/d', { host: '93.184.216.34', port: 443, address: '93.184.216.34', isIpLiteral: true })
    expect(lit).not.toContain('--resolve')
    const q = buildSafeDownloadCommand("https://h.example/a';rm -rf /;'", '/d', target)
    expect(q).toContain(`--url 'https://h.example/a'\\'';rm -rf /;'\\'''`)
  })
})

describe('parseDownloadStatus', () => {
  it('reads the status and redirect target', () => {
    expect(parseDownloadStatus(`${CURL_STATUS_MARKER}200 `)).toEqual({ status: 200, redirect: null })
    expect(parseDownloadStatus(`${CURL_STATUS_MARKER}302 http://169.254.169.254/`)).toEqual({
      status: 302,
      redirect: 'http://169.254.169.254/',
    })
    expect(parseDownloadStatus('curl: (6) Could not resolve host')).toEqual({ status: 0, redirect: null })
  })
})

describe('safeGitCloneConfig', () => {
  it('disables redirects, non-http transports and pins the host', () => {
    const c = safeGitCloneConfig({ host: 'github.com', port: 443, address: '140.82.112.3', isIpLiteral: false })
    expect(c).toContain('-c http.followRedirects=false')
    expect(c).toContain('-c protocol.allow=never')
    expect(c).toContain('-c http.curloptResolve=github.com:443:140.82.112.3')
  })
})
