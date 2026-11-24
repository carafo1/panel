/**
 * Staging sites.
 * ==============
 *
 * A staging site is a private copy of a live website on its own address,
 * where the customer can try plugin updates, theme changes or code before
 * their visitors see them. It is its own Project row (environment "staging",
 * parentProjectId → the live site) so every existing tool — files, WordPress,
 * databases, logs — works on it unchanged. It is hidden from project lists
 * and does not count toward the plan's website limit.
 *
 * What gets copied depends on how the site is built:
 *
 *   wordpress  wp-content/ and the database. wp-config is NOT copied — each
 *              site's is generated with its own database credentials, so
 *              staging can never write to the live database. URLs are
 *              rewritten with WP-CLI and staging is hidden from search engines.
 *   files      Every file except generated build files and .env, plus the
 *              primary database when both sites have one.
 *   git        Staging builds a branch of the repository (no file copy). Going
 *              live is a merge on the Git host, which auto-deploys production —
 *              so "push to live" is not offered for these.
 *
 * "Push to live" always takes a backup of the live site first, and can leave
 * the live database alone (files only) for shops and sites with new orders or
 * comments since staging was made.
 *
 * Long operations run in the background; progress is kept on the staging row
 * (stagingStatus / stagingMessage) and the owner gets a notification.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { BRAND_DOMAIN } from '@/lib/brand-config'
import { decrypt } from '@/lib/encryption'
import { createNotification } from '@/lib/notifications'
import { claimDeploySlot } from '@/lib/deploy-guard'
import { isAdmin } from '@/lib/security'
import { isProduction } from '@/lib/demo-mode'
import { deployProject } from '@/lib/vps/deployer'
import { createBackup } from '@/lib/vps/backups'
import { getServerCredentials } from '@/lib/vps/provisioner'
import { withConnection, exec, shellQuote, isServerInDemoMode } from '@/lib/vps/ssh'

export class StagingError extends Error {
  constructor(message: string, public status = 400) {
    super(message)
  }
}

export type StagingMode = 'wordpress' | 'files' | 'git'

type ProjectRow = NonNullable<Awaited<ReturnType<typeof loadProject>>>

async function loadProject(id: string) {
  return db.project.findUnique({ where: { id }, include: { server: true, websiteDatabases: true } })
}

const isWordPress = (p: { deploymentMethod: string | null; stack: string; framework: string }) =>
  p.deploymentMethod === 'wordpress' || p.stack === 'wordpress' || p.framework === 'wordpress'

/** How a site can be staged, or why it can't. */
export function stagingMode(p: {
  deploymentMethod: string | null
  deploymentSource: string | null
  stack: string
  framework: string
  repoUrl: string | null
}): { mode: StagingMode } | { mode: null; reason: string } {
  if (isWordPress(p)) return { mode: 'wordpress' }
  if (p.deploymentMethod === 'docker') {
    return { mode: null, reason: 'Sites that bring their own Docker Compose file name their own containers, so a second copy would clash. Use a separate project for staging.' }
  }
  if (p.deploymentSource === 'git' && p.repoUrl) return { mode: 'git' }
  return { mode: 'files' }
}

/** Plan feature check. Admins and users without a plan are not limited. */
export async function planAllowsStaging(userId: string, role?: string): Promise<{ allowed: boolean; planName: string | null }> {
  if (role && isAdmin(role)) return { allowed: true, planName: null }
  const sub = await db.subscription.findFirst({
    where: { userId, status: { in: ['active', 'trialing', 'past_due'] } },
    orderBy: { createdAt: 'desc' },
    include: { plan: { select: { name: true, stagingEnvironment: true } } },
  })
  if (!sub?.plan) return { allowed: true, planName: null }
  return { allowed: sub.plan.stagingEnvironment, planName: sub.plan.name }
}

export async function findStaging(liveId: string) {
  return db.project.findFirst({ where: { parentProjectId: liveId, environment: 'staging' } })
}

function publicView(s: Awaited<ReturnType<typeof findStaging>>) {
  if (!s) return null
  return {
    id: s.id,
    name: s.name,
    url: `https://${s.subdomain}`,
    subdomain: s.subdomain,
    status: s.status,
    stagingStatus: s.stagingStatus,
    stagingMessage: s.stagingMessage,
    syncedAt: s.stagingSyncedAt,
    pushedAt: s.stagingPushedAt,
    branch: s.deploymentSource === 'git' ? s.sourceBranch : null,
    createdAt: s.createdAt,
  }
}

