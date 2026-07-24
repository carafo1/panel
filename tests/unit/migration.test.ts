/**
 * tests/unit/migration.test.ts — Website Import & Migration.
 *
 * Covers the parts that are deterministic without a server: format
 * classification, the upload staging store (real filesystem), pre-flight
 * validation, and the generated WordPress configuration.
 *
 * The .wpress extractor is verified separately in
 * tests/unit/wpress-extractor.test.ts, which builds a real archive and runs
 * the shipped Python unpacker against it.
 */
import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtemp, rm, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'

// The upload store resolves its root at import time, so it is pointed at a
// scratch directory before the module loads.
const TEST_ROOT = await mkdtemp(path.join(tmpdir(), 'apsamo-upload-test-'))
process.env.MIGRATION_UPLOAD_ROOT = TEST_ROOT

const {
  normalizeExtension,
  isAllowedExtension,
  sanitizeFilename,
  formatBytes,
  storeUpload,
  beginChunkedUpload,
  storeChunk,
  finishChunkedUpload,
  getUpload,
  deleteUpload,
  sweepStaleUploads,
} = await import('../../src/lib/migration/uploads')

const { archiveKind, redactUrl } = await import('../../src/lib/migration/extract')
const { IMPORT_SOURCES } = await import('../../src/lib/migration/sources')
const { validateDetection } = await import('../../src/lib/migration/detect')
const { generateWpConfig, generatePhpIni, generateHtaccess } = await import(
  '../../src/lib/migration/wordpress'
)
const { MIGRATION_STAGES, TOTAL_STAGE_WEIGHT } = await import(
  '../../src/lib/migration/types'
)

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true })
})

// ─── Filename handling ───────────────────────────────────────────────────

describe('normalizeExtension', () => {
  const cases: Array<[string, string]> = [
    ['backup.zip', '.zip'],
    ['site.tar.gz', '.tar.gz'],
    ['site.TAR.GZ', '.tar.gz'],
    ['dump.sql.gz', '.sql.gz'],
    ['dump.sql', '.sql'],
    ['export.wpress', '.wpress'],
    ['archive.tar.bz2', '.tar.bz2'],
    ['noextension', ''],
  ]
  for (const [input, expected] of cases) {
    it(`${input} → "${expected}"`, () => {
      expect(normalizeExtension(input)).toBe(expected)
    })
  }

  it('treats compound suffixes as one unit, not just the last part', () => {
    // The whole point: path.extname would say ".gz" here, and we would try to
    // gunzip a tarball into a single unusable file.
    expect(normalizeExtension('wordpress-backup.tar.gz')).not.toBe('.gz')
  })
})

describe('isAllowedExtension', () => {
  it('accepts every supported backup format', () => {
    for (const f of [
      'a.zip',
      'a.wpress',
      'a.tar.gz',
      'a.tgz',
      'a.tar',
      'a.sql',
      'a.sql.gz',
      'a.tar.xz',
    ]) {
      expect(isAllowedExtension(f)).toBe(true)
    }
  })

  it('rejects executables and scripts', () => {
    for (const f of ['shell.php', 'run.sh', 'a.exe', 'notes.txt', 'image.png']) {
      expect(isAllowedExtension(f)).toBe(false)
    }
  })
})

describe('sanitizeFilename', () => {
  it('strips directory components', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd')
    expect(sanitizeFilename('C:\\Users\\me\\backup.zip')).toBe('backup.zip')
    expect(sanitizeFilename('/var/www/site.tar.gz')).toBe('site.tar.gz')
  })

  it('removes characters that would break a shell', () => {
    expect(sanitizeFilename('back;rm -rf.zip')).toBe('back_rm_-rf.zip')
    expect(sanitizeFilename('back`whoami`.zip')).toBe('back_whoami_.zip')
    expect(sanitizeFilename("back'or'1.zip")).toBe('back_or_1.zip')
    expect(sanitizeFilename('back$(id).zip')).toBe('back__id_.zip')
  })

  it('takes the basename first, so a slash cannot smuggle a path through', () => {
    // Everything before the last slash is discarded outright — the remainder
    // is what gets character-filtered.
    expect(sanitizeFilename('back;rm -rf /.zip')).toBe('.zip')
  })

  it('never returns an empty name', () => {
    expect(sanitizeFilename('')).toBe('upload')
    expect(sanitizeFilename('///')).toBe('upload')
  })
})

