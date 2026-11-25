/** When a ZIP upload's single top-level folder is flattened into the web root. */
import { describe, it, expect } from 'bun:test'
import { zipEntryNames, zipFolderToFlatten, ZIP_FLATTEN_METHODS } from '@/lib/vps/zip-layout'
import { ARCHIVE_LIST_SEPARATOR } from '@/lib/vps/archive-safety'

describe('zipFolderToFlatten', () => {
  it('flattens a site zipped as its folder', () => {
    expect(zipFolderToFlatten(['my-site/', 'my-site/index.html', 'my-site/css/app.css'])).toBe('my-site')
    // Zips without explicit directory entries.
    expect(zipFolderToFlatten(['public_html/index.php', 'public_html/inc/db.php'])).toBe('public_html')
  })

  it('ignores macOS / Windows archive junk when deciding', () => {
    expect(
      zipFolderToFlatten(['site/', 'site/index.html', '__MACOSX/', '__MACOSX/site/._index.html', '.DS_Store', 'site/.DS_Store'])
    ).toBe('site')
    expect(zipFolderToFlatten(['site/index.html', 'Thumbs.db'])).toBe('site')
  })

  it('keeps archives that already have files at the root', () => {
    expect(zipFolderToFlatten(['index.html', 'css/app.css'])).toBeNull()
    expect(zipFolderToFlatten(['index.php', 'site/'])).toBeNull()
    expect(zipFolderToFlatten(['README.txt', 'site/index.html'])).toBeNull()
  })

  it('keeps archives with several top-level folders, or nothing in the folder', () => {
    expect(zipFolderToFlatten(['css/a.css', 'js/a.js'])).toBeNull()
    expect(zipFolderToFlatten(['empty/'])).toBeNull()
    expect(zipFolderToFlatten([])).toBeNull()
    expect(zipFolderToFlatten(['__MACOSX/x'])).toBeNull()
  })

  it('handles backslash and ./ prefixed names', () => {
    expect(zipFolderToFlatten(['site\\index.html', 'site\\a\\b.css'])).toBe('site')
    expect(zipFolderToFlatten(['./site/index.html'])).toBe('site')
  })

  it('only applies to static and PHP sites', () => {
    expect([...ZIP_FLATTEN_METHODS]).toEqual(['static', 'php'])
  })
})

describe('zipEntryNames', () => {
  it('reads the bare names after the separator of archiveListingCommand output', () => {
    const out = `Archive:  x.zip\n-rw-r--r--  3.0 unx  12 tx stor 24-Jan-01 00:00 site/index.html\n${ARCHIVE_LIST_SEPARATOR}\nsite/\nsite/index.html\r\n\n`
    expect(zipEntryNames(out)).toEqual(['site/', 'site/index.html'])
    expect(zipFolderToFlatten(zipEntryNames(out))).toBe('site')
  })
})