export async function stagingInfo(liveId: string, actor: { userId: string; role?: string }) {
  const live = await loadProject(liveId)
  if (!live) throw new StagingError('Website not found.', 404)
  if (live.environment === 'staging') throw new StagingError('This is already a staging site. Open its live site to manage staging.', 409)
  const m = stagingMode(live)
  const plan = await planAllowsStaging(live.userId, actor.role)
  return {
    supported: m.mode !== null,
    reason: m.mode === null ? m.reason : null,
    mode: m.mode,
    planAllows: plan.allowed,
    planName: plan.planName,
    liveBranch: live.sourceBranch,
    staging: publicView(await findStaging(liveId)),
  }
}

// ── Shell building blocks (pure, so they can be tested) ───────────────

/** Pinned helper image for file copies (busybox tar/find; no network). */
export const COPY_IMAGE = 'alpine:3.20'

/**
 * The copy between two sites' files, run INSIDE a throwaway container that
 * sees only the two deploy paths (live read-only at /src, target at /dst).
 *
 * SECURITY: customers control everything inside their deploy paths (SFTP,
 * file manager). This copy used to run as root on the host, so a customer
 * who replaced wp-content with a symlink (to / or to another customer's site)
 * made the panel archive host files into their site, or extract their files
 * anywhere on the host. Inside the container a symlink resolves within the
 * container's own filesystem, never the host's. Only the deploy paths
 * themselves (created and owned by the panel, not replaceable by a customer)
 * are mounted.
 */
export function copyFilesCommand(mode: 'wordpress' | 'files', from: string, to: string, opts: { replace: boolean }): string {
  for (const p of [from, to]) {
    if (!p.startsWith('/opt/deployhub/projects/') || p.includes('..') || p.includes('\n') || p.includes('\r')) {
      throw new Error('Unexpected site path')
    }
  }
  const script = copyFilesScript(mode, '/src', '/dst', opts)
  return [
    'docker run --rm --network none --security-opt no-new-privileges',
    '--cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER',
    `-v ${shellQuote(from)}:/src:ro -v ${shellQuote(to)}:/dst`,
    COPY_IMAGE,
    'sh -c',
    shellQuote(script),
  ].join(' ')
}

/** The copy script itself (pure, so it can be tested in a local shell). */
export function copyFilesScript(mode: 'wordpress' | 'files', from: string, to: string, opts: { replace: boolean }): string {
  if (mode === 'wordpress') {
    const src = `${from}/wp-content`
    const dst = `${to}/wp-content`
    const old = `${to}/wp-content.staging-old`
    const [S, D, O] = [shellQuote(src), shellQuote(dst), shellQuote(old)]
    // Explicit steps, not an &&/|| chain: in sh `a && b || c` runs c when a
    // fails, which would run the rollback (deleting the destination) when the
    // source folder is simply missing. Swap the old copy aside, copy, and only
    // drop the old copy once the new one is in place; put it back on failure.
    return [
      `if [ -L ${S} ] || [ -L ${D} ]; then echo 'wp-content must be a folder, not a link.' >&2; exit 1; fi`,
      `test -d ${S} || { echo 'The source site has no wp-content folder.' >&2; exit 1; }`,
      `rm -rf ${O}`,
      opts.replace ? `if [ -d ${D} ]; then mv ${D} ${O} || exit 1; fi` : 'true',
      `mkdir -p ${D} || exit 1`,
      `if tar -C ${S} -cf - . | tar -C ${D} -xpf -; then rm -rf ${O}; else rm -rf ${D}; if [ -d ${O} ]; then mv ${O} ${D}; fi; exit 1; fi`,
    ].join('; ')
  }
  // Generated per site by the deployer, or holding that site's own secrets.
  const keep = ['docker-compose.yml', 'Dockerfile', '.env', 'wp-config.php', 'wp-config-docker.php', '.git']
  const excludes = keep.map((k) => `--exclude=${shellQuote('./' + k)}`).join(' ')
  const notKept = keep.map((k) => `! -name ${shellQuote(k)}`).join(' ')
  return [
    `test -d ${shellQuote(from)}`,
    `mkdir -p ${shellQuote(to)}`,
    opts.replace ? `find ${shellQuote(to)} -mindepth 1 -maxdepth 1 ${notKept} -exec rm -rf {} +` : 'true',
    `tar -C ${shellQuote(from)} ${excludes} -cf - . | tar -C ${shellQuote(to)} -xpf -`,
  ].join(' && ')
}

