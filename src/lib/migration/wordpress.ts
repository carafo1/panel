/**
 * WordPress-specific import operations.
 * ====================================
 *
 * Everything here exists because a WordPress site is not just files plus a SQL
 * dump — moving it to a new domain requires rewriting data that is *inside*
 * PHP-serialised strings, regenerating config that embeds the old absolute
 * paths, and disabling the caching layers that hard-code both.
 *
 * The single most important routine is `rewriteSiteUrls`. WordPress stores
 * widget settings, theme mods, and page-builder layouts as serialised PHP,
 * where every string carries its own byte length (`s:23:"https://old.example"`).
 * A plain `UPDATE … REPLACE(…)` changes the text but not the length prefix,
 * which makes `unserialize()` fail and silently blanks the customer's widgets,
 * menus, and Elementor content. So the rewrite goes through WP-CLI's
 * serialisation-aware search-replace, and the SQL fallback is deliberately
 * conservative about which columns it touches.
 */
import crypto from 'crypto'
import {
  exec,
  shellQuote,
  remoteExists,
  remoteIsDir,
  listDirs,
  writeRemoteText,
  type AnyClient,
} from './remote'
import { CACHE_DROPINS } from './detect'

/**
 * The client binary inside a database container. MariaDB 11 images ship only
 * `mariadb` (no `mysql` alias), MySQL images only `mysql`; resolved by the
 * container's own shell so one command works for both.
 */
export const IN_CONTAINER_SQL_CLIENT = '"$(command -v mariadb || command -v mysql)"'

// ─── Types ────────────────────────────────────────────────────────────────

export interface WpDatabaseConfig {
  host: string
  port?: number
  name: string
  user: string
  password: string
  tablePrefix: string
  /** Docker container running the database, for `docker exec` access. */
  container?: string | null
}

export interface WpImportContext {
  /** Absolute path of the site root on the server (the bind-mount source). */
  sitePath: string
  db: WpDatabaseConfig
  onLog?: (line: string) => void
}

/**
 * A MySQL identifier backtick, as a SQL string literal (`'` + backtick + `'`).
 * Spelled via a char code because a bare backtick cannot appear inside the
 * template literals the surrounding SQL is built from.
 */
const BT = String.fromCharCode(96)
const BACKTICK_LITERAL = `'${BT}'`

/** Wrap an identifier in MySQL backticks. */
function ident(name: string): string {
  return BT + name.replace(/[^A-Za-z0-9_]/g, '') + BT
}

// ─── SQL import ───────────────────────────────────────────────────────────

/**
 * Statements that must not survive from the customer's dump.
 *
 *  - `CREATE DATABASE` / `USE`: the dump names the *old* database. Left in, the
 *    import either fails on permissions or, worse, succeeds against a database
 *    the site is not configured to read.
 *  - `DEFINER=`: views and triggers reference a MySQL account that does not
 *    exist here, and the import aborts with "definer does not exist" — the
 *    single most common mysqldump restore failure.
 *  - `SQL SECURITY DEFINER`: same problem, different spelling.
 */
const SQL_SANITIZER = [
  `s/^\\s*CREATE DATABASE[^;]*;//Ig`,
  `s/^\\s*USE \`[^\`]*\`;//Ig`,
  `s/DEFINER=[^ ]*//Ig`,
  `s/SQL SECURITY DEFINER//Ig`,
].join('; ')

/**
 * Build the shell pipeline that feeds a dump into MySQL.
 *
 * The dump is streamed through `sed` rather than rewritten to a second file:
 * a 4 GB dump would otherwise need 4 GB of extra disk at the exact moment the
 * server is already holding the archive, the extracted tree, and the target
 * site.
 */