// ─── Archive classification ──────────────────────────────────────────────

// ─── Wizard/server agreement ─────────────────────────────────────────────

describe('every advertised source is actually accepted', () => {
  // The wizard's file picker offers each source's `accept` list, and the
  // upload endpoint independently decides what it will take. When those two
  // lists disagree the customer picks a file the UI told them was fine and
  // gets "not a supported backup format" — which is what happened with
  // Duplicator's .daf.
  for (const source of IMPORT_SOURCES) {
    for (const ext of source.accept) {
      it(`${source.id} advertises ${ext}, upload accepts it`, () => {
        expect(isAllowedExtension(`backup${ext}`)).toBe(true)
      })
    }
  }

  it('classifies every advertised archive extension as extractable', () => {
    for (const source of IMPORT_SOURCES) {
      for (const ext of source.accept) {
        // 'unknown' would reach extractArchive's default branch and throw
        // "Unsupported archive format" after the upload already succeeded.
        expect(archiveKind(`backup${ext}`)).not.toBe('unknown')
      }
    }
  })

  it('maps Duplicator .daf to zip without a misleading rename warning', () => {
    expect(archiveKind('package_20240101.daf')).toBe('zip')
  })
})

describe('archiveKind', () => {
  const cases: Array<[string, string]> = [
    ['site.zip', 'zip'],
    ['export.wpress', 'wpress'],
    ['backup.tar.gz', 'tar.gz'],
    ['backup.tgz', 'tar.gz'],
    ['backup.tar.bz2', 'tar.bz2'],
    ['backup.tar.xz', 'tar.xz'],
    ['backup.tar', 'tar'],
    ['db.sql', 'sql'],
    ['db.sql.gz', 'gz'],
    ['mystery.bin', 'unknown'],
  ]
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => expect(archiveKind(input)).toBe(expected))
  }
})

describe('redactUrl', () => {
  it('removes credentials from clone URLs', () => {
    expect(redactUrl('https://ghp_secrettoken@github.com/me/repo.git')).toBe(
      'https://***@github.com/me/repo.git'
    )
    expect(redactUrl('https://user:pass@gitlab.com/x/y.git')).toBe(
      'https://***@gitlab.com/x/y.git'
    )
  })

  it('leaves URLs without credentials alone', () => {
    expect(redactUrl('https://github.com/me/repo.git')).toBe(
      'https://github.com/me/repo.git'
    )
  })

  it('redacts a token embedded in an error message', () => {
    const msg = 'fatal: could not read from https://ghp_abc123@github.com/x/y.git'
    expect(redactUrl(msg)).not.toContain('ghp_abc123')
  })
})

// ─── Upload store ────────────────────────────────────────────────────────