interface DbRef {
  type: string
  container: string
  name: string
  user: string
  password: string
}

/** Dump one database into another of the same engine (both Docker containers). */
export function copyDatabaseCommand(src: DbRef, dst: DbRef, tmpFile: string): string {
  const q = shellQuote
  if (src.type === 'postgres') {
    const dump = `docker exec -e PGPASSWORD=${q(src.password)} ${q(src.container)} pg_dump -U ${q(src.user)} -d ${q(src.name)} --clean --if-exists --no-owner --no-privileges > ${q(tmpFile)}`
    const load = `docker exec -i -e PGPASSWORD=${q(dst.password)} ${q(dst.container)} psql -q -v ON_ERROR_STOP=1 -U ${q(dst.user)} -d ${q(dst.name)} < ${q(tmpFile)}`
    return `${dump} && ${load}; rc=$?; rm -f ${q(tmpFile)}; exit $rc`
  }
  const dumpInner = `if command -v mariadb-dump >/dev/null 2>&1; then mariadb-dump --single-transaction --no-tablespaces --routines -u"$U" "$D"; else mysqldump --single-transaction --no-tablespaces --routines -u"$U" "$D"; fi`
  const loadInner = `if command -v mariadb >/dev/null 2>&1; then mariadb -u"$U" "$D"; else mysql -u"$U" "$D"; fi`
  const dump = `docker exec -e MYSQL_PWD=${q(src.password)} -e U=${q(src.user)} -e D=${q(src.name)} ${q(src.container)} sh -c ${q(dumpInner)} > ${q(tmpFile)}`
  const load = `docker exec -i -e MYSQL_PWD=${q(dst.password)} -e U=${q(dst.user)} -e D=${q(dst.name)} ${q(dst.container)} sh -c ${q(loadInner)} < ${q(tmpFile)}`
  return `${dump} && ${load}; rc=$?; rm -f ${q(tmpFile)}; exit $rc`
}

/** WP-CLI against a running WordPress container's files. */
export function wpCliCommand(container: string, args: string): string {
  return `docker run --rm --network deployhub --user 33:33 --volumes-from ${shellQuote(container)} -w /var/www/html wordpress:cli wp ${args}`
}

// ── Helpers ───────────────────────────────────────────────────────────

function primaryDb(p: ProjectRow): DbRef | null {
  const row = p.websiteDatabases.find((d) => d.isPrimary) || p.websiteDatabases[0]
  if (!row || !row.externalRef || row.type === 'sqlite') return null
  let password = ''
  try {
    password = decrypt(row.password)
  } catch {
    return null
  }
  return { type: row.type === 'postgres' ? 'postgres' : 'mysql', container: row.externalRef, name: row.name, user: row.username, password }
}

const siteUrl = (p: { customDomain: string | null; subdomain: string }) => `https://${p.customDomain || p.subdomain}`

async function setState(stagingId: string, data: { stagingStatus?: string; stagingMessage?: string | null; stagingSyncedAt?: Date; stagingPushedAt?: Date }) {
  await db.project.update({ where: { id: stagingId }, data }).catch(() => {})
}

async function notify(userId: string, title: string, message: string, ok: boolean, liveId: string) {
  await createNotification({ userId, title, message, type: ok ? 'success' : 'error', link: `/?tab=hosting&project=${liveId}` }).catch(() => {})
}

function isDemo(p: ProjectRow) {
  // Production: a site without a server is NOT a simulation; the real path
  // runs and fails with the actual reason.
  if (isProduction()) return false
  return !p.server || isServerInDemoMode(p.server)
}

async function run(p: ProjectRow, command: string, timeoutMs = 600_000) {
  const creds = await getServerCredentials(p.serverId!)
  const r = await withConnection(creds, (client) => exec(client, command, { timeoutMs }))
  if (r.exitCode !== 0) {
    // Never echo the command (it can hold database passwords).
    const out = `${r.stderr || ''}\n${r.stdout || ''}`.trim().split('\n').slice(-3).join(' ').slice(0, 300)
    throw new Error(out || `exit code ${r.exitCode}`)
  }
  return r.stdout
}

/**
 * Copy content from one site to another on the same server.
 * `direction` only changes the wording of errors and which URL is rewritten.
 */