function mysqlImportPipeline(
  dumpPath: string,
  db: WpDatabaseConfig,
  opts: { compressed?: boolean } = {}
): string {
  const reader = opts.compressed
    ? `gzip -dc ${shellQuote(dumpPath)}`
    : `cat ${shellQuote(dumpPath)}`
  // MYSQL_PWD keeps the password off the process list, where every other user
  // on the box could read it via `ps`.
  const mysqlCmd = [
    IN_CONTAINER_SQL_CLIENT,
    `--default-character-set=utf8mb4`,
    `--max-allowed-packet=512M`,
    `-h`, '127.0.0.1',
    `-u`, shellQuote(db.user),
    shellQuote(db.name),
  ].join(' ')

  if (db.container) {
    return `${reader} | sed -E ${shellQuote(SQL_SANITIZER)} | docker exec -i -e MYSQL_PWD=${shellQuote(db.password)} ${shellQuote(db.container)} sh -c ${shellQuote(mysqlCmd)}`
  }
  return `${reader} | sed -E ${shellQuote(SQL_SANITIZER)} | MYSQL_PWD=${shellQuote(db.password)} mysql --default-character-set=utf8mb4 --max-allowed-packet=512M -h ${shellQuote(db.host)} -P ${db.port ?? 3306} -u ${shellQuote(db.user)} ${shellQuote(db.name)}`
}

/**
 * Import a SQL dump into the project's database.
 *
 * Waits for the server to accept connections first — a database container
 * provisioned seconds earlier is usually still initialising, and an import
 * fired at it immediately fails with "connection refused" for no good reason.
 */
export async function importSqlDump(
  client: AnyClient,
  dumpPath: string,
  db: WpDatabaseConfig,
  opts: { onLog?: (l: string) => void; timeoutMs?: number } = {}
): Promise<{ tablesImported: number }> {
  const log = (l: string) => opts.onLog?.(l)

  await waitForDatabase(client, db, { onLog: log })

  const compressed = /\.gz$/i.test(dumpPath)
  log(`Importing database dump${compressed ? ' (gzipped)' : ''}…`)

  const r = await exec(client, mysqlImportPipeline(dumpPath, db, { compressed }), {
    timeoutMs: opts.timeoutMs ?? 3600_000,
  })
  if (r.exitCode !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(-600)
    throw new Error(`Database import failed: ${detail || 'unknown error'}`)
  }
  // Warnings on stderr are normal (deprecated collations, "Using a password on
  // the command line"), so they are logged rather than treated as failures.
  if (r.stderr.trim()) log(`mysql: ${r.stderr.trim().slice(-300)}`)

  const tables = await countTables(client, db)
  log(`Import complete — ${tables} table(s) in ${db.name}.`)
  if (tables === 0) {
    throw new Error(
      'The database import produced no tables. The dump may be empty or in an unsupported format.'
    )
  }
  return { tablesImported: tables }
}

/** Poll until the database accepts queries, or give up after ~2 minutes. */
export async function waitForDatabase(
  client: AnyClient,
  db: WpDatabaseConfig,
  opts: { onLog?: (l: string) => void; attempts?: number } = {}
): Promise<void> {
  const attempts = opts.attempts ?? 40
  for (let i = 0; i < attempts; i++) {
    const r = await runMysql(client, db, 'SELECT 1')
    if (r.exitCode === 0) {
      if (i > 0) opts.onLog?.(`Database ready after ${i * 3}s.`)
      return
    }
    await new Promise((res) => setTimeout(res, 3000))
  }
  throw new Error(
    `Database ${db.name} did not become reachable in time. It may still be starting up — retry the import.`
  )
}

/** Run one SQL statement, returning the raw result. */
async function runMysql(
  client: AnyClient,
  db: WpDatabaseConfig,
  sql: string,
  opts: { timeoutMs?: number } = {}
) {
  const inner = `${IN_CONTAINER_SQL_CLIENT} --default-character-set=utf8mb4 -h 127.0.0.1 -u ${shellQuote(db.user)} -N -B -e ${shellQuote(sql)} ${shellQuote(db.name)}`
  const cmd = db.container
    ? `docker exec -i -e MYSQL_PWD=${shellQuote(db.password)} ${shellQuote(db.container)} sh -c ${shellQuote(inner)}`
    : `MYSQL_PWD=${shellQuote(db.password)} mysql --default-character-set=utf8mb4 -h ${shellQuote(db.host)} -P ${db.port ?? 3306} -u ${shellQuote(db.user)} -N -B -e ${shellQuote(sql)} ${shellQuote(db.name)}`
  return exec(client, cmd, { timeoutMs: opts.timeoutMs ?? 120_000 })
}