describe('upload store', () => {
  it('stores and reads back a single-shot upload', async () => {
    const payload = Buffer.from('PK\x03\x04 fake zip contents')
    const meta = await storeUpload('user-1', 'my-site.zip', payload)

    expect(meta.uploadId).toMatch(/^[a-f0-9]{32}$/)
    expect(meta.filename).toBe('my-site.zip')
    expect(meta.extension).toBe('.zip')
    expect(meta.sizeBytes).toBe(payload.length)
    expect(meta.complete).toBe(true)

    const onDisk = await readFile(meta.storedPath)
    expect(onDisk.equals(payload)).toBe(true)

    const fetched = await getUpload(meta.uploadId, 'user-1')
    expect(fetched?.uploadId).toBe(meta.uploadId)
  })

  it('does not leak another user\'s upload', async () => {
    const meta = await storeUpload('owner', 'private.zip', Buffer.from('x'))
    // A wrong owner must be indistinguishable from a missing id, or the id
    // space becomes an enumeration oracle.
    expect(await getUpload(meta.uploadId, 'someone-else')).toBeNull()
    expect(await getUpload('f'.repeat(32), 'owner')).toBeNull()
  })

  it('rejects an upload id that is not plain hex', async () => {
    // These would otherwise reach path.join and escape the staging directory.
    for (const bad of ['../../etc/passwd', 'abc', '', '../' + 'a'.repeat(29)]) {
      expect(await getUpload(bad, 'user-1')).toBeNull()
    }
  })

  it('enforces the size limit on a buffered upload', async () => {
    await expect(
      storeUpload('user-1', 'huge.zip', Buffer.alloc(2048), { maxBytes: 1024 })
    ).rejects.toThrow(/exceeds/i)
  })

  // The chunked-upload cases do real multi-file disk I/O. On a loaded machine
  // (or Windows with a virus scanner in the path) that exceeds bun's 5s
  // default, so they declare their own budget rather than failing spuriously.
  const IO_TIMEOUT = 30_000

  it('assembles a chunked upload in the right order', async () => {
    const parts = [
      Buffer.from('first-part-'),
      Buffer.from('second-part-'),
      Buffer.from('third-part'),
    ]
    const total = parts.reduce((n, p) => n + p.length, 0)
    const begun = await beginChunkedUpload('user-2', 'big.tar.gz', parts.length, total)
    expect(begun.complete).toBe(false)

    // Deliberately out of order — chunks arrive over parallel requests and
    // assembly must not depend on arrival order.
    await storeChunk(begun.uploadId, 'user-2', 2, parts[2])
    await storeChunk(begun.uploadId, 'user-2', 0, parts[0])
    const afterThird = await storeChunk(begun.uploadId, 'user-2', 1, parts[1])
    expect(afterThird.receivedChunks).toBe(3)

    const finished = await finishChunkedUpload(begun.uploadId, 'user-2')
    expect(finished.complete).toBe(true)
    expect(finished.sizeBytes).toBe(total)

    const assembled = await readFile(finished.storedPath)
    expect(assembled.toString()).toBe('first-part-second-part-third-part')
  }, IO_TIMEOUT)

  it('refuses to assemble when a chunk never arrived', async () => {
    const begun = await beginChunkedUpload('user-3', 'gappy.zip', 3, 30)
    await storeChunk(begun.uploadId, 'user-3', 0, Buffer.from('aaaaaaaaaa'))
    await storeChunk(begun.uploadId, 'user-3', 2, Buffer.from('cccccccccc'))
    // Silently producing a truncated archive here would surface much later as
    // "your backup is corrupt", blaming the customer for our bug.
    await expect(finishChunkedUpload(begun.uploadId, 'user-3')).rejects.toThrow(
      /Chunk 1 of 3 is missing/
    )
  }, IO_TIMEOUT)

  it('rejects a chunk index outside the declared range', async () => {
    const begun = await beginChunkedUpload('user-4', 'x.zip', 2, 20)
    await expect(
      storeChunk(begun.uploadId, 'user-4', 5, Buffer.from('nope'))
    ).rejects.toThrow(/out of range/)
    await expect(
      storeChunk(begun.uploadId, 'user-4', -1, Buffer.from('nope'))
    ).rejects.toThrow(/out of range/)
  })

  it('deletes an upload and its metadata', async () => {
    const meta = await storeUpload('user-5', 'temp.zip', Buffer.from('data'))
    await deleteUpload(meta.uploadId)
    expect(await getUpload(meta.uploadId, 'user-5')).toBeNull()
  })

  it('sweeps stale uploads but keeps ones a migration claimed', async () => {
    const stale = await storeUpload('user-6', 'old.zip', Buffer.from('old'))
    const claimed = await storeUpload('user-6', 'inuse.zip', Buffer.from('busy'))

    // Backdate both, then mark one as consumed.
    for (const m of [stale, claimed]) {
      const metaFile = path.join(TEST_ROOT, `${m.uploadId}.meta.json`)
      const parsed = JSON.parse(await readFile(metaFile, 'utf8'))
      parsed.createdAt = new Date(Date.now() - 96 * 3600_000).toISOString()
      if (m.uploadId === claimed.uploadId) parsed.consumedByMigrationId = 'mig-1'
      await writeFile(metaFile, JSON.stringify(parsed))
    }

    const removed = await sweepStaleUploads(48)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(await getUpload(stale.uploadId, 'user-6')).toBeNull()
    // An in-flight import must never have its payload deleted underneath it.
    expect(await getUpload(claimed.uploadId, 'user-6')).not.toBeNull()
  }, IO_TIMEOUT)
})

