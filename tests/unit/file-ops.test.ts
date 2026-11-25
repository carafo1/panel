/**
 * tests/unit/file-ops.test.ts
 *
 * The file manager's server-side actions (src/lib/vps/file-ops.ts) run as
 * root on a shared host: modes, archive limits, link collisions, managed
 * files and the exact shell they build. Also the in-memory demo tree
 * (src/lib/vps/demo-files.ts) the e2e suite drives, and the dialog helpers
 * in the client's file-utils.ts.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import {
  ARCHIVE_TIME_LIMIT_SECONDS,
  EXIT_NOT_A_FOLDER,
  EXIT_TARGET_EXISTS,
  EXIT_TOO_LARGE,
  MAX_SELECTION,
  archiveContentTotals,
  archiveKindOf,
  archiveMemberNames,
  chmodCommand,
  copyMoveCommand,
  extractCommand,
  extractSucceeded,
  findManagedCollisions,
  findSymlinkCollisions,
  isDocumentRoot,
  isManagedRelPath,
  isSameOrInside,
  listDestSymlinksCommand,
  normalizeRel,
  parseOctalMode,
  previewContentType,
  previewHeaders,
  validateEntryName,
  validateSelection,
  zipCommand,
  zipFileName,
} from '../../src/lib/vps/file-ops'
import { ARCHIVE_LIST_SEPARATOR as SEP } from '../../src/lib/vps/archive-safety'
import {
  DemoFsError,
  demoChmod,
  demoCompress,
  demoCopy,
  demoExtract,
  demoList,
  demoRead,
  demoRemove,
  demoRename,
  demoWrite,
  resetDemoFiles,
} from '../../src/lib/vps/demo-files'
import {
  defaultZipName,
  describeOctal,
  gridFromOctal,
  octalFromGrid,
  previewKind,
  validateOctalMode,
} from '../../src/components/hosting/site/file-utils'

describe('parseOctalMode', () => {
  it('accepts plain three-digit modes and strips a leading zero', () => {
    expect(parseOctalMode('644')).toEqual({ ok: true, mode: '644' })
    expect(parseOctalMode('0755')).toEqual({ ok: true, mode: '755' })
    expect(parseOctalMode(' 600 ')).toEqual({ ok: true, mode: '600' })
  })
  it('allows the sticky bit', () => {
    expect(parseOctalMode('1777')).toEqual({ ok: true, mode: '1777' })
  })
  it('refuses setuid and setgid', () => {
    for (const m of ['4755', '2755', '6755', '7777', '3777']) {
      const r = parseOctalMode(m)
      expect(r.ok).toBe(false)
    }
  })
  it('refuses anything that is not octal', () => {
    for (const m of ['', '8', '64', '888', '12345', 'rwx', '7;rm -rf /', '0x1ff', null, undefined, {}]) {
      expect(parseOctalMode(m as never).ok).toBe(false)
    }
  })
})

describe('chmodCommand', () => {
  it('quotes the path and ends options before it', () => {
    expect(chmodCommand("/srv/s/site/a b'c.php", { mode: '644' })).toBe(`chmod 644 -- '/srv/s/site/a b'\\''c.php'`)
  })
  it('recursive: folders and files separately, never following links', () => {
    const cmd = chmodCommand('/srv/s/site/wp-content', { recursive: true, dirMode: '755', fileMode: '644' })
    expect(cmd).toContain(`exit ${EXIT_NOT_A_FOLDER}`)
    expect(cmd).toContain('find -P /srv/s/site/wp-content -xdev -type d -exec chmod 755 -- {} +')
    expect(cmd).toContain('find -P /srv/s/site/wp-content -xdev -type f -exec chmod 644 -- {} +')
    expect(cmd).not.toContain('-R')
  })
  it('refuses a mode that did not pass validation', () => {
    expect(() => chmodCommand('/x', { mode: '4755' })).toThrow()
    expect(() => chmodCommand('/x', { mode: '644; reboot' })).toThrow()
    expect(() => chmodCommand('/x', { recursive: true, dirMode: '755', fileMode: '0644' })).toThrow()
  })
})

describe('names and selections', () => {
  it('normalizes relative paths', () => {
    expect(normalizeRel('./site//wp-content/')).toBe('site/wp-content')
    expect(normalizeRel('.')).toBe('')
    expect(normalizeRel('')).toBe('')
  })
  it('validates a single name', () => {
    expect(validateEntryName('backup.zip')).toBeNull()
    expect(validateEntryName('')).not.toBeNull()
    expect(validateEntryName('..')).not.toBeNull()
    expect(validateEntryName('a/b')).not.toBeNull()
    expect(validateEntryName('a\\b')).not.toBeNull()
    expect(validateEntryName('a\nb')).not.toBeNull()
    expect(validateEntryName('x'.repeat(256))).not.toBeNull()
    expect(validateEntryName(42)).not.toBeNull()
  })
  it('zip names get .zip once', () => {
    expect(zipFileName('site-files')).toEqual({ ok: true, name: 'site-files.zip' })
    expect(zipFileName('Site.ZIP')).toEqual({ ok: true, name: 'Site.ZIP' })
    expect(zipFileName('../x').ok).toBe(false)
  })
  it('validates selections', () => {
    expect(validateSelection(['site/a', './site/a', 'site/b'])).toEqual({ ok: true, paths: ['site/a', 'site/b'] })
    expect(validateSelection([]).ok).toBe(false)
    expect(validateSelection('site/a').ok).toBe(false)
    expect(validateSelection(['.']).ok).toBe(false)
    expect(validateSelection(['site/../../etc']).ok).toBe(false)
    expect(validateSelection([1]).ok).toBe(false)
    expect(validateSelection(Array.from({ length: MAX_SELECTION + 1 }, (_, i) => `f${i}`)).ok).toBe(false)
  })
  it('knows what is inside what', () => {
    expect(isSameOrInside('site', 'site')).toBe(true)
    expect(isSameOrInside('site', 'site/wp-content')).toBe(true)
    expect(isSameOrInside('site', 'site2')).toBe(false)
    expect(isSameOrInside('', 'anything')).toBe(true)
  })
  it('recognizes platform files only at the root', () => {
    expect(isManagedRelPath('docker-compose.yml')).toBe(true)
    expect(isManagedRelPath('Dockerfile')).toBe(true)
    expect(isManagedRelPath('site/Dockerfile')).toBe(false)
    expect(isManagedRelPath('index.php')).toBe(false)
    expect(isDocumentRoot('site')).toBe(true)
    expect(isDocumentRoot('site/wp-content')).toBe(false)
  })
})

describe('archives', () => {
  it('detects the archive kind from the name', () => {
    expect(archiveKindOf('a.zip')).toBe('zip')
    expect(archiveKindOf('a.TAR.GZ')).toBe('tar.gz')
    expect(archiveKindOf('a.tgz')).toBe('tar.gz')
    expect(archiveKindOf('a.tar')).toBe('tar')
    expect(archiveKindOf('a.rar')).toBeNull()
    expect(archiveKindOf('zip')).toBeNull()
  })

  const zipListing = [
    'Archive:  /tmp/apsamo-extract-1.zip',
    'Zip file size: 1234 bytes, number of entries: 3',
    'drwxr-xr-x  3.0 unx        0 bx stor 24-Jan-01 12:00 public/',
    '-rw-r--r--  3.0 unx     2048 tx defN 24-Jan-01 12:00 public/index.html',
    '-rw-r--r--  3.0 unx      512 tx defN 24-Jan-01 12:00 public/app.css',
    '3 files, 2560 bytes uncompressed, 900 bytes compressed:  64.8%',
    SEP,
    'public/',
    'public/index.html',
    'public/app.css',
  ].join('\n')

  const tarListing = [
    'drwxr-xr-x root/root         0 2024-01-15 12:34 ./',
    '-rw-r--r-- www-data/www-data 1000 2024-01-15 12:34 ./index.php',
    '-rw-r--r-- www-data/www-data 24 2024-01-15 12:34 ./docker-compose.yml',
    SEP,
    './',
    './index.php',
    './docker-compose.yml',
  ].join('\n')

  it('reads totals from a zipinfo listing', () => {
    expect(archiveContentTotals('zip', zipListing)).toEqual({ entries: 3, bytes: 2560 })
  })
  it('reads totals from a tar listing', () => {
    expect(archiveContentTotals('tar.gz', tarListing)).toEqual({ entries: 3, bytes: 1024 })
  })
  it('cannot read totals from something that is not a listing', () => {
    expect(archiveContentTotals('zip', 'unzip: cannot find zipfile')).toBeNull()
    expect(archiveContentTotals('zip', `garbage\n${SEP}\nx`)).toBeNull()
    expect(archiveContentTotals('zip', `Empty zipfile.\n${SEP}\n`)).toEqual({ entries: 0, bytes: 0 })
  })
  it('lists member names normalized', () => {
    expect(archiveMemberNames(tarListing)).toEqual(['index.php', 'docker-compose.yml'])
  })
  it('finds members that would be written through an existing link', () => {
    const members = ['uploads/a.png', 'link/passwd', 'deep/dir/file', 'linkish/file', 'other']
    expect(findSymlinkCollisions(members, ['link', 'deep/dir'])).toEqual(['link/passwd', 'deep/dir/file'])
    expect(findSymlinkCollisions(members, ['other'])).toEqual(['other'])
    expect(findSymlinkCollisions(members, [])).toEqual([])
  })
  it('finds members that would replace platform files at the root only', () => {
    expect(findManagedCollisions(['index.php', 'docker-compose.yml'], '')).toEqual(['docker-compose.yml'])
    expect(findManagedCollisions(['index.php', 'docker-compose.yml'], 'site')).toEqual([])
  })
  it('builds a bounded extraction that keeps no owners and clears setuid', () => {
    const tar = extractCommand('tar.gz', '/tmp/a.tgz', "/srv/s/site/new dir", { overwrite: false })
    expect(tar).toContain(`timeout ${ARCHIVE_TIME_LIMIT_SECONDS} tar -xzf /tmp/a.tgz -C '/srv/s/site/new dir' --no-same-owner --no-same-permissions --skip-old-files`)
    expect(tar).toContain("find -P '/srv/s/site/new dir' -xdev -type f -perm /6000 -exec chmod ug-s -- {} +")
    expect(tar).toContain('exit $__apsamo_rc')
    const zip = extractCommand('zip', '/tmp/a.zip', '/srv/s/site', { overwrite: true })
    expect(zip).toContain('unzip -o -q /tmp/a.zip -d /srv/s/site')
    expect(extractCommand('zip', '/tmp/a.zip', '/d', { overwrite: false })).toContain('unzip -n')
  })
  it('judges extractor exit codes', () => {
    expect(extractSucceeded('zip', 0)).toBe(true)
    expect(extractSucceeded('zip', 1)).toBe(true) // warnings only
    expect(extractSucceeded('tar', 1)).toBe(false)
    expect(extractSucceeded('zip', 124)).toBe(false)
  })
  it('lists destination links without following them', () => {
    expect(listDestSymlinksCommand('/srv/s/site')).toContain("find -P . -xdev -type l -printf '%P\\n'")
  })
})

describe('zipCommand', () => {
  it('stores links as links, ignores wildcards and refuses existing output', () => {
    const cmd = zipCommand('/srv/s/site', ['wp-content', '*.php', "it's"], '/srv/s/site/backup.zip')
    expect(cmd).toContain('cd /srv/s/site')
    expect(cmd).toContain(`exit ${EXIT_TARGET_EXISTS}`)
    expect(cmd).toContain(`exit ${EXIT_TOO_LARGE}`)
    expect(cmd).toContain(`zip -r -q -y -nw /srv/s/site/backup.zip.part ./wp-content './*.php' './it'\\''s'`)
    expect(cmd).toContain('mv -n -- /srv/s/site/backup.zip.part /srv/s/site/backup.zip')
  })
  it('never passes a name that could be read as an option or escape the folder', () => {
    expect(zipCommand('/d', ['-T'], '/d/o.zip')).toContain(' ./-T')
    expect(() => zipCommand('/d', ['../etc'], '/d/o.zip')).toThrow()
    expect(() => zipCommand('/d', [], '/d/o.zip')).toThrow()
  })
})

describe('copyMoveCommand', () => {
  it('copies links as links and refuses to overwrite', () => {
    const cmd = copyMoveCommand('copy', '/s/site/a', '/s/site/b/a')
    expect(cmd).toContain(`exit ${EXIT_TARGET_EXISTS}`)
    expect(cmd).toContain('cp -a -T -- /s/site/a /s/site/b/a')
    expect(cmd).toContain('chmod ug-s')
  })
  it('moves with no-clobber', () => {
    expect(copyMoveCommand('move', '/s/a', '/s/b/a')).toContain('mv -n -T -- /s/a /s/b/a')
  })
})

describe('preview', () => {
  it('maps only images and PDF', () => {
    expect(previewContentType('logo.PNG')).toBe('image/png')
    expect(previewContentType('a.svg')).toBe('image/svg+xml')
    expect(previewContentType('a.pdf')).toBe('application/pdf')
    expect(previewContentType('a.html')).toBeNull()
    expect(previewContentType('noext')).toBeNull()
  })
  it('sandboxes SVG and keeps PDF framable only by the panel', () => {
    const svg = previewHeaders('x".svg', 'image/svg+xml', 10)
    expect(svg['Content-Security-Policy']).toContain('sandbox')
    expect(svg['X-Content-Type-Options']).toBe('nosniff')
    expect(svg['Content-Disposition']).toBe('inline; filename="x_.svg"')
    const pdf = previewHeaders('a.pdf', 'application/pdf', 10)
    expect(pdf['Content-Security-Policy']).toContain("frame-ancestors 'self'")
    expect(pdf['Content-Security-Policy']).not.toContain('sandbox')
  })
})

describe('demo file tree', () => {
  const P = 'unit-demo-site'
  beforeEach(() => resetDemoFiles(P))

  it('looks like a WordPress deploy: platform files at the root, the site in site/', () => {
    const root = demoList(P, '').map((e) => e.name).sort()
    expect(root).toEqual(['.dockerignore', 'Dockerfile', 'docker-compose.yml', 'site'])
    expect(demoList(P, 'site').some((e) => e.name === 'wp-content')).toBe(true)
    const png = demoRead(P, 'site/wp-content/uploads/2026/11/garden-logo.png')!
    expect(png.subarray(1, 4).toString()).toBe('PNG')
  })
  it('compresses and extracts back to the same files', () => {
    demoWrite(P, 'site/notes/a.txt', 'hello')
    demoCompress(P, 'site', ['notes', 'index.php'], 'pack.zip')
    expect(demoList(P, 'site').some((e) => e.name === 'pack.zip')).toBe(true)
    demoRemove(P, 'site/notes')
    const n = demoExtract(P, 'site/pack.zip', 'site/restored', false)
    expect(n).toBe(2)
    expect(demoRead(P, 'site/restored/notes/a.txt')!.toString()).toBe('hello')
    expect(demoRead(P, 'site/restored/index.php')).not.toBeNull()
  })
  it('does not overwrite on extract unless asked', () => {
    demoWrite(P, 'site/a.txt', 'one')
    demoCompress(P, 'site', ['a.txt'], 'a.zip')
    demoWrite(P, 'site/a.txt', 'two')
    expect(demoExtract(P, 'site/a.zip', 'site', false)).toBe(0)
    expect(demoRead(P, 'site/a.txt')!.toString()).toBe('two')
    expect(demoExtract(P, 'site/a.zip', 'site', true)).toBe(1)
    expect(demoRead(P, 'site/a.txt')!.toString()).toBe('one')
  })
  it('refuses archives it did not make', () => {
    demoWrite(P, 'site/upload.zip', 'PK')
    expect(() => demoExtract(P, 'site/upload.zip', 'site', false)).toThrow(DemoFsError)
  })
  it('changes modes, recursively per type', () => {
    demoChmod(P, 'site/index.php', { mode: '600' })
    expect(demoList(P, 'site').find((e) => e.name === 'index.php')!.permissions).toBe('rw-------')
    demoChmod(P, 'site/wp-content', { recursive: true, dirMode: '750', fileMode: '640' })
    const style = demoList(P, 'site/wp-content/themes/twentytwentyfour')[0]
    expect(style.permissions).toBe('rw-r-----')
    expect(demoList(P, 'site/wp-content').find((e) => e.name === 'themes')!.permissions).toBe('rwxr-x---')
  })
  it('copies and moves without overwriting or nesting into itself', () => {
    demoCopy(P, 'site/index.php', 'site/wp-admin/index.php')
    expect(() => demoCopy(P, 'site/index.php', 'site/wp-admin/index.php')).toThrow(DemoFsError)
    expect(() => demoRename(P, 'site/wp-content', 'site/wp-content/x/wp-content')).toThrow(DemoFsError)
    demoRename(P, 'site/license.txt', 'site/wp-admin/license.txt')
    expect(demoList(P, 'site').some((e) => e.name === 'license.txt')).toBe(false)
  })
})

describe('permissions dialog helpers', () => {
  it('round-trips grid and octal', () => {
    for (const m of ['000', '644', '755', '777', '640', '711']) expect(octalFromGrid(gridFromOctal(m))).toBe(m)
    expect(gridFromOctal('640').group).toEqual({ read: true, write: false, execute: false })
  })
  it('validates like the server', () => {
    expect(validateOctalMode('0644')).toEqual({ ok: true, mode: '644' })
    expect(validateOctalMode('4755').ok).toBe(false)
    expect(validateOctalMode('1777').ok).toBe(false) // special bits are not offered in the dialog
    expect(validateOctalMode('99').ok).toBe(false)
  })
  it('describes a mode in words', () => {
    expect(describeOctal('750')).toBe('Owner: read, write and run · Group: read and run · Everyone else: no access')
  })
  it('knows what can be previewed and names archives', () => {
    expect(previewKind('a.JPG')).toBe('image')
    expect(previewKind('a.pdf')).toBe('pdf')
    expect(previewKind('a.php')).toBeNull()
    expect(defaultZipName(['site/wp-content'], 'site')).toBe('wp-content.zip')
    expect(defaultZipName(['site/a', 'site/b'], 'site')).toBe('site-files.zip')
    expect(defaultZipName(['a', 'b'], '')).toBe('website-files.zip')
  })
})
