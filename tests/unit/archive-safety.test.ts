/**
 * tests/unit/archive-safety.test.ts
 *
 * Uploaded archives are extracted as root into a customer's project. Links
 * inside them (and out-of-tree names) are refused before extraction
 * (lib/vps/archive-safety). The listings below are real `unzip -Z` and
 * `tar -tv` output shapes.
 */
import { describe, it, expect } from 'bun:test'
import {
  ARCHIVE_LIST_SEPARATOR as SEP,
  archiveListingCommand,
  findUnsafeArchiveEntries,
  isUnsafeArchivePath,
  unsafeArchiveMessage,
} from '../../src/lib/vps/archive-safety'

const zipinfo = (rows: string[]) =>
  [
    'Archive:  /opt/deployhub/projects/shop.upload.zip',
    'Zip file size: 1234 bytes, number of entries: 3',
    ...rows,
    '3 files, 4567 bytes uncompressed, 1234 bytes compressed:  73.0%',
  ].join('\n')

describe('findUnsafeArchiveEntries', () => {
  it('accepts an ordinary zip', () => {
    const out =
      zipinfo([
        'drwxr-xr-x  3.0 unx        0 bx stor 24-Jan-01 12:00 public/',
        '-rw-r--r--  3.0 unx      120 tx defN 24-Jan-01 12:00 public/index.html',
        '-rw-a--     2.0 fat      300 tx defN 24-Jan-01 12:00 README.txt',
      ]) + `\n${SEP}\npublic/\npublic/index.html\nREADME.txt\n`
    expect(findUnsafeArchiveEntries(out)).toEqual([])
  })

  it('refuses a zip carrying a symbolic link', () => {
    const out =
      zipinfo([
        'lrwxrwxrwx  3.0 unx        5 bx stor 24-Jan-01 12:00 escape',
        '-rw-r--r--  3.0 unx      120 tx defN 24-Jan-01 12:00 index.html',
      ]) + `\n${SEP}\nescape\nindex.html\n`
    const problems = findUnsafeArchiveEntries(out)!
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('escape')
  })

  it('refuses tar symbolic and hard links', () => {
    const out = [
      'drwxr-xr-x root/root         0 2024-01-01 12:00 site/',
      'lrwxrwxrwx root/root         0 2024-01-01 12:00 site/root -> /root',
      'hrw-r--r-- root/root         0 2024-01-01 12:00 site/shadow link to etc/shadow',
      SEP,
      'site/',
      'site/root',
      'site/shadow',
    ].join('\n')
    expect(findUnsafeArchiveEntries(out)!.length).toBe(2)
  })

  it('refuses names that leave the target (zip-slip)', () => {
    const out = `${SEP}\nok.txt\n../../etc/cron.d/x\n/etc/passwd\nC:\\win\\x\na/..\\..\\b\nfine..name.txt\n`
    const problems = findUnsafeArchiveEntries(out)!
    expect(problems.length).toBe(4)
    expect(problems.join('\n')).not.toContain('fine..name.txt')
  })

  it('returns null (refuse) when the output is not a listing', () => {
    expect(findUnsafeArchiveEntries('End-of-central-directory signature not found.')).toBeNull()
    expect(unsafeArchiveMessage(null)).toContain('could not be read')
  })
})

describe('isUnsafeArchivePath', () => {
  it('flags only escaping names', () => {
    expect(isUnsafeArchivePath('a/b/c.txt')).toBe(false)
    expect(isUnsafeArchivePath('..')).toBe(true)
    expect(isUnsafeArchivePath('a/../../b')).toBe(true)
    expect(isUnsafeArchivePath('/abs')).toBe(true)
  })
})

describe('archiveListingCommand', () => {
  it('lists types then names, and quotes the path', () => {
    expect(archiveListingCommand('zip', "/tmp/a b'.zip")).toBe(
      `LC_ALL=C unzip -Z '/tmp/a b'\\''.zip' && echo ${SEP} && LC_ALL=C unzip -Z1 '/tmp/a b'\\''.zip'`
    )
    expect(archiveListingCommand('tar.gz', '/tmp/x.tgz')).toBe(
      `LC_ALL=C tar -tvzf /tmp/x.tgz && echo ${SEP} && LC_ALL=C tar -tzf /tmp/x.tgz`
    )
    expect(archiveListingCommand('tar', '/tmp/x.tar')).toContain('tar -tvf /tmp/x.tar')
  })
})