describe('formatBytes', () => {
  it('formats each magnitude readably', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.5 GB')
  })
})

// ─── Pre-flight validation ───────────────────────────────────────────────

function detection(overrides: Record<string, unknown> = {}) {
  return {
    stack: 'wordpress' as const,
    rootDir: '/work/extracted',
    documentRoot: null,
    sqlFiles: ['/work/extracted/db.sql'],
    sizeBytes: 1000,
    fileCount: 10,
    warnings: [] as string[],
    wordpress: {
      version: '6.5',
      tablePrefix: 'wp_',
      siteUrl: 'https://old.example.com',
      homeUrl: 'https://old.example.com',
      hasWpContent: true,
      pluginCount: 3,
      themeCount: 1,
      isMultisite: false,
      cachePlugins: [] as string[],
    },
    ...overrides,
  }
}

describe('validateDetection', () => {
  it('passes a healthy WordPress backup', () => {
    const issues = validateDetection(detection() as never)
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0)
  })

  it('blocks multisite networks', () => {
    const d = detection()
    d.wordpress.isMultisite = true
    const errors = validateDetection(d as never).filter((i) => i.level === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toMatch(/multisite/i)
  })

  it('blocks an archive that is neither an app nor a database', () => {
    const errors = validateDetection(
      detection({ stack: 'unknown', sqlFiles: [], wordpress: undefined }) as never
    ).filter((i) => i.level === 'error')
    expect(errors).toHaveLength(1)
  })

  it('blocks a files+SQL import with no dump when one is required', () => {
    const errors = validateDetection(detection({ sqlFiles: [] }) as never, {
      requireDatabase: true,
    }).filter((i) => i.level === 'error')
    expect(errors.some((e) => /database dump is required/i.test(e.message))).toBe(true)
  })

  it('warns, but does not block, when wp-content is missing', () => {
    const d = detection()
    d.wordpress.hasWpContent = false
    const issues = validateDetection(d as never)
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(0)
    expect(issues.some((i) => i.level === 'warning' && /wp-content/.test(i.message))).toBe(
      true
    )
  })

  it('carries detection warnings through to the review screen', () => {
    const issues = validateDetection(
      detection({ warnings: ['Some entries were skipped'] }) as never
    )
    expect(issues.some((i) => i.message === 'Some entries were skipped')).toBe(true)
  })
})

// ─── Generated configuration ─────────────────────────────────────────────

const dbConfig = {
  host: 'deployhub-db-abc',
  port: 3306,
  name: 'wp_site_1234',
  user: 'wp_site_1234',
  password: "p@ss'word\"tricky",
  tablePrefix: 'xyz_',
}

