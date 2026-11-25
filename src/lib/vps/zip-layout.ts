/**
 * ZIP upload layout: should the archive's single top-level folder be flattened?
 *
 * Customers very often zip the site FOLDER rather than its contents, so the
 * archive holds `my-site/index.html` and the web root ends up with only a
 * `my-site/` directory: the site shows a 403 / directory listing instead of
 * publishing. When a static or PHP archive has exactly one top-level folder
 * and nothing else at its root (so certainly no index file there), the
 * deployer extracts that folder's contents into the web root instead.
 *
 * The decision is taken from the archive listing, not from the project
 * directory, because on a redeploy that directory already holds the previous
 * release and the panel's own Dockerfile / compose file.
 */
import { ARCHIVE_LIST_SEPARATOR } from './archive-safety'

/** Methods whose web root is the archive root. */
export const ZIP_FLATTEN_METHODS = ['static', 'php'] as const

/** Entries archivers add that are not part of the site. */
function isJunk(name: string): boolean {
  const first = name.split('/')[0]
  if (first === '__MACOSX') return true
  const base = name.replace(/\/+$/, '').split('/').pop() || ''
  return base === '.DS_Store' || base === 'Thumbs.db' || base === 'desktop.ini'
}

/** Bare member names from `archiveListingCommand('zip', …)` output. */
export function zipEntryNames(listingOutput: string): string[] {
  const at = listingOutput.indexOf(ARCHIVE_LIST_SEPARATOR)
  const tail = at < 0 ? listingOutput : listingOutput.slice(at + ARCHIVE_LIST_SEPARATOR.length)
  return tail
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
}

/**
 * The folder whose contents should become the web root, or null to extract
 * the archive as it is.
 */
export function zipFolderToFlatten(names: string[]): string | null {
  const entries = names
    .map((n) => n.replace(/\\/g, '/').replace(/^\.\/+/, ''))
    .filter((n) => n && !isJunk(n))
  if (entries.length === 0) return null

  const tops = new Set<string>()
  let hasNested = false
  for (const e of entries) {
    const slash = e.indexOf('/')
    if (slash < 0) {
      // A file at the archive root (index.* or anything else): the archive
      // is not "one wrapped folder", so it is extracted as it is.
      return null
    }
    tops.add(e.slice(0, slash))
    if (e.length > slash + 1) hasNested = true
  }
  if (tops.size !== 1 || !hasNested) return null
  const [folder] = [...tops]
  if (!folder || folder === '.' || folder === '..') return null
  return folder
}
