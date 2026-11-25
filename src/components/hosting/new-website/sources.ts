/**
 * Import sources as the customer sees them.
 *
 * The server's catalogue (src/lib/migration/sources.ts, returned by
 * GET /api/migrations) stays authoritative for what is accepted. This file
 * only adds the plain-language framing: which sources are common, how each
 * one is described to someone who has never heard of "UpdraftPlus", and the
 * file-type hints used to pick the right source from a dropped file.
 */

export type SourceMode = 'upload' | 'url' | 'git'

export interface SourceDefinition {
  id: string
  name: string
  tagline: string
  description: string
  icon: string
  accept: string[]
  modes: SourceMode[]
  needsSeparateSql?: boolean
  hint: string
  wordpress: boolean
}

/** Mirrors IMPORT_SOURCES so the step renders before the server answers. */
export const FALLBACK_SOURCES: SourceDefinition[] = [
  {
    id: 'wordpress-zip',
    name: 'WordPress backup',
    tagline: 'A ZIP or tarball of your WordPress folder',
    description:
      'Your whole WordPress folder and a .sql export of the database — inside the archive or uploaded separately.',
    icon: 'Globe',
    accept: ['.zip', '.tar.gz', '.tgz', '.tar'],
    modes: ['upload', 'url'],
    hint: 'Export your database from phpMyAdmin as a .sql file.',
    wordpress: true,
  },
  {
    id: 'wpress',
    name: 'All-in-One WP Migration',
    tagline: '.wpress export file',
    description: 'The export made by the All-in-One WP Migration plugin. It already holds your files and database.',
    icon: 'Package',
    accept: ['.wpress'],
    modes: ['upload', 'url'],
    hint: 'All-in-One WP Migration → Export → Export to File.',
    wordpress: true,
  },
  {
    id: 'duplicator',
    name: 'Duplicator package',
    tagline: 'Duplicator archive',
    description: 'Duplicator’s archive holds your site and its database. Upload the archive only.',
    icon: 'Copy',
    accept: ['.zip', '.daf'],
    modes: ['upload', 'url'],
    hint: 'Upload the large archive file. You do not need installer.php.',
    wordpress: true,
  },
  {
    id: 'updraftplus',
    name: 'UpdraftPlus backup',
    tagline: 'UpdraftPlus backup set',
    description: 'Put all the UpdraftPlus backup files into one ZIP — they are reassembled automatically.',
    icon: 'CloudDownload',
    accept: ['.zip', '.tar.gz', '.gz'],
    modes: ['upload', 'url'],
    hint: 'Encrypted (.crypt) database backups must be decrypted in UpdraftPlus first.',
    wordpress: true,
  },
  {
    id: 'cpanel',
    name: 'cPanel backup',
    tagline: 'Full or partial cPanel backup',
    description: 'A cPanel backup tarball. The site comes from public_html and the database from the mysql folder.',
    icon: 'Server',
    accept: ['.tar.gz', '.tar', '.tgz', '.zip'],
    modes: ['upload', 'url'],
    hint: 'cPanel → Backup → Download a Full Account Backup.',
    wordpress: false,
  },
  {
    id: 'files-sql',
    name: 'Files + database',
    tagline: 'Any site archive with a separate .sql file',
    description: 'For sites that are not WordPress, or backups made by hand.',
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
    description: 'Deploy straight from a repository. A private repository needs an access token, used once and never stored.',
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
    description: 'A project that builds itself from its Dockerfile or docker-compose.yml.',
    icon: 'Container',
    accept: ['.zip', '.tar.gz', '.tar'],
    modes: ['git', 'upload'],
    hint: 'A docker-compose.yml takes precedence over a plain Dockerfile.',
    wordpress: false,
  },
]

/** How each source is offered on the "What do you have?" question. */
export const SOURCE_COPY: Record<string, { title: string; description: string; common: boolean }> = {
  'wordpress-zip': {
    title: 'A backup of my WordPress site',
    description:
      'A .zip or .tar.gz of your site folder, from Hostinger, GoDaddy, Bluehost or any host. The database file can be inside it or separate.',
    common: true,
  },
  wpress: {
    title: 'An All-in-One WP Migration export',
    description: 'A single .wpress file. It already holds your files and database.',
    common: true,
  },
  cpanel: {
    title: 'A cPanel full backup',
    description: 'The backup-….tar.gz file from cPanel → Backup.',
    common: true,
  },
  'files-sql': {
    title: 'Website files and a separate database file',
    description: 'For sites that are not WordPress: an archive of the files plus a .sql export.',
    common: true,
  },
  duplicator: {
    title: 'A Duplicator package',
    description: 'The large archive file made by the Duplicator plugin (.zip or .daf).',
    common: false,
  },
  updraftplus: {
    title: 'An UpdraftPlus backup',
    description: 'All UpdraftPlus backup files together in one ZIP.',
    common: false,
  },
  git: {
    title: 'A Git repository',
    description: 'Clone from GitHub, GitLab or Bitbucket.',
    common: false,
  },
  docker: {
    title: 'A Docker project',
    description: 'A repository or archive with a Dockerfile or docker-compose.yml.',
    common: false,
  },
}

export const SQL_ACCEPT = ['.sql', '.sql.gz', '.sql.bz2']

/**
 * Upload size ceiling shown to the customer. Matches the server default
 * (MIGRATION_MAX_UPLOAD_BYTES, 10 GB); the server enforces its own value and
 * its message is shown if it is lower.
 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024 * 1024

/**
 * A ZIP for "Upload a website" is read into memory by the deployer before it
 * is sent to the server, so it keeps the limit the old wizard advertised.
 */
export const MAX_SITE_ZIP_BYTES = 500 * 1024 * 1024

/**
 * A dropped file that clearly belongs to another source switches to it, so
 * the customer is not told "wrong type" for picking the obvious file.
 */
export function sourceForFile(filename: string): string | null {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.wpress')) return 'wpress'
  if (lower.endsWith('.daf')) return 'duplicator'
  if (/^backup-.*\.tar\.gz$/.test(lower)) return 'cpanel'
  return null
}
