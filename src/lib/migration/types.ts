/**
 * Website Import & Migration — shared types and stage plan.
 * ========================================================
 *
 * A migration takes a customer's existing website — as a backup archive, a Git
 * repo, or a Docker project — and turns it into a running, SSL-terminated site
 * on this platform. It is deliberately modelled as a durable, resumable
 * pipeline rather than a single function call, because:
 *
 *   - it operates on real customer data (a half-import is worse than no import)
 *   - it takes minutes, not seconds, so the UI must stream progress
 *   - individual steps fail for boring, recoverable reasons (a 2 GB upload
 *     stalls, MySQL is still booting, DNS hasn't propagated) and the customer
 *     should be able to hit Retry rather than start over
 *
 * Every stage that mutates the server records an `undo` descriptor. On failure
 * the runner replays those descriptors in reverse, so a failed import leaves
 * the account exactly as it was found.
 */

// ─── Source formats ───────────────────────────────────────────────────────

/**
 * The backup/source formats we can ingest. These strings are persisted in
 * `SiteMigration.sourceType`, so they are part of the API contract — rename
 * with a data migration, not in place.
 */
export type MigrationSourceType =
  | 'wordpress-zip' // plain .zip / .tar.gz of a WordPress directory
  | 'wpress' // All-in-One WP Migration .wpress
  | 'duplicator' // Duplicator archive + installer.php
  | 'updraftplus' // UpdraftPlus backup set (db.gz + component zips)
  | 'cpanel' // cPanel full/partial backup tarball
  | 'files-sql' // generic files archive + a .sql dump
  | 'git' // git clone
  | 'docker' // repo containing Dockerfile / docker-compose.yml

/** Where the payload comes from. Persisted in `SiteMigration.sourceMode`. */
export type MigrationSourceMode = 'upload' | 'url' | 'git'

/** Persisted in `SiteMigration.status`. */
export type MigrationStatus =
  | 'pending'
  | 'detecting'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'rolled_back'
  | 'cancelled'

/** Persisted in `MigrationStage.status`. */
export type StageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'rolled_back'

// ─── Stage plan ───────────────────────────────────────────────────────────

export type MigrationStageName =
  | 'prepare'
  | 'fetch'
  | 'extract'
  | 'detect'
  | 'snapshot'
  | 'create_db'
  | 'import_files'
  | 'import_sql'
  | 'configure'
  | 'rewrite_urls'
  | 'permissions'
  | 'deploy'
  | 'proxy_ssl'
  | 'clear_cache'
  | 'verify'
  | 'finalize'

export interface StageDefinition {
  name: MigrationStageName
  label: string
  /** Rough share of total progress, used to drive the percentage bar. */
  weight: number
}

/**
 * The canonical stage order. Stages that do not apply to a given source are
 * marked `skipped` rather than removed, so the progress UI keeps a stable
 * shape across every import type and the customer can see what was and wasn't
 * necessary.
 */
export const MIGRATION_STAGES: StageDefinition[] = [
  { name: 'prepare', label: 'Preparing workspace', weight: 3 },
  { name: 'fetch', label: 'Transferring backup to server', weight: 12 },
  { name: 'extract', label: 'Extracting archive', weight: 10 },
  { name: 'detect', label: 'Detecting website type', weight: 5 },
  { name: 'snapshot', label: 'Snapshotting current site', weight: 5 },
  { name: 'create_db', label: 'Creating database', weight: 5 },
  { name: 'import_files', label: 'Importing website files', weight: 12 },
  { name: 'import_sql', label: 'Importing database', weight: 15 },
  { name: 'configure', label: 'Writing configuration', weight: 5 },
  { name: 'rewrite_urls', label: 'Updating site URLs', weight: 6 },
  { name: 'permissions', label: 'Fixing file permissions', weight: 3 },
  { name: 'deploy', label: 'Starting website container', weight: 8 },
  { name: 'proxy_ssl', label: 'Configuring domain and SSL', weight: 4 },
  { name: 'clear_cache', label: 'Clearing caches', weight: 3 },
  { name: 'verify', label: 'Verifying website', weight: 3 },
  { name: 'finalize', label: 'Going live', weight: 1 },
]

export const TOTAL_STAGE_WEIGHT = MIGRATION_STAGES.reduce(
  (sum, s) => sum + s.weight,
  0
)

// ─── Detection ────────────────────────────────────────────────────────────

/** What the platform stack looks like once we've inspected the payload. */
export type DetectedStack =
  | 'wordpress'
  | 'laravel'
  | 'php'
  | 'nodejs'
  | 'python'
  | 'static'
  | 'docker'
  | 'unknown'

