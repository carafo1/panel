/**
 * Website type detection.
 * ======================
 *
 * Runs against the extracted tree on the target server and answers the
 * questions the rest of the pipeline needs: what kind of site is this, where
 * is its root, which file is the database dump, and — for WordPress — what URL
 * does it currently think it lives at.
 *
 * Detection is READ-ONLY and best-effort. Every probe degrades to a null or a
 * warning rather than throwing, because a customer whose backup is slightly
 * unusual should get a "we found X, confirm?" screen, not a failed import. The
 * one thing it will refuse outright is a multisite network, which needs a
 * genuinely different URL rewrite and would otherwise import into a broken
 * state.
 */
import {
  exec,
  shellQuote,
  remoteExists,
  remoteIsDir,
  remoteSize,
  remoteFileCount,
  readRemoteText,
  listDirs,
  listFileNames,
  findFilesBySize,
  type AnyClient,
} from './remote'
import type { DetectionResult, DetectedStack, MigrationSourceType } from './types'

// ─── Caching plugins ──────────────────────────────────────────────────────

/**
 * Caching plugins that must be neutralised before the imported site's first
 * request.
 *
 * All of these write absolute paths and the old domain into generated config
 * (`advanced-cache.php`, `wp-cache-config.php`, nginx/htaccess rules). On a
 * fresh host those paths do not exist, so WordPress fatals during bootstrap —
 * the classic "imported site shows a white screen" support ticket. Disabling
 * them costs the customer nothing: they re-enable in one click once live.
 */
export const CACHE_PLUGIN_SLUGS = [
  'w3-total-cache',
  'wp-super-cache',
  'wp-rocket',
  'litespeed-cache',
  'wp-fastest-cache',
  'cache-enabler',
  'comet-cache',
  'breeze',
  'swift-performance',
  'swift-performance-lite',
  'hummingbird-performance',
  'nitropack',
  'wp-optimize',
  'sg-cachepress',
  'redis-cache',
  'docket-cache',
]

/** Drop-ins WordPress loads before plugins — these must go too. */
export const CACHE_DROPINS = ['advanced-cache.php', 'object-cache.php', 'db.php']

// ─── WordPress probes ─────────────────────────────────────────────────────

/** Read `$wp_version` out of wp-includes/version.php. */
async function readWpVersion(
  client: AnyClient,
  root: string
): Promise<string | null> {
  const r = await exec(
    client,
    `grep -m1 -oE "\\\$wp_version *= *'[^']+'" ${shellQuote(`${root}/wp-includes/version.php`)} 2>/dev/null || true`,
    { timeoutMs: 20000 }
  )
  const m = r.stdout.match(/'([^']+)'/)
  return m ? m[1] : null
}

/**
 * Read the table prefix from wp-config.php.
 *
 * Anything but the default `wp_` matters a great deal: importing a dump whose
 * tables are `xyz_posts` while wp-config says `wp_` yields a site that boots
 * into a fresh install screen and looks like the import silently lost all the
 * customer's content.
 */
