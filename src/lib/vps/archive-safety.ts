/**
 * Archive safety rules
 * ====================
 *
 * Pure helpers (no shell, no network) for archives a customer uploads and the
 * panel extracts as root on a host shared with other tenants.
 *
 * `unzip` and GNU `tar` already refuse absolute and `../` member names, but
 * both happily restore SYMBOLIC LINKS (and tar restores hard links). A link
 * left in a project directory is a path out of it: `link -> /root`, extracted
 * by one upload, turns the next upload's `link/.ssh/authorized_keys` into a
 * write through to the host — and every later root-run tool that follows
 * links (cp, chown, the deployer, backups) does the same.
 *
 * The rule here is simple: before extracting into a directory that already
 * holds the customer's files, list the archive and refuse it if any entry is
 * a link or names a path outside the target. Unit-tested in
 * tests/unit/archive-safety.test.ts.
 */
import { shellQuoteArg } from './deploy-safety'

export type ListableArchive = 'zip' | 'tar' | 'tar.gz'

/** Separates the verbose listing (types) from the plain listing (names). */
export const ARCHIVE_LIST_SEPARATOR = '__APSAMO_ARCHIVE_NAMES__'

/**
 * Shell command printing two listings of the archive: first one line per
 * entry with its mode string (`lrwxrwxrwx …` for a link), then the separator,
 * then one entry name per line. Exits non-zero when the archive is unreadable.
 */
export function archiveListingCommand(kind: ListableArchive, archive: string): string {
  const a = shellQuoteArg(archive)
  if (kind === 'zip') {
    // `unzip -Z` is zipinfo mode: short format shows the Unix mode per entry,
    // `-Z1` prints bare names.
    return `LC_ALL=C unzip -Z ${a} && echo ${ARCHIVE_LIST_SEPARATOR} && LC_ALL=C unzip -Z1 ${a}`
  }
  const z = kind === 'tar.gz' ? 'z' : ''
  return `LC_ALL=C tar -tv${z}f ${a} && echo ${ARCHIVE_LIST_SEPARATOR} && LC_ALL=C tar -t${z}f ${a}`
}

/** A symbolic (`l`) or hard (`h`, tar only) link in a zipinfo / `tar -tv` line. */
const LINK_LINE = /^[lh][-rwxsStTl]{9}/

/** Does this member name leave the extraction directory? */
export function isUnsafeArchivePath(name: string): boolean {
  if (!name) return false
  if (name.startsWith('/') || name.startsWith('\\')) return true
  if (/^[A-Za-z]:/.test(name)) return true
  return name.split(/[\\/]+/).some((seg) => seg === '..')
}

/**
 * Problems found in the output of `archiveListingCommand`. Empty when the
 * archive is safe to extract. Returns null when the output is not a listing
 * at all (treat as "cannot verify" and refuse).
 */
export function findUnsafeArchiveEntries(output: string): string[] | null {
  const at = output.indexOf(ARCHIVE_LIST_SEPARATOR)
  if (at < 0) return null
  const verbose = output.slice(0, at).split(/\r?\n/)
  const names = output.slice(at + ARCHIVE_LIST_SEPARATOR.length).split(/\r?\n/)

  const problems: string[] = []
  for (const line of verbose) {
    if (LINK_LINE.test(line)) {
      problems.push(`link entry: ${line.trim().slice(0, 200)}`)
    }
  }
  for (const raw of names) {
    const name = raw.trim()
    if (name && isUnsafeArchivePath(name)) {
      problems.push(`path outside the target: ${name.slice(0, 200)}`)
    }
  }
  return problems
}

/** The customer-facing refusal for a listing with problems (or none at all). */
export function unsafeArchiveMessage(problems: string[] | null): string {
  if (problems === null) return 'The archive could not be read, so it was not extracted.'
  const shown = problems.slice(0, 3).join('; ')
  const more = problems.length > 3 ? ` (and ${problems.length - 3} more)` : ''
  return (
    'The archive was refused: it contains symbolic/hard links or paths outside the ' +
    `target folder, which are not allowed. ${shown}${more}`
  )
}