/**
 * The result of inspecting an extracted payload. Persisted as JSON in
 * `SiteMigration.detection` and shown to the customer before the import
 * commits, so it doubles as the "here's what we found" review screen.
 */
export interface DetectionResult {
  stack: DetectedStack
  /**
   * Directory inside the extracted workspace that is the website root — the
   * folder containing wp-config.php / index.php / package.json. Relative to
   * the extraction dir, '' when the root itself is it.
   */
  rootDir: string
  /** Document root relative to `rootDir` (e.g. 'public' for Laravel). */
  documentRoot: string | null
  /** SQL dump paths relative to the extraction dir, largest first. */
  sqlFiles: string[]
  /** Total uncompressed payload size in bytes, when known. */
  sizeBytes: number | null
  fileCount: number | null

  // ── WordPress specifics ───────────────────────────────────────────
  wordpress?: {
    version: string | null
    /** Table prefix read from wp-config.php or inferred from the dump. */
    tablePrefix: string
    /** siteurl / home found in the SQL dump, when present. */
    siteUrl: string | null
    homeUrl: string | null
    /** True when wp-content lives somewhere non-standard. */
    hasWpContent: boolean
    pluginCount: number | null
    themeCount: number | null
    /** Multisite installs need a different URL rewrite; we refuse them for now. */
    isMultisite: boolean
    /** Caching plugins that must be disabled before the first boot. */
    cachePlugins: string[]
  }

  // ── Generic app specifics ─────────────────────────────────────────
  runtime?: string | null
  runtimeVersion?: string | null
  /** package.json / composer.json / requirements.txt presence. */
  hasDockerfile?: boolean
  hasCompose?: boolean
  /** Free-form warnings shown to the customer on the review screen. */
  warnings: string[]
}

// ─── Undo descriptors ─────────────────────────────────────────────────────

/**
 * A compensating action recorded by a stage that mutated the server. Stored as
 * JSON in `MigrationStage.undo`. Rollback replays completed stages in reverse
 * and dispatches on `type`.
 *
 * Undo actions must be idempotent — rollback can run twice (an operator
 * retries a failed rollback), and each action must tolerate the resource
 * already being gone.
 */
export type UndoAction =
  /** Delete a directory tree we created. */
  | { type: 'rmdir'; path: string }
  /** Drop a database we provisioned (and its WebsiteDatabase row). */
  | { type: 'drop_database'; databaseId: string }
  /** Restore a directory from a tarball taken before we touched it. */
  | { type: 'restore_path'; path: string; tarball: string }
  /** Stop + remove a container we started. */
  | { type: 'remove_container'; name: string; composePath?: string }
  /** Remove the Caddy site block we added. */
  | { type: 'remove_proxy'; projectId: string }
  /** Restore Project columns to their pre-migration values. */
  | { type: 'restore_project'; fields: Record<string, unknown> }
  /** Truncate + drop every table we imported into an existing database. */
  | { type: 'wipe_database'; databaseName: string; container: string }

// ─── Runner options ───────────────────────────────────────────────────────

export interface StartMigrationOptions {
  projectId: string
  userId: string
  sourceType: MigrationSourceType
  sourceMode: MigrationSourceMode
  /** Upload id, remote URL, or git remote — depending on `sourceMode`. */
  sourceRef: string
  sizeBytes?: number
  /** Git-specific. */
  gitBranch?: string
  gitToken?: string
  /**
   * The URL the imported site currently believes it lives at. Usually detected
   * from the backup; supplying it explicitly skips the guesswork.
   */
  originalUrl?: string
  /** Override the target URL (defaults to the project's primary hostname). */
  targetUrl?: string
  /** Skip the URL search-replace entirely (same-domain migrations). */
  skipUrlRewrite?: boolean
  /** Keep the existing site's database instead of provisioning a fresh one. */
  reuseDatabase?: boolean
  /** Disable known-incompatible caching plugins after import. Default true. */
  disableCachePlugins?: boolean
  /** A second upload id holding the SQL dump, for the files+SQL flow. */
  sqlUploadId?: string
}

export interface MigrationRunOptions {
  migrationId: string
  /** Resume a failed run from the first non-completed stage. */
  resume?: boolean
  /**
   * Git credential for this run only. Never persisted with the migration, so
   * a retry of a private-repo import has to supply it again.
   */
  gitToken?: string
  onLog?: (line: string) => void
}

export interface MigrationRunResult {
  ok: boolean
  migrationId: string
  projectId: string
  status: MigrationStatus
  url?: string
  error?: string
  rolledBack: boolean
  durationMs: number
}