async function readTablePrefix(
  client: AnyClient,
  root: string
): Promise<string | null> {
  const r = await exec(
    client,
    `grep -m1 -oE "table_prefix *= *['\\"][^'\\"]+['\\"]" ${shellQuote(`${root}/wp-config.php`)} 2>/dev/null || true`,
    { timeoutMs: 20000 }
  )
  const m = r.stdout.match(/['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

/** Infer the prefix from the dump's CREATE TABLE statements. */
async function inferPrefixFromDump(
  client: AnyClient,
  sqlFile: string
): Promise<string | null> {
  const r = await exec(
    client,
    `grep -a -m1 -oiE "CREATE TABLE [\\\`\\"]?[A-Za-z0-9_]+options[\\\`\\"]?" ${shellQuote(sqlFile)} 2>/dev/null || true`,
    { timeoutMs: 300_000 }
  )
  const m = r.stdout.match(/CREATE TABLE [`"]?([A-Za-z0-9_]+)options[`"]?/i)
  return m ? m[1] : null
}

/**
 * Pull `siteurl` / `home` out of a dump's options table.
 *
 * Dump styles vary (`('siteurl','http://x')` vs `(1, 'siteurl', 'http://x')`,
 * extended vs complete inserts), so the pattern tolerates whitespace and a
 * leading id column. `grep -a` treats the dump as text even when a serialised
 * blob makes it look binary — without it grep prints "binary file matches" and
 * we detect nothing.
 */
async function readUrlFromDump(
  client: AnyClient,
  sqlFile: string,
  key: 'siteurl' | 'home'
): Promise<string | null> {
  const r = await exec(
    client,
    `grep -a -m1 -oiE "'${key}',[[:space:]]*'[^']*'" ${shellQuote(sqlFile)} 2>/dev/null | head -1 || true`,
    { timeoutMs: 300_000 }
  )
  const m = r.stdout.match(/'[^']*',\s*'([^']*)'/)
  const url = m ? m[1].trim() : null
  if (!url) return null
  if (!/^https?:\/\//i.test(url)) return null
  return url.replace(/\/+$/, '')
}

/** Multisite networks need a different rewrite; we detect and refuse them. */
async function isMultisite(
  client: AnyClient,
  root: string,
  sqlFile: string | null
): Promise<boolean> {
  const cfg = await exec(
    client,
    `grep -m1 -oE "define\\( *'MULTISITE' *, *true" ${shellQuote(`${root}/wp-config.php`)} 2>/dev/null || true`,
    { timeoutMs: 20000 }
  )
  if (cfg.stdout.trim()) return true
  if (sqlFile) {
    const dump = await exec(
      client,
      `grep -a -m1 -oiE "CREATE TABLE [\\\`\\"]?[A-Za-z0-9_]*blogs[\\\`\\"]?" ${shellQuote(sqlFile)} 2>/dev/null || true`,
      { timeoutMs: 300_000 }
    )
    if (dump.stdout.trim()) return true
  }
  return false
}

/** Which known cache plugins are present in wp-content/plugins. */
async function findCachePlugins(
  client: AnyClient,
  root: string
): Promise<string[]> {
  const pluginDir = `${root}/wp-content/plugins`
  if (!(await remoteIsDir(client, pluginDir))) return []
  const dirs = await listDirs(client, pluginDir)
  const present = dirs.filter((d) => CACHE_PLUGIN_SLUGS.includes(d.toLowerCase()))
  for (const dropin of CACHE_DROPINS) {
    if (await remoteExists(client, `${root}/wp-content/${dropin}`)) {
      present.push(`dropin:${dropin}`)
    }
  }
  return present
}

async function countChildren(
  client: AnyClient,
  dir: string
): Promise<number | null> {
  if (!(await remoteIsDir(client, dir))) return null
  const dirs = await listDirs(client, dir)
  return dirs.length
}

// ─── Root discovery ───────────────────────────────────────────────────────

/**
 * Find the site root when it is not the extraction root.
 *
 * Backups nest the site under `public_html/`, `www/`, `htdocs/`, or the site's
 * own name. Rather than guess from names alone, look for the marker files and
 * take the shallowest match — the shallowest wp-config.php is the install; a
 * deeper one is almost always a stale copy inside a backup plugin's folder.
 */
async function findSiteRoot(
  client: AnyClient,
  extractDir: string
): Promise<{ root: string; marker: string | null }> {
  const markers = [
    'wp-config.php',
    'wp-load.php',
    'artisan',
    'composer.json',
    'package.json',
    'index.php',
    'index.html',
    'Dockerfile',
    'docker-compose.yml',
  ]

  for (const marker of markers) {
    if (await remoteExists(client, `${extractDir}/${marker}`)) {
      return { root: extractDir, marker }
    }
  }

  // Common wrapper directory names, checked before a full-tree search.
  const wrappers = ['public_html', 'www', 'htdocs', 'html', 'web', 'site', 'app', 'wordpress']
  for (const w of wrappers) {
    const candidate = `${extractDir}/${w}`
    if (!(await remoteIsDir(client, candidate))) continue
    for (const marker of markers) {
      if (await remoteExists(client, `${candidate}/${marker}`)) {
        return { root: candidate, marker }
      }
    }
  }

  // Last resort: shallowest wp-config.php or index.php anywhere in the tree.
  for (const marker of ['wp-config.php', 'wp-load.php', 'index.php']) {
    const r = await exec(
      client,
      `find ${shellQuote(extractDir)} -maxdepth 5 -name ${shellQuote(marker)} -type f -printf '%d\\t%p\\n' 2>/dev/null | sort -n | head -1 || true`,
      { timeoutMs: 120_000 }
    )
    const line = r.stdout.trim()
    if (line) {
      const p = line.split('\t')[1]
      if (p) {
        const dir = p.slice(0, p.lastIndexOf('/'))
        return { root: dir, marker }
      }
    }
  }

  return { root: extractDir, marker: null }
}

// ─── Stack detection ──────────────────────────────────────────────────────

async function detectStack(
  client: AnyClient,
  root: string
): Promise<{ stack: DetectedStack; documentRoot: string | null }> {
  const has = (f: string) => remoteExists(client, `${root}/${f}`)
  const hasDir = (d: string) => remoteIsDir(client, `${root}/${d}`)

  // WordPress first — a WP install also contains index.php and often a
  // composer.json, so a generic PHP check would shadow it.
  if ((await has('wp-config.php')) || (await has('wp-load.php')) || (await hasDir('wp-includes'))) {
    return { stack: 'wordpress', documentRoot: null }
  }
  if ((await has('artisan')) && (await hasDir('app'))) {
    return { stack: 'laravel', documentRoot: 'public' }
  }
  if ((await has('docker-compose.yml')) || (await has('compose.yaml')) || (await has('Dockerfile'))) {
    return { stack: 'docker', documentRoot: null }
  }
  if (await has('package.json')) {
    return { stack: 'nodejs', documentRoot: null }
  }
  if ((await has('requirements.txt')) || (await has('manage.py')) || (await has('pyproject.toml'))) {
    return { stack: 'python', documentRoot: null }
  }
  if ((await has('index.php')) || (await has('composer.json'))) {
    return { stack: 'php', documentRoot: null }
  }
  if ((await has('index.html')) || (await has('index.htm'))) {
    return { stack: 'static', documentRoot: null }
  }
  return { stack: 'unknown', documentRoot: null }
}

// ─── Entry point ──────────────────────────────────────────────────────────

export interface DetectOptions {
  extractDir: string
  sqlFiles: string[]
  sourceType: MigrationSourceType
  /** Warnings accumulated by extraction, carried into the result. */
  priorWarnings?: string[]
  onLog?: (line: string) => void
}

/**
 * Inspect an extracted payload and describe what it is.
 *
 * The returned object is persisted verbatim on the migration row and rendered
 * on the review screen, so it is written for a human to read as much as for
 * the pipeline to consume.
 */
export async function detectSite(
  client: AnyClient,
  opts: DetectOptions
): Promise<DetectionResult> {
  const log = (l: string) => opts.onLog?.(l)
  const warnings = [...(opts.priorWarnings ?? [])]

  const { root, marker } = await findSiteRoot(client, opts.extractDir)
  if (root !== opts.extractDir) {
    log(`Site root found at ${root.replace(opts.extractDir, '.')}`)
  }

  const { stack, documentRoot } = await detectStack(client, root)
  log(`Detected stack: ${stack}${marker ? ` (matched ${marker})` : ''}`)

  const [sizeBytes, fileCount] = await Promise.all([
    remoteSize(client, root),
    remoteFileCount(client, root),
  ])

  // Rank SQL dumps: biggest first, but a dump that mentions the options table
  // outranks a bigger one that does not (customers often include an unrelated
  // analytics export that dwarfs the real dump).
  const rankedSql = await rankSqlFiles(client, opts.sqlFiles)

  const result: DetectionResult = {
    stack,
    rootDir: root,
    documentRoot,
    sqlFiles: rankedSql,
    sizeBytes: sizeBytes || null,
    fileCount: fileCount || null,
    warnings,
    hasDockerfile: await remoteExists(client, `${root}/Dockerfile`),
    hasCompose:
      (await remoteExists(client, `${root}/docker-compose.yml`)) ||
      (await remoteExists(client, `${root}/compose.yaml`)),
  }

  if (stack === 'wordpress') {
    const primarySql = rankedSql[0] ?? null
    const version = await readWpVersion(client, root)
    let tablePrefix = await readTablePrefix(client, root)
    if (!tablePrefix && primarySql) {
      tablePrefix = await inferPrefixFromDump(client, primarySql)
      if (tablePrefix) {
        log(`Table prefix "${tablePrefix}" inferred from the database dump.`)
      }
    }
    const siteUrl = primarySql ? await readUrlFromDump(client, primarySql, 'siteurl') : null
    const homeUrl = primarySql ? await readUrlFromDump(client, primarySql, 'home') : null
    const multisite = await isMultisite(client, root, primarySql)
    const cachePlugins = await findCachePlugins(client, root)

    result.wordpress = {
      version,
      tablePrefix: tablePrefix || 'wp_',
      siteUrl,
      homeUrl,
      hasWpContent: await remoteIsDir(client, `${root}/wp-content`),
      pluginCount: await countChildren(client, `${root}/wp-content/plugins`),
      themeCount: await countChildren(client, `${root}/wp-content/themes`),
      isMultisite: multisite,
      cachePlugins,
    }

    if (version) log(`WordPress ${version} detected.`)
    if (siteUrl) log(`Current site URL: ${siteUrl}`)

    if (!primarySql) {
      warnings.push(
        'No database dump was found in this backup. The files will be imported, but the site will need a database before it can serve content.'
      )
    }
    if (!result.wordpress.hasWpContent) {
      warnings.push(
        'No wp-content directory found — themes, plugins, and uploads may be missing from this backup.'
      )
    }
    if (multisite) {
      warnings.push(
        'This is a WordPress MULTISITE network. Automatic import does not support multisite yet — the network URL rewrite differs per subsite and would leave the network unreachable.'
      )
    }
    if (cachePlugins.length > 0) {
      log(
        `Caching plugins found (${cachePlugins.join(', ')}) — they will be disabled so the site boots cleanly.`
      )
    }
    if (!siteUrl && primarySql) {
      warnings.push(
        'Could not read the original site URL from the database dump. Set it manually if links on the imported site point at the old domain.'
      )
    }
  } else if (stack === 'unknown') {
    warnings.push(
      'Could not identify the website type from the uploaded files. It will be imported as static files — pick a different source type if that is wrong.'
    )
  }

  if (rankedSql.length > 1) {
    log(`${rankedSql.length} SQL dumps found — importing the most likely one first.`)
  }

  return result
}

/**
 * Order dumps so the real site database wins.
 *
 * Size alone is a poor signal, so a dump containing an `options` or `users`
 * table is promoted above any that does not. This is the difference between
 * restoring the customer's site and restoring a stray table export that
 * happened to be sitting in their backup folder.
 */
async function rankSqlFiles(
  client: AnyClient,
  files: string[]
): Promise<string[]> {
  if (files.length <= 1) return files
  const scored: Array<{ path: string; score: number; size: number }> = []
  for (const f of files.slice(0, 20)) {
    const sizeR = await exec(
      client,
      `stat -c %s ${shellQuote(f)} 2>/dev/null || echo 0`,
      { timeoutMs: 15000 }
    )
    const size = parseInt(sizeR.stdout.trim(), 10) || 0
    // Only sample the head — a full scan of every candidate dump would take
    // minutes on a large backup and this is a ranking heuristic, not a proof.
    const head = await exec(
      client,
      `head -c 2000000 ${shellQuote(f)} 2>/dev/null | grep -a -ciE "CREATE TABLE [\\\`\\"]?[A-Za-z0-9_]*(options|users|posts)" || true`,
      { timeoutMs: 60000 }
    )
    const hits = parseInt(head.stdout.trim(), 10) || 0
    scored.push({ path: f, score: hits, size })
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.size - a.size))
  return scored.map((s) => s.path)
}

// ─── Quick pre-flight validation ──────────────────────────────────────────

export interface ValidationIssue {
  level: 'error' | 'warning'
  message: string
}

/**
 * Checks run before anything is written to the project, so a doomed import
 * fails in seconds rather than after a 20-minute transfer.
 */
export function validateDetection(
  detection: DetectionResult,
  opts: { requireDatabase?: boolean } = {}
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (detection.wordpress?.isMultisite) {
    issues.push({
      level: 'error',
      message:
        'WordPress multisite networks cannot be imported automatically. Export a single site from the network and import that instead.',
    })
  }

  if (detection.stack === 'unknown' && detection.sqlFiles.length === 0) {
    issues.push({
      level: 'error',
      message:
        'This archive does not look like a website backup — no recognisable application files and no database dump were found.',
    })
  }

  if (opts.requireDatabase && detection.sqlFiles.length === 0) {
    issues.push({
      level: 'error',
      message: 'A database dump is required for this import type, but none was found.',
    })
  }

  if (detection.stack === 'wordpress' && !detection.wordpress?.hasWpContent) {
    issues.push({
      level: 'warning',
      message: 'wp-content is missing — the imported site may have no themes or media.',
    })
  }

  for (const w of detection.warnings) {
    issues.push({ level: 'warning', message: w })
  }

  return issues
}