async function countTables(
  client: AnyClient,
  db: WpDatabaseConfig
): Promise<number> {
  const r = await runMysql(
    client,
    db,
    `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()`
  )
  const n = parseInt(r.stdout.trim(), 10)
  return Number.isFinite(n) ? n : 0
}

/**
 * Drop every table in the database. Used by rollback when we imported into a
 * database that already existed, where dropping the database itself would
 * destroy something we did not create.
 */
export async function wipeDatabaseTables(
  client: AnyClient,
  db: WpDatabaseConfig
): Promise<void> {
  // The whole statement is handed to `mysql -e` inside single shell quotes, so
  // the MySQL identifier backticks below are literal and need no escaping.
  const sql =
    'SET FOREIGN_KEY_CHECKS = 0; ' +
    'SET @tables = NULL; ' +
    `SELECT GROUP_CONCAT(${BACKTICK_LITERAL}, table_name, ${BACKTICK_LITERAL}) INTO @tables ` +
    'FROM information_schema.tables WHERE table_schema = DATABASE(); ' +
    "SET @tables = IFNULL(CONCAT('DROP TABLE IF EXISTS ', @tables), 'SELECT 1'); " +
    'PREPARE stmt FROM @tables; EXECUTE stmt; DEALLOCATE PREPARE stmt; ' +
    'SET FOREIGN_KEY_CHECKS = 1;'
  await runMysql(client, db, sql, { timeoutMs: 300_000 })
}

// ─── URL rewriting ────────────────────────────────────────────────────────

export interface UrlRewriteResult {
  method: 'wp-cli' | 'sql-fallback'
  replacements: number
  warnings: string[]
}

/**
 * Rewrite every occurrence of the old site URL to the new one.
 *
 * Uses WP-CLI's `search-replace`, which unserialises, replaces, and
 * re-serialises — the only correct way to do this. `--precise` forces PHP-side
 * replacement instead of the faster SQL path (the SQL path skips serialised
 * columns); `--skip-columns=guid` is required because post GUIDs are permanent
 * identifiers, and rewriting them makes every feed reader treat the entire
 * blog as brand-new content.
 *
 * Both `http://old` → `https://new` and the protocol-relative `//old` → `//new`
 * are replaced, since themes commonly hard-code the latter.
 */