async function copyContent(from: ProjectRow, to: ProjectRow, mode: StagingMode, opts: { database: boolean; replace: boolean; files?: boolean; log: (m: string) => void }) {
  if (isDemo(to)) {
    opts.log('[demo] Simulated copy of files' + (opts.database ? ' and database' : ''))
    return
  }
  if (from.serverId !== to.serverId) throw new Error('The staging and live sites are on different servers.')
  if (!from.deployPath || !to.deployPath) throw new Error('One of the sites has not finished deploying yet.')

  if (mode !== 'git' && opts.files !== false) {
    opts.log('Copying files…')
    await run(to, copyFilesCommand(mode, from.deployPath, to.deployPath, { replace: opts.replace }))
  }

  if (opts.database) {
    const src = primaryDb(from)
    const dst = primaryDb(to)
    if (src && dst && src.type === dst.type) {
      opts.log('Copying the database…')
      const tmp = `/tmp/apsamo-staging-${crypto.randomBytes(6).toString('hex')}.sql`
      await run(to, copyDatabaseCommand(src, dst, tmp))
    } else if (src || dst) {
      opts.log('Database not copied: the two sites do not both have a database of the same type.')
    }
  }

  if (mode === 'wordpress' && opts.database && to.containerName) {
    const oldUrl = siteUrl(from).replace(/^https:/, '')
    const newUrl = siteUrl(to).replace(/^https:/, '')
    opts.log(`Rewriting addresses ${oldUrl} → ${newUrl}…`)
    await run(to, wpCliCommand(to.containerName, `search-replace ${shellQuote(oldUrl)} ${shellQuote(newUrl)} --all-tables --skip-columns=guid --precise --quiet`))
    await run(to, wpCliCommand(to.containerName, 'cache flush')).catch(() => {})
  }
}

// ── Create ────────────────────────────────────────────────────────────

const STAGING_SLUG = (slug: string) => `${slug.slice(0, 40)}-staging`

export async function createStaging(liveId: string, actor: { userId: string; role?: string }, input: { branch?: unknown } = {}) {
  const live = await loadProject(liveId)
  if (!live) throw new StagingError('Website not found.', 404)
  if (live.environment === 'staging') throw new StagingError('A staging site cannot have its own staging site.', 409)
  if (live.status === 'suspended') throw new StagingError('This website is suspended. Pay the outstanding invoice first.', 402)
  if (!['running', 'stopped'].includes(live.status)) throw new StagingError('Wait until the website has finished deploying.', 409)
  const m = stagingMode(live)
  if (m.mode === null) throw new StagingError(m.reason, 409)
  const plan = await planAllowsStaging(live.userId, actor.role)
  if (!plan.allowed) throw new StagingError(`Staging is not included in the ${plan.planName} plan. Upgrade to a plan with staging to use it.`, 403)
  if (await findStaging(liveId)) throw new StagingError('This website already has a staging site.', 409)

  let branch = live.sourceBranch || 'main'
  if (m.mode === 'git' && typeof input.branch === 'string' && input.branch.trim()) {
    branch = input.branch.trim()
    if (!/^[A-Za-z0-9._/-]{1,100}$/.test(branch) || branch.includes('..')) throw new StagingError('That is not a valid branch name.')
  }

  let slug = STAGING_SLUG(live.slug)
  if (await db.project.findFirst({ where: { slug }, select: { id: true } })) slug = `${slug}-${crypto.randomBytes(2).toString('hex')}`

  const envVars = await db.environmentVariable.findMany({ where: { projectId: liveId } })

  const staging = await db.project.create({
    data: {
      userId: live.userId,
      teamId: live.teamId,
      name: `${live.name} (staging)`,
      slug,
      description: `Staging copy of ${live.name}`,
      framework: live.framework,
      stack: live.stack,
      status: 'creating',
      serverId: live.serverId,
      subdomain: `${slug}.${BRAND_DOMAIN}`,
      sslEnabled: true,
      autoDeploy: false,
      repoUrl: live.repoUrl,
      deploymentMethod: live.deploymentMethod,
      // Files are placed by the copy below; the deployer leaves them alone.
      deploymentSource: m.mode === 'git' ? 'git' : 'imported',
      sourceProvider: live.sourceProvider,
      sourceBranch: branch,
      runtime: live.runtime,
      runtimeVersion: live.runtimeVersion,
      buildCommand: live.buildCommand,
      startCommand: live.startCommand,
      appPort: live.appPort,
      documentRoot: live.documentRoot,
      wpAdminUser: live.wpAdminUser,
      wpAdminEmail: live.wpAdminEmail,
      wpAdminPassword: live.wpAdminPassword,
      resourceCpuCores: live.resourceCpuCores,
      resourceRamMB: live.resourceRamMB,
      resourceStorageGB: live.resourceStorageGB,
      installSettings: live.installSettings,
      deployPath: `/opt/deployhub/projects/${slug}`,
      environment: 'staging',
      parentProjectId: liveId,
      stagingStatus: 'creating',
      stagingMessage: 'Creating the staging site…',
      envVars: envVars.length
        ? { create: envVars.map((v) => ({ key: v.key, value: v.value, encrypted: v.encrypted })) }
        : undefined,
    },
  })

  void buildStaging(staging.id, liveId, m.mode, actor.userId).catch((err) => console.error('[staging] create crashed:', err))
  return publicView(staging)
}