describe('generateWpConfig', () => {
  const config = generateWpConfig({
    db: dbConfig,
    siteUrl: 'https://new.example.com',
  })

  it('escapes credentials so a quote cannot break out of the PHP literal', () => {
    // JSON.stringify is what makes this safe; a template-interpolated password
    // containing a quote would produce a wp-config.php that is a parse error,
    // and the site would serve a blank page.
    expect(config).toContain(JSON.stringify(dbConfig.password))
    expect(config).not.toContain(`'${dbConfig.password}'`)
  })

  it('uses the detected table prefix, not the default', () => {
    expect(config).toContain(`$table_prefix = "xyz_"`)
  })

  it('trusts the reverse proxy so HTTPS asset URLs are generated', () => {
    expect(config).toContain('HTTP_X_FORWARDED_PROTO')
    expect(config).toContain("$_SERVER['HTTPS'] = 'on'")
  })

  it('pins the site address to the new domain', () => {
    expect(config).toContain(`define('WP_HOME',    "https://new.example.com")`)
    expect(config).toContain(`define('WP_SITEURL', "https://new.example.com")`)
  })

  it('generates all eight security keys, freshly', () => {
    for (const key of [
      'AUTH_KEY',
      'SECURE_AUTH_KEY',
      'LOGGED_IN_KEY',
      'NONCE_KEY',
      'AUTH_SALT',
      'SECURE_AUTH_SALT',
      'LOGGED_IN_SALT',
      'NONCE_SALT',
    ]) {
      expect(config).toContain(`define('${key}',`)
    }
    const second = generateWpConfig({ db: dbConfig, siteUrl: 'https://new.example.com' })
    // Two invocations must not share salts, or rotating them would be pointless.
    expect(second).not.toBe(config)
  })

  it('appends a non-standard port to DB_HOST but omits the default', () => {
    expect(config).toContain(`define('DB_HOST',     "deployhub-db-abc")`)
    const odd = generateWpConfig({
      db: { ...dbConfig, port: 3307 },
      siteUrl: 'https://x.test',
    })
    expect(odd).toContain(`define('DB_HOST',     "deployhub-db-abc:3307")`)
  })

  it('is syntactically plausible PHP', () => {
    expect(config.startsWith('<?php')).toBe(true)
    expect(config).toContain("require_once ABSPATH . 'wp-settings.php';")
  })
})

describe('generatePhpIni', () => {
  it('raises the limits that break real WordPress sites', () => {
    const ini = generatePhpIni()
    expect(ini).toContain('upload_max_filesize = 256M')
    expect(ini).toContain('post_max_size = 272M') // upload + 16
    expect(ini).toContain('memory_limit = 512M')
    // Page builders exceed the default 1000 and silently lose part of a page.
    expect(ini).toContain('max_input_vars = 5000')
  })

  it('honours overrides and keeps post_max_size above upload_max_filesize', () => {
    const ini = generatePhpIni({ uploadMaxMb: 64, memoryLimitMb: 256 })
    expect(ini).toContain('upload_max_filesize = 64M')
    expect(ini).toContain('post_max_size = 80M')
    expect(ini).toContain('memory_limit = 256M')
  })
})

describe('generateHtaccess', () => {
  it('emits the standard permalink rules', () => {
    const ht = generateHtaccess()
    expect(ht).toContain('# BEGIN WordPress')
    expect(ht).toContain('RewriteEngine On')
    expect(ht).toContain('RewriteRule . /index.php [L]')
  })
})

// ─── Generated compose ───────────────────────────────────────────────────

const { generateImportCompose, generateStaticNginxConf } = await import(
  '../../src/lib/migration/compose'
)

/** Bind-mount sources the compose file expects to exist, e.g. './php.ini'. */
function bindSources(compose: string): string[] {
  return [...compose.matchAll(/^\s*-\s+\.\/([^:\s]+):/gm)].map((m) => m[1])
}