export async function rewriteSiteUrls(
  client: AnyClient,
  ctx: WpImportContext,
  oldUrl: string,
  newUrl: string,
  opts: { dockerNetwork?: string } = {}
): Promise<UrlRewriteResult> {
  const log = (l: string) => ctx.onLog?.(l)
  const warnings: string[] = []

  const oldClean = oldUrl.replace(/\/+$/, '')
  const newClean = newUrl.replace(/\/+$/, '')
  if (!oldClean || oldClean === newClean) {
    return { method: 'wp-cli', replacements: 0, warnings: [] }
  }

  const oldHost = hostOf(oldClean)
  const newHost = hostOf(newClean)

  log(`Rewriting URLs: ${oldClean} → ${newClean}`)

  const pairs: Array<[string, string]> = [
    [oldClean, newClean],
    // http/https variants of the same host, so a site exported from a plain
    // HTTP install lands on HTTPS here.
    [`http://${oldHost}`, `https://${newHost}`],
    [`https://${oldHost}`, `https://${newHost}`],
    [`//${oldHost}`, `//${newHost}`],
  ]

  const seen = new Set<string>()
  let total = 0
  let usedCli = false

  for (const [from, to] of pairs) {
    if (from === to) continue
    const key = `${from} ${to}`
    if (seen.has(key)) continue
    seen.add(key)

    const r = await runWpCli(
      client,
      ctx,
      [
        'search-replace',
        from,
        to,
        '--all-tables',
        '--precise',
        '--skip-columns=guid',
        '--report-changed-only',
      ],
      { network: opts.dockerNetwork, timeoutMs: 1800_000 }
    )
    if (r.ok) {
      usedCli = true
      total += parseReplacementCount(r.output)
      const summary = r.output.trim().split('\n').slice(-3).join(' ')
      if (summary) log(summary.slice(0, 300))
    } else {
      warnings.push(`WP-CLI search-replace failed for ${from}: ${r.output.slice(-200)}`)
    }
  }

  if (usedCli) {
    return { method: 'wp-cli', replacements: total, warnings }
  }

  // ── Fallback ──────────────────────────────────────────────────────
  //
  // WP-CLI could not run (no Docker image, no network). Fix the two option
  // rows that decide whether the site is reachable at all, plus post content
  // and metadata that is plain text. Serialised columns are deliberately NOT
  // touched here — a corrupted `wp_options.option_value` blob loses the
  // customer's widget and theme configuration permanently, which is far worse
  // than a handful of stale links they can fix later.
  log('WP-CLI unavailable — applying the safe SQL fallback for site URLs.')
  const p = ctx.db.tablePrefix
  const esc = (s: string) => s.replace(/'/g, "''")
  const statements = [
    `UPDATE ${ident(p + 'options')} SET option_value = '${esc(newClean)}' WHERE option_name IN ('siteurl','home');`,
    `UPDATE ${ident(p + 'posts')} SET post_content = REPLACE(post_content, '${esc(oldClean)}', '${esc(newClean)}');`,
    // Excludes anything that looks serialised (`s:<len>:`), where a length-
    // prefixed string would be corrupted by a plain text replacement.
    `UPDATE ${ident(p + 'postmeta')} SET meta_value = REPLACE(meta_value, '${esc(oldClean)}', '${esc(newClean)}') WHERE meta_value NOT LIKE '%s:%:%';`,
  ]
  let applied = 0
  for (const sql of statements) {
    const r = await runMysql(client, ctx.db, sql, { timeoutMs: 600_000 })
    if (r.exitCode === 0) applied++
  }
  warnings.push(
    'Site URLs were updated with the basic SQL method because WP-CLI was unavailable. Serialised settings (widgets, theme options, page-builder layouts) may still contain the old domain.'
  )
  return { method: 'sql-fallback', replacements: applied, warnings }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.replace(/^https?:\/\//i, '').split('/')[0]
  }
}

/** WP-CLI prints "Made N replacements." — pull N out for the progress log. */
function parseReplacementCount(output: string): number {
  const m = output.match(/Made (\d+) replacement/i)
  return m ? parseInt(m[1], 10) : 0
}

// ─── WP-CLI ───────────────────────────────────────────────────────────────

/**
 * Run a WP-CLI command against the site.
 *
 * WP-CLI runs in the official `wordpress:cli` image with the site bind-mounted
 * and joined to the platform's Docker network so it can reach the database
 * container by name. `--allow-root` is required because the image's entrypoint
 * drops to uid 33 but bind-mounted customer files are frequently owned by
 * something else.
 */
export async function runWpCli(
  client: AnyClient,
  ctx: WpImportContext,
  args: string[],
  opts: { network?: string; timeoutMs?: number } = {}
): Promise<{ ok: boolean; output: string }> {
  const network = opts.network || 'deployhub'
  const quoted = args.map((a) => shellQuote(a)).join(' ')
  const cmd =
    `docker run --rm --network ${shellQuote(network)} ` +
    `-v ${shellQuote(ctx.sitePath)}:/var/www/html ` +
    `-e WORDPRESS_DB_HOST=${shellQuote(ctx.db.container || ctx.db.host)} ` +
    `-e WORDPRESS_DB_USER=${shellQuote(ctx.db.user)} ` +
    `-e WORDPRESS_DB_PASSWORD=${shellQuote(ctx.db.password)} ` +
    `-e WORDPRESS_DB_NAME=${shellQuote(ctx.db.name)} ` +
    `wordpress:cli wp --path=/var/www/html --allow-root ${quoted} 2>&1`

  const r = await exec(client, cmd, { timeoutMs: opts.timeoutMs ?? 600_000 })
  return { ok: r.exitCode === 0, output: r.stdout || r.stderr }
}

// ─── wp-config.php ────────────────────────────────────────────────────────

/** WordPress's eight security keys, regenerated on import. */
function generateSalts(): string {
  const keys = [
    'AUTH_KEY',
    'SECURE_AUTH_KEY',
    'LOGGED_IN_KEY',
    'NONCE_KEY',
    'AUTH_SALT',
    'SECURE_AUTH_SALT',
    'LOGGED_IN_SALT',
    'NONCE_SALT',
  ]
  return keys
    .map((k) => {
      const v = crypto.randomBytes(48).toString('base64').replace(/'/g, '.')
      return `define('${k}', '${v}');`
    })
    .join('\n')
}

/**
 * Generate a wp-config.php for the imported site.
 *
 * Two details matter more than the rest:
 *
 *  - The proxy block. Caddy terminates TLS and forwards plain HTTP, so
 *    WordPress sees `HTTPS` unset and emits `http://` asset URLs on an
 *    `https://` page. Browsers block those as mixed content, which shows up as
 *    an unstyled admin area — the most-reported symptom of a migrated site.
 *  - `WP_HOME`/`WP_SITEURL`. Pinning them means the site is reachable on the
 *    new domain even if the URL rewrite missed a row, and it makes the import
 *    recoverable rather than leaving the customer locked out.
 *
 * Salts are regenerated deliberately: the old ones are in the customer's
 * backup file, which may have travelled through email or a shared drive.
 * Rotating them invalidates any session an attacker could have lifted, at the
 * cost of logging existing users out once.
 */
export function generateWpConfig(opts: {
  db: WpDatabaseConfig
  siteUrl: string
  /** Extra `define()` lines to append. */
  extraDefines?: string[]
  debug?: boolean
}): string {
  const { db, siteUrl } = opts
  const dbHost = db.port && db.port !== 3306 ? `${db.host}:${db.port}` : db.host
  const extra = (opts.extraDefines ?? []).join('\n')

  return `<?php
/**
 * WordPress configuration — generated by APSAMO Panel during site import.
 *
 * Edit freely; this file is not regenerated on later deploys.
 */

// ── Reverse-proxy awareness ──────────────────────────────────────────
// TLS terminates at the platform edge and traffic reaches this container
// over plain HTTP. Without this block WordPress believes the request was
// insecure and builds http:// URLs for every script and stylesheet, which
// the browser then blocks on an https:// page.
if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') {
    $_SERVER['HTTPS'] = 'on';
    $_SERVER['SERVER_PORT'] = 443;
}
if (isset($_SERVER['HTTP_X_FORWARDED_HOST'])) {
    $_SERVER['HTTP_HOST'] = $_SERVER['HTTP_X_FORWARDED_HOST'];
}

// ── Database ─────────────────────────────────────────────────────────
define('DB_NAME',     ${JSON.stringify(db.name)});
define('DB_USER',     ${JSON.stringify(db.user)});
define('DB_PASSWORD', ${JSON.stringify(db.password)});
define('DB_HOST',     ${JSON.stringify(dbHost)});
define('DB_CHARSET',  'utf8mb4');
define('DB_COLLATE',  '');

$table_prefix = ${JSON.stringify(db.tablePrefix)};

// ── Security keys (regenerated on import) ────────────────────────────
${generateSalts()}

// ── Site address ─────────────────────────────────────────────────────
define('WP_HOME',    ${JSON.stringify(siteUrl)});
define('WP_SITEURL', ${JSON.stringify(siteUrl)});

// ── Platform defaults ────────────────────────────────────────────────
define('WP_DEBUG', ${opts.debug ? 'true' : 'false'});
define('WP_DEBUG_LOG', ${opts.debug ? 'true' : 'false'});
define('WP_DEBUG_DISPLAY', false);
define('DISALLOW_FILE_EDIT', true);
define('WP_MEMORY_LIMIT', '256M');
define('WP_MAX_MEMORY_LIMIT', '512M');
define('AUTOMATIC_UPDATER_DISABLED', false);
define('WP_AUTO_UPDATE_CORE', 'minor');
define('FS_METHOD', 'direct');
${extra}

if (!defined('ABSPATH')) {
    define('ABSPATH', __DIR__ . '/');
}
require_once ABSPATH . 'wp-settings.php';
`
}

// ─── PHP configuration ────────────────────────────────────────────────────

/**
 * PHP settings written into the container's conf.d.
 *
 * The defaults in the official image (2 MB uploads, 30 s execution) are far
 * too small for a real site — a customer importing a 40 MB theme demo or
 * running a WooCommerce report hits them immediately.
 */
export function generatePhpIni(opts: {
  uploadMaxMb?: number
  memoryLimitMb?: number
  maxExecutionSeconds?: number
} = {}): string {
  const upload = opts.uploadMaxMb ?? 256
  const memory = opts.memoryLimitMb ?? 512
  const exec = opts.maxExecutionSeconds ?? 300
  return `; Generated by APSAMO Panel — tuned for imported WordPress sites.
upload_max_filesize = ${upload}M
post_max_size = ${upload + 16}M
memory_limit = ${memory}M
max_execution_time = ${exec}
max_input_time = ${exec}
; Page builders and large menus blow past the default 1000 input vars, which
; silently truncates the POST and loses part of the customer's page on save.
max_input_vars = 5000
date.timezone = UTC
expose_php = Off
display_errors = Off
log_errors = On
error_log = /var/log/php_errors.log
`
}

/** The stock WordPress rewrite rules, so permalinks work from the first request. */
export function generateHtaccess(): string {
  return `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`
}

// ─── Cache neutralisation ─────────────────────────────────────────────────

/**
 * Disable caching layers carried over from the old host.
 *
 * Drop-ins are removed outright (they are generated files, not customer
 * content) and plugin directories are *renamed*, not deleted — the customer's
 * licence keys and settings live in there, and they can re-enable the plugin
 * from wp-admin once the site is confirmed working.
 */
export async function disableCaching(
  client: AnyClient,
  sitePath: string,
  pluginSlugs: string[],
  opts: { onLog?: (l: string) => void } = {}
): Promise<{ disabled: string[]; removed: string[] }> {
  const log = (l: string) => opts.onLog?.(l)
  const disabled: string[] = []
  const removed: string[] = []

  for (const dropin of CACHE_DROPINS) {
    const p = `${sitePath}/wp-content/${dropin}`
    if (await remoteExists(client, p)) {
      await exec(client, `rm -f ${shellQuote(p)}`, { timeoutMs: 30000 })
      removed.push(dropin)
    }
  }

  const pluginRoot = `${sitePath}/wp-content/plugins`
  if (await remoteIsDir(client, pluginRoot)) {
    const present = new Set(await listDirs(client, pluginRoot))
    for (const slug of pluginSlugs) {
      const clean = slug.replace(/^dropin:/, '')
      if (clean.endsWith('.php')) continue
      if (!present.has(clean)) continue
      const from = `${pluginRoot}/${clean}`
      const to = `${pluginRoot}/${clean}.apsamo-disabled`
      const r = await exec(
        client,
        `rm -rf ${shellQuote(to)} && mv ${shellQuote(from)} ${shellQuote(to)}`,
        { timeoutMs: 60000 }
      )
      if (r.exitCode === 0) disabled.push(clean)
    }
  }

  // Cached page output from the old host is stale by definition and often
  // contains the old domain baked into every link.
  for (const dir of ['cache', 'w3tc-config', 'et-cache', 'litespeed']) {
    await exec(client, `rm -rf ${shellQuote(`${sitePath}/wp-content/${dir}`)}`, {
      timeoutMs: 120_000,
    })
  }

  if (disabled.length > 0 || removed.length > 0) {
    log(
      `Disabled caching: ${[...removed, ...disabled].join(', ')}. Re-enable from wp-admin once the site looks right.`
    )
  }
  return { disabled, removed }
}

/** Flush WordPress object/page caches and rewrite rules after the import. */
export async function flushWordPressCaches(
  client: AnyClient,
  ctx: WpImportContext,
  opts: { network?: string } = {}
): Promise<void> {
  const log = (l: string) => ctx.onLog?.(l)
  // Rewrite rules are stored in the database and reference the old host's
  // permalink structure; flushing regenerates them for this install.
  const commands: string[][] = [
    ['cache', 'flush'],
    ['rewrite', 'flush', '--hard'],
    ['transient', 'delete', '--all'],
  ]
  for (const args of commands) {
    const r = await runWpCli(client, ctx, args, {
      network: opts.network,
      timeoutMs: 300_000,
    })
    if (!r.ok) log(`wp ${args.join(' ')}: ${r.output.trim().slice(-160)}`)
  }
}

// ─── Permissions ──────────────────────────────────────────────────────────

/**
 * Apply the standard WordPress ownership and permission scheme.
 *
 * The official image runs Apache as `www-data` (uid 33), and the files are
 * bind-mounted from the host, so ownership has to be set by numeric id on the
 * host side — the container's `www-data` and the host's do not necessarily
 * share a uid, and a name-based chown would put the files out of the web
 * server's reach.
 *
 * 755/644 with a 640 wp-config is the scheme WordPress itself documents:
 * writable enough for plugin and media uploads, tight enough that the config —
 * which holds the database password — is not world-readable.
 */
export async function fixPermissions(
  client: AnyClient,
  sitePath: string,
  opts: { uid?: number; gid?: number; onLog?: (l: string) => void; wordpress?: boolean } = {}
): Promise<void> {
  const log = (l: string) => opts.onLog?.(l)
  const uid = opts.uid ?? 33
  const gid = opts.gid ?? 33
  const q = shellQuote(sitePath)

  log('Applying file ownership and permissions…')

  const steps = [
    `chown -R ${uid}:${gid} ${q}`,
    // `-print0 | xargs -0` rather than `-exec chmod {} \\;` — one chmod per
    // file takes many minutes on a site with 100k media files.
    `find ${q} -type d -print0 | xargs -0 -r chmod 755`,
    `find ${q} -type f -print0 | xargs -0 -r chmod 644`,
  ]
  if (opts.wordpress !== false) {
    steps.push(
      `[ -f ${q}/wp-config.php ] && chmod 640 ${q}/wp-config.php || true`,
      `[ -d ${q}/wp-content/uploads ] && chmod -R 755 ${q}/wp-content/uploads || true`
    )
  }

  for (const step of steps) {
    const r = await exec(client, step, { timeoutMs: 900_000 })
    if (r.exitCode !== 0 && r.stderr.trim()) {
      log(`permissions: ${r.stderr.trim().slice(-200)}`)
    }
  }
}

// ─── Post-import repair ───────────────────────────────────────────────────

/**
 * Best-effort fixes applied after the URL rewrite, each independently
 * optional. Failures are logged and skipped: none of them should be able to
 * fail an import that has already produced a working site.
 */
export async function repairWordPressInstall(
  client: AnyClient,
  ctx: WpImportContext,
  opts: { network?: string; siteUrl: string } = { siteUrl: '' }
): Promise<string[]> {
  const log = (l: string) => ctx.onLog?.(l)
  const notes: string[] = []

  // A stale .htaccess from the old host can reference modules this server does
  // not load, which Apache treats as a fatal 500 for every request.
  await writeRemoteText(client, `${ctx.sitePath}/.htaccess`, generateHtaccess(), {
    mode: 0o644,
  })
  notes.push('Rewrote .htaccess with the standard WordPress rules.')

  // `wp option update` is safe even when search-replace already set these.
  if (opts.siteUrl) {
    for (const key of ['siteurl', 'home']) {
      const r = await runWpCli(client, ctx, ['option', 'update', key, opts.siteUrl], {
        network: opts.network,
        timeoutMs: 120_000,
      })
      if (!r.ok) log(`Could not pin ${key}: ${r.output.trim().slice(-160)}`)
    }
  }

  // Elementor and similar builders keep their own CSS cache keyed by the old
  // domain; regenerating is cheap and prevents an unstyled first impression.
  const elementor = await runWpCli(client, ctx, ['elementor', 'flush-css'], {
    network: opts.network,
    timeoutMs: 180_000,
  })
  if (elementor.ok) notes.push('Regenerated Elementor CSS.')

  return notes
}