async function buildStaging(stagingId: string, liveId: string, mode: StagingMode, actorId: string) {
  const log = (msg: string) => {
    console.log(`[staging ${stagingId.slice(0, 8)}] ${msg}`)
    void setState(stagingId, { stagingMessage: msg })
  }
  try {
    const live = (await loadProject(liveId))!
    let staging = (await loadProject(stagingId))!

    // Files first, so the deployer builds/serves them (source "imported").
    if (mode !== 'git' && !isDemo(staging) && live.deployPath && staging.deployPath) {
      log('Copying files from the live site…')
      await run(staging, copyFilesCommand(mode, live.deployPath, staging.deployPath, { replace: false }))
    }

    log('Deploying the staging site…')
    const claim = await claimDeploySlot({ projectId: stagingId, userId: staging.userId, branch: staging.sourceBranch || 'main', triggeredBy: 'staging', buildLog: 'Creating staging site…' })
    if (!claim.ok) throw new Error('A deployment is already running for the staging site.')
    const result = await deployProject({ projectId: stagingId, deploymentId: claim.deploymentId })
    if (!result.ok) throw new Error(result.error || 'The staging deployment failed. Open its deployment log for details.')

    staging = (await loadProject(stagingId))!
    log('Copying the database from the live site…')
    // Files were placed before the deploy; only the data is left.
    await copyContent(live, staging, mode, { database: true, replace: true, files: false, log })
    if (mode === 'wordpress' && staging.containerName && !isDemo(staging)) {
      // Keep staging out of search results.
      await run(staging, wpCliCommand(staging.containerName, 'option update blog_public 0')).catch(() => {})
    }

    await setState(stagingId, { stagingStatus: 'ready', stagingMessage: null, stagingSyncedAt: new Date() })
    await notify(actorId, 'Staging site ready', `${staging.name} is ready at https://${staging.subdomain}`, true, liveId)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[staging] create failed:', msg)
    await setState(stagingId, { stagingStatus: 'failed', stagingMessage: `Creating staging failed: ${msg}` })
    await notify(actorId, 'Staging site failed', msg.slice(0, 300), false, liveId)
  }
}

// ── Refresh staging from live ─────────────────────────────────────────

async function lockStaging(liveId: string, next: 'syncing' | 'pushing') {
  const staging = await findStaging(liveId)
  if (!staging) throw new StagingError('This website has no staging site.', 404)
  // Only one long operation at a time.
  const locked = await db.project.updateMany({
    where: { id: staging.id, stagingStatus: { in: ['ready', 'failed'] } },
    data: { stagingStatus: next, stagingMessage: next === 'syncing' ? 'Refreshing from the live site…' : 'Pushing to the live site…' },
  })
  if (!locked.count) throw new StagingError('Staging is busy. Wait for the current operation to finish.', 409)
  return staging
}