describe('generateImportCompose', () => {
  const base = {
    containerName: 'deployhub-site',
    externalPort: 30001,
    documentRoot: null,
    cpuCores: 1,
    ramMB: 512,
  }

  it('mounts only files the configure stage also writes', () => {
    // The invariant that broke: the static compose mounted ./nginx.conf, which
    // nothing generated. Docker responds to a missing bind source by creating
    // a DIRECTORY there, so nginx started against a directory-as-config and
    // exited — a static import could never come up.
    //
    // 'site' is the extracted tree; every other bind source must be a file
    // some generator produces.
    const generated = new Set(['site', 'php.ini', 'nginx.conf'])
    for (const stack of ['wordpress', 'php', 'static']) {
      const compose = generateImportCompose({ ...base, stack })
      for (const src of bindSources(compose)) {
        expect({ stack, src, known: generated.has(src) }).toEqual({
          stack,
          src,
          known: true,
        })
      }
    }
  })

  it('gives PHP-based stacks their php.ini and static sites their nginx.conf', () => {
    expect(bindSources(generateImportCompose({ ...base, stack: 'wordpress' }))).toContain(
      'php.ini'
    )
    expect(bindSources(generateImportCompose({ ...base, stack: 'php' }))).toContain(
      'php.ini'
    )
    const staticSources = bindSources(generateImportCompose({ ...base, stack: 'static' }))
    expect(staticSources).toContain('nginx.conf')
    expect(staticSources).not.toContain('php.ini')
  })

  it('serves the site from a subdirectory, never the project root', () => {
    // deployPath holds docker-compose.yml and php.ini alongside the site. If
    // the document root were deployPath itself, the compose file would be
    // downloadable from the live website.
    for (const stack of ['wordpress', 'php', 'static']) {
      const compose = generateImportCompose({ ...base, stack })
      expect(compose).toContain('./site:')
    }
  })

  it('applies the plan resource limits', () => {
    const compose = generateImportCompose({ ...base, stack: 'wordpress', cpuCores: 2, ramMB: 2048 })
    expect(compose).toContain("cpus: '2'")
    expect(compose).toContain('memory: 2048M')
  })

  it('publishes the allocated host port', () => {
    const compose = generateImportCompose({ ...base, stack: 'static', externalPort: 34567 })
    expect(compose).toContain('"34567:80"')
  })
})

describe('generateStaticNginxConf', () => {
  it('roots at /site when there is no document root', () => {
    expect(generateStaticNginxConf(null)).toContain('root /site;')
  })

  it('roots at the detected document root', () => {
    expect(generateStaticNginxConf('dist')).toContain('root /site/dist;')
    // Leading/trailing slashes from detection must not produce '/site//dist/'.
    expect(generateStaticNginxConf('/build/')).toContain('root /site/build;')
  })

  it('falls back to index.html so deep links in an SPA do not 404', () => {
    expect(generateStaticNginxConf(null)).toContain('try_files $uri $uri/ /index.html')
  })

  it('does not let the entry point be cached immutably', () => {
    // Fingerprinted assets are immutable; index.html must not be, or a
    // redeploy keeps serving the old shell from the browser cache.
    const conf = generateStaticNginxConf(null)
    expect(conf).toContain('location = /index.html')
    expect(conf).toContain('no-cache')
  })
})

// ─── Stage plan ──────────────────────────────────────────────────────────

describe('stage plan', () => {
  it('has unique, ordered stage names', () => {
    const names = MIGRATION_STAGES.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('weights sum to the published total, so progress reaches 100%', () => {
    const sum = MIGRATION_STAGES.reduce((n, s) => n + s.weight, 0)
    expect(sum).toBe(TOTAL_STAGE_WEIGHT)
    expect(sum).toBeGreaterThan(0)
  })

  it('starts by preparing and ends by going live', () => {
    expect(MIGRATION_STAGES[0].name).toBe('prepare')
    expect(MIGRATION_STAGES[MIGRATION_STAGES.length - 1].name).toBe('finalize')
  })

  it('verifies the site before finalizing it', () => {
    const verify = MIGRATION_STAGES.findIndex((s) => s.name === 'verify')
    const finalize = MIGRATION_STAGES.findIndex((s) => s.name === 'finalize')
    expect(verify).toBeGreaterThan(-1)
    expect(verify).toBeLessThan(finalize)
  })

  it('snapshots before it imports files, so rollback has something to restore', () => {
    const snapshot = MIGRATION_STAGES.findIndex((s) => s.name === 'snapshot')
    const importFiles = MIGRATION_STAGES.findIndex((s) => s.name === 'import_files')
    expect(snapshot).toBeLessThan(importFiles)
  })
})
