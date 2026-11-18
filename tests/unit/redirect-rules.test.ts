/**
 * tests/unit/redirect-rules.test.ts — redirect values must not be able to
 * inject Caddyfile syntax (src/lib/vps/redirect-rules.ts).
 */
import { describe, it, expect } from 'bun:test'
import {
  caddyRedirLine,
  isSafeRedirect,
  redirectFromPathError,
  redirectToUrlError,
  redirectStatusError,
  RedirectValidationError,
} from '../../src/lib/vps/redirect-rules'

describe('redirect fromPath', () => {
  for (const ok of ['/old', '/old-page/', '/blog/*', '/a/b.html', '/%E2%9C%93', '/search?q=x']) {
    it(`accepts ${ok}`, () => expect(redirectFromPathError(ok)).toBeNull())
  }
  const bad = [
    '',
    'old',
    '/a b',
    '/a\nb',
    '/x\n}\nevil.com {\n  reverse_proxy 127.0.0.1:8080\n}',
    '/a{b}',
    '/{http.request.header.Cookie}',
    '/a"b',
    "/a'b",
    '/a`b',
    '/a\\b',
    '/a#b',
    '/a\tb',
    '/a\u0085b',
    '/a b',
    '/a b',
    '/a\u0000b',
    '/' + 'a'.repeat(3000),
  ]
  for (const b of bad) {
    it(`rejects ${JSON.stringify(b).slice(0, 40)}`, () => expect(redirectFromPathError(b)).not.toBeNull())
  }
  it('rejects non-strings', () => {
    expect(redirectFromPathError(undefined)).not.toBeNull()
    expect(redirectFromPathError(5)).not.toBeNull()
  })
})

describe('redirect toUrl', () => {
  for (const ok of [
    'https://example.com/new',
    'http://example.com',
    'https://example.com/a?x=1&y=2#frag',
    '/new-page',
  ]) {
    it(`accepts ${ok}`, () => expect(redirectToUrlError(ok)).toBeNull())
  }
  const bad = [
    '',
    'example.com',
    'javascript:alert(1)',
    'ftp://example.com',
    'https://example.com/a b',
    'https://example.com/\n}\nevil.com {',
    'https://example.com/{query.x}',
    'https://example.com/"',
    'https://example.com/\\',
    'https://',
  ]
  for (const b of bad) {
    it(`rejects ${JSON.stringify(b).slice(0, 40)}`, () => expect(redirectToUrlError(b)).not.toBeNull())
  }
})

describe('status code', () => {
  it('allows only 301 and 302', () => {
    expect(redirectStatusError(301)).toBeNull()
    expect(redirectStatusError(302)).toBeNull()
    expect(redirectStatusError(307)).not.toBeNull()
    expect(redirectStatusError('301')).not.toBeNull()
  })
})

describe('caddyRedirLine (generator-side re-validation)', () => {
  it('emits a single safe directive', () => {
    expect(caddyRedirLine({ fromPath: '/old', toUrl: 'https://x.com/new', statusCode: 301 })).toBe(
      'redir /old https://x.com/new 301'
    )
  })

  it('throws on an injected value even if it bypassed storage validation', () => {
    expect(() =>
      caddyRedirLine({ fromPath: '/x\n}\nevil.com {', toUrl: 'https://x.com', statusCode: 301 })
    ).toThrow(RedirectValidationError)
    expect(() =>
      caddyRedirLine({ fromPath: '/x', toUrl: 'https://x.com/ }', statusCode: 302 })
    ).toThrow(RedirectValidationError)
    expect(() => caddyRedirLine({ fromPath: '/x', toUrl: '/y', statusCode: 999 })).toThrow()
  })

  it('treats untrimmed stored values as unsafe', () => {
    expect(isSafeRedirect({ fromPath: ' /x', toUrl: '/y', statusCode: 301 })).toBe(false)
  })
})
