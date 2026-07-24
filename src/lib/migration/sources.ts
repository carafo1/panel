/**
 * The import source catalogue.
 *
 * Its own module so the wizard, the API validators, and the tests can all
 * read it without pulling in the runner (and through it Prisma, ssh2, and the
 * deployer). It is the single source of truth for what the UI offers and what
 * the server will accept — those two drifting apart is how a customer ends up
 * picking a file the wizard advertised and being told it is unsupported.
 */
// ─── Source catalogue ─────────────────────────────────────────────────────

import type { MigrationSourceType } from './types'

/**
 * The import sources offered in the wizard, in the order they are shown.
 *
 * This drives both the UI cards and the server-side validation of what a given
 * source is allowed to supply, so the two cannot drift apart.
 */
export interface SourceDefinition {
  id: MigrationSourceType
  name: string
  /** One line, shown under the name on the picker card. */
  tagline: string
  /** Longer explanation shown once the card is selected. */
  description: string
  /** Lucide icon name, resolved by the client component. */
  icon: string
  /** Accepted file extensions for the upload input. */
  accept: string[]
  /** How the payload arrives. */
  modes: Array<'upload' | 'url' | 'git'>
  /** Needs a second upload holding the SQL dump. */
  needsSeparateSql?: boolean
  /** Practical guidance shown as a hint on the upload step. */
  hint: string
  /** True when the import produces a WordPress site. */
  wordpress: boolean
}

export const IMPORT_SOURCES: SourceDefinition[] = [
  {
    id: 'wordpress-zip',
    name: 'WordPress backup',
    tagline: 'A ZIP or tarball of your WordPress folder',
    description:
      'The most common way to move a WordPress site. Include your whole WordPress directory (wp-content, wp-admin, wp-includes) and a .sql export of the database — either inside the archive or uploaded separately.',
    icon: 'Globe',
    accept: ['.zip', '.tar.gz', '.tgz', '.tar'],
    modes: ['upload', 'url'],
    hint: 'Export your database from phpMyAdmin as a .sql file and place it inside the archive before zipping.',
    wordpress: true,
  },
  {
    id: 'wpress',
    name: 'All-in-One WP Migration',
    tagline: '.wpress export file',
    description:
      'The export produced by the All-in-One WP Migration plugin. It already contains both your files and your database, so nothing else is needed.',
    icon: 'Package',
    accept: ['.wpress'],
    modes: ['upload', 'url'],
    hint: 'In WordPress go to All-in-One WP Migration → Export → Export to File, then upload the .wpress file here.',
    wordpress: true,
  },
  {
    id: 'duplicator',
    name: 'Duplicator package',
    tagline: 'Duplicator archive',
    description:
      "Duplicator's archive contains your site and its database. Upload the archive only — the installer.php is not needed here and is removed automatically for security.",
    icon: 'Copy',
    accept: ['.zip', '.daf'],
    modes: ['upload', 'url'],
    hint: 'Upload the archive file (the large one). You do not need installer.php.',
    wordpress: true,
  },
  {
    id: 'updraftplus',
    name: 'UpdraftPlus backup',
    tagline: 'UpdraftPlus backup set',
    description:
      'UpdraftPlus splits a backup into separate files for the database, plugins, themes and uploads. Put all of them into one ZIP and upload it — they are reassembled automatically.',
    icon: 'CloudDownload',
    accept: ['.zip', '.tar.gz', '.gz'],
    modes: ['upload', 'url'],
    hint: 'Encrypted database backups (.crypt) cannot be imported — decrypt them in UpdraftPlus first.',
    wordpress: true,
  },
  {
    id: 'cpanel',
    name: 'cPanel backup',
    tagline: 'Full or partial cPanel backup',
    description:
      'A cPanel backup tarball. The site is taken from homedir/public_html and the database from the mysql folder, exactly as cPanel lays them out.',
    icon: 'Server',
    accept: ['.tar.gz', '.tar', '.tgz', '.zip'],
    modes: ['upload', 'url'],
    hint: 'In cPanel use Backup → Download a Full Account Backup, then upload the resulting tar.gz.',
    wordpress: false,
  },
  {
    id: 'files-sql',
    name: 'Files + database',
    tagline: 'Any site archive with a separate .sql file',
    description:
      'For sites that are not WordPress, or backups made by hand. Upload your files as an archive and your database export as a separate .sql file.',
    icon: 'FileArchive',
    accept: ['.zip', '.tar.gz', '.tar', '.tgz'],
    modes: ['upload'],
    needsSeparateSql: true,
    hint: 'The .sql file can be plain or gzipped (.sql.gz).',
    wordpress: false,
  },
  {
    id: 'git',
    name: 'Git repository',
    tagline: 'Clone from GitHub, GitLab or Bitbucket',
    description:
      'Deploy straight from a repository. Public repositories need no credentials; for a private one supply a personal access token, which is used for this import only and never stored.',
    icon: 'GitBranch',
    accept: [],
    modes: ['git'],
    hint: 'Use the HTTPS clone URL, e.g. https://github.com/user/repo.git',
    wordpress: false,
  },
  {
    id: 'docker',
    name: 'Docker project',
    tagline: 'Repository or archive with a Dockerfile',
    description:
      'A project that builds itself. If a Dockerfile or docker-compose.yml is present it is used directly, so the site runs exactly as it does on your machine.',
    icon: 'Container',
    accept: ['.zip', '.tar.gz', '.tar'],
    modes: ['git', 'upload'],
    hint: 'A docker-compose.yml takes precedence over a plain Dockerfile.',
    wordpress: false,
  },
]

export function getSourceDefinition(
  id: string
): SourceDefinition | undefined {
  return IMPORT_SOURCES.find((s) => s.id === id)
}
