/**
 * Whole-account backups (Hostinger `domains/<domain>/public_html`) contain
 * several WordPress sites. The import must take the one for this website's
 * domain and that site's own database dump, not the first alphabetically.
 */
import { describe, expect, test } from 'bun:test'
import { chooseSiteRoot, importSourceDir, normalizeHost, preferDumpsForDatabase } from '../../src/lib/migration/detect'

const X = '/w/extracted'
const sites = [
  `${X}/domains/kobciyeskills.com/public_html`,
  `${X}/domains/albait.so/public_html`,
  `${X}/domains/qansorobad.so/public_html`,
]

describe('normalizeHost', () => {
  test('strips scheme, www, port and path', () => {
    expect(normalizeHost('https://www.Qansorobad.so:443/shop')).toBe('qansorobad.so')
    expect(normalizeHost('qansorobad.so')).toBe('qansorobad.so')
  })
})

describe('chooseSiteRoot', () => {
  test('picks the folder named after the website domain', () => {
    expect(chooseSiteRoot(sites, ['https://qansorobad.so'])).toEqual({
      root: `${X}/domains/qansorobad.so/public_html`,
      matched: true,
    })
  })

  test('matches a www target against a bare folder name', () => {
    expect(chooseSiteRoot(sites, ['https://www.albait.so/'])!.root).toBe(`${X}/domains/albait.so/public_html`)
  })

  test('without a match, takes the shallowest then alphabetical and says so', () => {
    expect(chooseSiteRoot(sites, ['https://other.com'])).toEqual({
      root: `${X}/domains/albait.so/public_html`,
      matched: false,
    })
  })

  test('no candidates gives null', () => {
    expect(chooseSiteRoot([], ['a.com'])).toBeNull()
  })
})

describe('preferDumpsForDatabase', () => {
  const dumps = [
    `${X}/databases/u317305639_BIG.sql.gz`,
    `${X}/databases/u317305639_IWDFJ.sql.gz`,
    `${X}/databases/u317305639_OTHER.sql`,
  ]

  test('the dump named in wp-config.php comes first', () => {
    expect(preferDumpsForDatabase(dumps, 'u317305639_IWDFJ', X)[0]).toBe(`${X}/databases/u317305639_IWDFJ.sql.gz`)
  })

  test('a separately uploaded dump always stays first', () => {
    const uploaded = '/w/u317305639_IWDFJ.20261125.sql.gz'
    const out = preferDumpsForDatabase([uploaded, ...dumps], 'u317305639_OTHER', X)
    expect(out[0]).toBe(uploaded)
    expect(out[1]).toBe(`${X}/databases/u317305639_OTHER.sql`)
  })

  test('unknown database name keeps the ranking', () => {
    expect(preferDumpsForDatabase(dumps, null, X)).toEqual(dumps)
  })

  test('a prefix of another name does not match', () => {
    const out = preferDumpsForDatabase([`${X}/a/wp_site2.sql`, `${X}/a/wp_site.sql`], 'wp_site', X)
    expect(out[0]).toBe(`${X}/a/wp_site.sql`)
  })
})

describe('importSourceDir', () => {
  test('copies the detected site folder, not the whole backup', () => {
    expect(importSourceDir(`${X}/domains/qansorobad.so/public_html`, X)).toBe(`${X}/domains/qansorobad.so/public_html`)
    expect(importSourceDir(`${X}/public_html/`, `${X}/`)).toBe(`${X}/public_html`)
  })
  test('falls back to the extraction root when the root is missing or outside it', () => {
    expect(importSourceDir(null, X)).toBe(X)
    expect(importSourceDir('/etc', X)).toBe(X)
    expect(importSourceDir(`${X}-evil/x`, X)).toBe(X)
  })
})

import { dumpReader } from '../../src/lib/migration/detect'

describe('dumpReader', () => {
  test('decompresses gzipped dumps before searching them', () => {
    expect(dumpReader('/w/db.sql.gz')).toMatch(/^gzip -dc .*\/w\/db\.sql\.gz/)
    expect(dumpReader('/w/DB.SQL.GZ')).toMatch(/^gzip -dc /)
    expect(dumpReader('/w/db.sql')).toMatch(/^cat .*\/w\/db\.sql/)
  })
})