export async function syncFromLive(liveId: string, actor: { userId: string }, input: { database?: unknown } = {}) {
  const live = await loadProject(liveId)
  if (!live) throw new StagingError('Website not found.', 404)
  const m = stagingMode(live)
  if (m.mode === null) throw new StagingError(m.reason, 409)
  const staging = await lockStaging(liveId, 'syncing')
  const database = input.database !== false

  void (async () => {
    const log = (msg: string) => void setState(staging.id, { stagingMessage: msg })
    try {
      const s = (await loadProject(staging.id))!
      await copyContent(live, s, m.mode, { database, replace: true, log })
      if (m.mode === 'wordpress' && s.containerName && !isDemo(s)) {
        await run(s, wpCliCommand(s.containerName, 'option update blog_public 0')).catch(() => {})
      }
      await setState(staging.id, { stagingStatus: 'ready', stagingMessage: null, stagingSyncedAt: new Date() })
      await notify(actor.userId, 'Staging refreshed', `${s.name} now matches the live site.`, true, liveId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await setState(staging.id, { stagingStatus: 'failed', stagingMessage: `Refresh failed: ${msg}` })
      await notify(actor.userId, 'Staging refresh failed', msg.slice(0, 300), false, liveId)
    }
  })()
  return { ok: true }
}

// ── Push staging to live ──────────────────────────────────────────────

export async function pushToLive(liveId: string, actor: { userId: string }, input: { database?: unknown } = {}) {
  const live = await loadProject(liveId)
  if (!live) throw new StagingError('Website not found.', 404)
  const m = stagingMode(live)
  if (m.mode === null) throw new StagingError(m.reason, 409)
  if (m.mode === 'git') {
    throw new StagingError('This site deploys from Git. Merge the staging branch into the live branch on your Git host — the live site deploys automatically.', 409)
  }
  if (live.status === 'suspended') throw new StagingError('The live website is suspended.', 402)
  const current = await findStaging(liveId)
  if (current && current.stagingStatus !== 'ready') {
    throw new StagingError(current.stagingStatus === 'failed' ? 'The last staging operation failed. Refresh staging from live, check it, then push.' : 'Staging is busy.', 409)
  }
  const staging = await lockStaging(liveId, 'pushing')
  const database = input.database === true

  void (async () => {
    const log = (msg: string) => void setState(staging.id, { stagingMessage: msg })
    try {
      const s = (await loadProject(staging.id))!
      log('Backing up the live site first…')
      const backup = await createBackup(liveId, { type: 'pre-deploy', note: 'Automatic backup before pushing staging live' })
      if (backup.status !== 'completed') throw new Error(`Could not back up the live site, so nothing was changed: ${backup.message}`)

      // Remember whether the live site is visible to search engines — the
      // staging database says "no", and copying that would hide the live site.
      let blogPublic: string | null = null
      if (m.mode === 'wordpress' && database && live.containerName && !isDemo(live)) {
        blogPublic = (await run(live, wpCliCommand(live.containerName, 'option get blog_public')).catch(() => '1')).trim() || '1'
      }

      await copyContent(s, live, m.mode, { database, replace: true, log })

      if (blogPublic !== null && live.containerName) {
        await run(live, wpCliCommand(live.containerName, `option update blog_public ${shellQuote(blogPublic === '0' ? '0' : '1')}`)).catch(() => {})
      }
      if (m.mode === 'files' && !isDemo(live)) {
        // Rebuild so code changes take effect (WordPress serves files directly).
        log('Rebuilding the live site…')
        const claim = await claimDeploySlot({ projectId: liveId, userId: live.userId, branch: live.sourceBranch || 'main', triggeredBy: 'staging', buildLog: 'Deploying changes pushed from staging…' })
        if (claim.ok) {
          const r = await deployProject({ projectId: liveId, deploymentId: claim.deploymentId })
          if (!r.ok) throw new Error(`Files were copied but the live rebuild failed: ${r.error || 'see the deployment log'}. Restore the automatic backup if the site is broken.`)
        }
      }
      await setState(staging.id, { stagingStatus: 'ready', stagingMessage: null, stagingPushedAt: new Date() })
      await notify(actor.userId, 'Staging is live', `Changes from staging were pushed to ${live.name}. A backup was taken first.`, true, liveId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      await setState(staging.id, { stagingStatus: 'failed', stagingMessage: `Push failed: ${msg}` })
      await notify(actor.userId, 'Push to live failed', `${msg.slice(0, 250)} A backup of the live site is in Backups.`, false, liveId)
    }
  })()
  return { ok: true }
}

// ── Delete ────────────────────────────────────────────────────────────

export async function deleteStaging(liveId: string) {
  const staging = await findStaging(liveId)
  if (!staging) throw new StagingError('This website has no staging site.', 404)
  if (staging.stagingStatus === 'pushing') throw new StagingError('Wait for the push to live to finish.', 409)
  const { purgeProject } = await import('@/lib/project-teardown')
  const { warnings } = await purgeProject(staging.id)
  return { ok: true, warnings }
}
