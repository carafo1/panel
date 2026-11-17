/**
 * WordPress management for WordPress websites
 * ===========================================
 *
 * Runs WP-CLI against the site's files exactly the way the installer does
 * (deployer.ts): a throwaway `wordpress:cli` container on the `deployhub`
 * network with the site mounted at /var/www/html, as uid 33 (www-data — the
 * user the apache image serves as, so files WP-CLI writes stay writable by
 * WordPress itself).
 *
 * Only a fixed set of actions exists, every name the customer supplies is
 * validated against a strict pattern and shell-quoted, and secrets are
 * scrubbed from anything returned. Arbitrary commands belong to the Terminal
 * tab, not here.
 *
 * In DEMO MODE (development only — production refuses to simulate servers)
 * the site is an in-memory model so the UI can be exercised end to end.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import { encrypt } from '@/lib/encryption'
import { withConnection, exec, isServerInDemoMode, shellQuote } from './ssh'
import { getServerCredentials } from './provisioner'
import type { ProjectPermission } from '@/lib/project-access'

/** A refusal the customer can act on (bad input, not a WordPress site, …). */
export class SiteToolError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 402 | 404 | 409 | 422 | 502 = 400
  ) {
    super(message)
    this.name = 'SiteToolError'
  }
}

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WpExtension {
  name: string
  title: string
  status: string // active | inactive | must-use | dropin | parent
  version: string
  update: string // available | none
  update_version: string
}

export interface WpOverview {
  demo: boolean
  coreVersion: string | null
  coreUpdate: string | null
  siteUrl: string | null
  adminUrl: string | null
  maintenance: boolean
  debug: boolean
  plugins: WpExtension[]
  themes: WpExtension[]
  admins: Array<{ user_login: string; user_email: string }>
  /** Set when WordPress didn't answer (e.g. database unreachable). */
  problem: string | null
}

export const WP_ACTIONS = [
  'plugin_activate',
  'plugin_deactivate',
  'plugin_update',
  'plugin_delete',
  'plugin_install',
  'plugins_update_all',
  'theme_activate',
  'theme_update',
  'theme_delete',
  'theme_install',
  'core_update',
  'maintenance_on',
  'maintenance_off',
  'debug_on',
  'debug_off',
  'cache_flush',
  'rewrite_flush',
  'search_replace',
  'reset_admin_password',
] as const
export type WpAction = (typeof WP_ACTIONS)[number]

export interface WpActionInput {
  action: WpAction
  slug?: string
  activate?: boolean
  from?: string
  to?: string
  dryRun?: boolean
  user?: string
}

export interface WpActionResult {
  ok: true
  demo: boolean
  message: string
  output?: string
  /** reset_admin_password only — shown to the customer once. */
  password?: string
  /** search_replace only. */
  replacements?: number
}

/** Who may do what (lib/project-access permission ladder). */
export function wpActionPermission(action: WpAction): ProjectPermission {
  if (action === 'reset_admin_password') return 'owner'
  if (action === 'search_replace') return 'data'
  return 'configure'
}

// ─── Validation ────────────────────────────────────────────────────────────

const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/
const LOGIN = /^[A-Za-z0-9._@-]{1,60}$/

function needSlug(slug: string | undefined, what: 'plugin' | 'theme'): string {
  const s = (slug || '').trim().toLowerCase()
  if (!SLUG.test(s)) {
    throw new SiteToolError(`Enter a ${what} slug — lowercase letters, numbers and dashes, e.g. ${what === 'plugin' ? 'woocommerce' : 'twentytwentyfour'}.`)
  }
  return s
}

function needText(value: string | undefined, label: string): string {
  const v = (value ?? '').trim()
  if (!v) throw new SiteToolError(`${label} is required.`)
  if (v.length > 500) throw new SiteToolError(`${label} is too long (500 characters max).`)
  if (/[\r\n\0]/.test(v)) throw new SiteToolError(`${label} must be a single line.`)
  return v
}

// ─── Project lookup ────────────────────────────────────────────────────────

async function loadSite(projectId: string) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new SiteToolError('Website not found', 404)
  const isWp =
    project.deploymentMethod === 'wordpress' || project.stack === 'wordpress' || project.framework === 'wordpress'
  if (!isWp) throw new SiteToolError('This website is not a WordPress site.', 409)
  if (project.status === 'suspended') {
    throw new SiteToolError('This website is suspended. Pay the outstanding invoice from Billing to restore it.', 402)
  }
  const demo = !project.serverId || !project.server || isServerInDemoMode(project.server)
  if (!demo && !project.deployPath) {
    throw new SiteToolError('This website has not been deployed yet.', 409)
  }
  return { project, demo }
}

type Site = Awaited<ReturnType<typeof loadSite>>['project']

/** Run a WP-CLI shell script against the site. Throws SiteToolError on failure. */
async function runWp(site: Site, script: string, timeoutMs = 120_000, secrets: string[] = []) {
  const cmd =
    `docker run --rm --network deployhub --user 33:33 ` +
    `-v ${shellQuote(site.deployPath!)}:/var/www/html -w /var/www/html ` +
    `wordpress:cli sh -c ${shellQuote(script)}`
  let result: { stdout: string; stderr: string; exitCode: number | null }
  try {
    const creds = await getServerCredentials(site.serverId!)
    result = await withConnection(creds, (client) => exec(client, `${cmd} 2>&1`, { timeoutMs }))
  } catch (err) {
    console.error('[wordpress] could not reach the server:', (err as Error).message)
    throw new SiteToolError('The server could not be reached. Please try again.', 502)
  }
  let out = `${result.stdout}${result.stderr}`
  for (const s of secrets) if (s) out = out.split(s).join('***')
  return { output: out.trim(), exitCode: result.exitCode }
}

/** The last meaningful line of WP-CLI output, for an error message. */
function lastLine(out: string): string {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean)
  const err = [...lines].reverse().find((l) => /^(Error|Warning):/i.test(l))
  return (err || lines[lines.length - 1] || 'WordPress reported an error').slice(0, 300)
}

function parseJsonArray<T>(text: string): T[] {
  const start = text.indexOf('[')
  if (start === -1) return []
  try {
    const v = JSON.parse(text.slice(start))
    return Array.isArray(v) ? (v as T[]) : []
  } catch {
    return []
  }
}

// ─── Demo-mode model (development only) ────────────────────────────────────

interface DemoWp {
  coreVersion: string
  maintenance: boolean
  debug: boolean
  plugins: WpExtension[]
  themes: WpExtension[]
}
const demoSites = new Map<string, DemoWp>()

function demoState(projectId: string): DemoWp {
  let s = demoSites.get(projectId)
  if (!s) {
    const ext = (name: string, title: string, status: string, version: string, upd?: string): WpExtension => ({
      name,
      title,
      status,
      version,
      update: upd ? 'available' : 'none',
      update_version: upd || '',
    })
    s = {
      coreVersion: '6.6.2',
      maintenance: false,
      debug: false,
      plugins: [
        ext('akismet', 'Akismet Anti-spam', 'active', '5.3.3', '5.3.5'),
        ext('contact-form-7', 'Contact Form 7', 'active', '5.9.8'),
        ext('hello-dolly', 'Hello Dolly', 'inactive', '1.7.2'),
      ],
      themes: [
        ext('twentytwentyfour', 'Twenty Twenty-Four', 'active', '1.2'),
        ext('twentytwentythree', 'Twenty Twenty-Three', 'inactive', '1.4', '1.5'),
      ],
    }
    demoSites.set(projectId, s)
  }
  return s
}

// ─── Overview ──────────────────────────────────────────────────────────────

export async function getWordPressOverview(projectId: string): Promise<WpOverview> {
  const { project, demo } = await loadSite(projectId)
  const host = project.customDomain || project.subdomain

  if (demo) {
    const s = demoState(projectId)
    return {
      demo: true,
      coreVersion: s.coreVersion,
      coreUpdate: s.coreVersion === '6.7.1' ? null : '6.7.1',
      siteUrl: `https://${host}`,
      adminUrl: `https://${host}/wp-admin/`,
      maintenance: s.maintenance,
      debug: s.debug,
      plugins: s.plugins,
      themes: s.themes,
      admins: [{ user_login: project.wpAdminUser || 'admin', user_email: project.wpAdminEmail || 'admin@example.com' }],
      problem: null,
    }
  }

  // One container run for everything: sections are separated by @@markers.
  const script = [
    "echo '@@core'; wp core version 2>/dev/null",
    "echo '@@update'; wp core check-update --format=json 2>/dev/null",
    "echo '@@siteurl'; wp option get siteurl 2>/dev/null",
    "echo '@@maint'; if wp maintenance-mode is-active >/dev/null 2>&1; then echo on; else echo off; fi",
    "echo '@@debug'; wp config get WP_DEBUG --type=constant 2>/dev/null",
    "echo '@@plugins'; wp plugin list --fields=name,title,status,version,update,update_version --format=json 2>/dev/null",
    "echo '@@themes'; wp theme list --fields=name,title,status,version,update,update_version --format=json 2>/dev/null",
    "echo '@@admins'; wp user list --role=administrator --fields=user_login,user_email --format=json 2>/dev/null",
  ].join('\n')
  const { output } = await runWp(project, script, 90_000)

  const sections: Record<string, string> = {}
  let current = ''
  for (const line of output.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim())
    if (m) {
      current = m[1]
      sections[current] = ''
    } else if (current) {
      sections[current] += line + '\n'
    }
  }
  const updates = parseJsonArray<{ version: string }>(sections.update || '')
  const siteUrl = (sections.siteurl || '').trim() || `https://${host}`
  const plugins = parseJsonArray<WpExtension>(sections.plugins || '')
  const coreVersion = (sections.core || '').trim() || null

  return {
    demo: false,
    coreVersion,
    coreUpdate: updates[0]?.version || null,
    siteUrl,
    adminUrl: `${siteUrl.replace(/\/+$/, '')}/wp-admin/`,
    maintenance: (sections.maint || '').trim() === 'on',
    debug: /^(1|true)$/i.test((sections.debug || '').trim()),
    plugins,
    themes: parseJsonArray<WpExtension>(sections.themes || ''),
    admins: parseJsonArray<{ user_login: string; user_email: string }>(sections.admins || ''),
    problem: !coreVersion
      ? 'WordPress files were not found in this website.'
      : !(sections.plugins || '').includes('[')
        ? 'WordPress did not respond — its database may be unreachable. Check the Databases and Container tabs.'
        : null,
  }
}

// ─── Actions ───────────────────────────────────────────────────────────────

export async function runWordPressAction(projectId: string, input: WpActionInput): Promise<WpActionResult> {
  if (!WP_ACTIONS.includes(input.action)) throw new SiteToolError('Unknown action.')
  const { project, demo } = await loadSite(projectId)
  const a = input.action

  // Build the command (validates input) — also used to describe demo runs.
  let script = ''
  let message = ''
  let password: string | undefined
  let secrets: string[] = []
  switch (a) {
    case 'plugin_activate':
    case 'plugin_deactivate':
    case 'plugin_update': {
      const s = needSlug(input.slug, 'plugin')
      const op = a.split('_')[1]
      script = `wp plugin ${op} ${shellQuote(s)}`
      message = `Plugin ${s} ${op === 'update' ? 'updated' : op + 'd'}.`
      break
    }
    case 'plugin_delete': {
      const s = needSlug(input.slug, 'plugin')
      script = `wp plugin deactivate ${shellQuote(s)} >/dev/null 2>&1; wp plugin delete ${shellQuote(s)}`
      message = `Plugin ${s} deleted.`
      break
    }
    case 'plugin_install': {
      const s = needSlug(input.slug, 'plugin')
      script = `wp plugin install ${shellQuote(s)}${input.activate ? ' --activate' : ''}`
      message = `Plugin ${s} installed${input.activate ? ' and activated' : ''}.`
      break
    }
    case 'plugins_update_all':
      script = 'wp plugin update --all'
      message = 'All plugins updated.'
      break
    case 'theme_activate':
    case 'theme_update': {
      const s = needSlug(input.slug, 'theme')
      const op = a.split('_')[1]
      script = `wp theme ${op} ${shellQuote(s)}`
      message = `Theme ${s} ${op === 'update' ? 'updated' : 'activated'}.`
      break
    }
    case 'theme_delete': {
      const s = needSlug(input.slug, 'theme')
      script = `wp theme delete ${shellQuote(s)}`
      message = `Theme ${s} deleted.`
      break
    }
    case 'theme_install': {
      const s = needSlug(input.slug, 'theme')
      script = `wp theme install ${shellQuote(s)}${input.activate ? ' --activate' : ''}`
      message = `Theme ${s} installed${input.activate ? ' and activated' : ''}.`
      break
    }
    case 'core_update':
      script = 'wp core update && wp core update-db'
      message = 'WordPress updated.'
      break
    case 'maintenance_on':
    case 'maintenance_off':
      script = `wp maintenance-mode ${a === 'maintenance_on' ? 'activate' : 'deactivate'}`
      message = a === 'maintenance_on' ? 'Maintenance mode is on — visitors see a "briefly unavailable" page.' : 'Maintenance mode is off.'
      break
    case 'debug_on':
    case 'debug_off':
      script = `wp config set WP_DEBUG ${a === 'debug_on' ? 'true' : 'false'} --raw --type=constant`
      message = a === 'debug_on' ? 'Debug mode is on. Turn it off again when you are done — it can show errors to visitors.' : 'Debug mode is off.'
      break
    case 'cache_flush':
      script = 'wp cache flush && wp transient delete --expired'
      message = 'Cache cleared.'
      break
    case 'rewrite_flush':
      script = 'wp rewrite flush --hard'
      message = 'Permalinks regenerated.'
      break
    case 'search_replace': {
      const from = needText(input.from, 'Text to find')
      const to = needText(input.to, 'Replacement')
      if (from === to) throw new SiteToolError('The text to find and its replacement are the same.')
      script =
        `wp search-replace ${shellQuote(from)} ${shellQuote(to)} --all-tables-with-prefix --skip-columns=guid ` +
        `--format=count${input.dryRun ? ' --dry-run' : ''}`
      message = input.dryRun ? 'Preview only — nothing was changed.' : 'Replaced.'
      break
    }
    case 'reset_admin_password': {
      const login = (input.user || project.wpAdminUser || 'admin').trim()
      if (!LOGIN.test(login)) throw new SiteToolError('Invalid WordPress username.')
      password = crypto.randomBytes(18).toString('base64url')
      secrets = [password]
      script = `wp user update ${shellQuote(login)} --user_pass=${shellQuote(password)} --skip-email`
      message = `New password set for ${login}. Copy it now — it is not shown again.`
      break
    }
  }

  if (demo) {
    const r = applyDemo(projectId, input)
    if (a === 'reset_admin_password') {
      await db.project.update({ where: { id: projectId }, data: { wpAdminPassword: encrypt(password!) } })
    }
    return { ok: true, demo: true, message: `${message} (demo)`, output: `[demo] wp: ${script.replace(password || '\0', '***')}`, password, ...r }
  }

  const { output, exitCode } = await runWp(project, script, a === 'core_update' || a === 'plugins_update_all' ? 300_000 : 120_000, secrets)
  if (exitCode !== 0) throw new SiteToolError(`WordPress said: ${lastLine(output)}`, 422)

  if (a === 'reset_admin_password') {
    await db.project.update({ where: { id: projectId }, data: { wpAdminPassword: encrypt(password!) } })
  }
  let replacements: number | undefined
  if (a === 'search_replace') {
    replacements = Number(output.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l)).pop() ?? 0)
    message = input.dryRun ? `${replacements} change(s) would be made. Nothing was changed yet.` : `${replacements} change(s) made.`
  }
  return { ok: true, demo: false, message, output: output.slice(-4000), password, replacements }
}

function applyDemo(projectId: string, input: WpActionInput): { replacements?: number } {
  const s = demoState(projectId)
  const list = input.action.startsWith('theme') ? s.themes : s.plugins
  const find = () => list.find((x) => x.name === input.slug)
  const missing = () => {
    throw new SiteToolError(`WordPress said: Error: The '${input.slug}' ${input.action.startsWith('theme') ? 'theme' : 'plugin'} could not be found.`, 422)
  }
  switch (input.action) {
    case 'plugin_activate':
      ;(find() || missing())!.status = 'active'
      break
    case 'plugin_deactivate':
      ;(find() || missing())!.status = 'inactive'
      break
    case 'plugin_update':
    case 'theme_update': {
      const x = find() || missing()!
      if (x.update === 'available') {
        x.version = x.update_version
        x.update = 'none'
        x.update_version = ''
      }
      break
    }
    case 'plugins_update_all':
      for (const x of s.plugins) if (x.update === 'available') Object.assign(x, { version: x.update_version, update: 'none', update_version: '' })
      break
    case 'plugin_delete':
    case 'theme_delete': {
      const x = find() || missing()!
      if (input.action === 'theme_delete' && x.status === 'active') {
        throw new SiteToolError("WordPress said: Error: Can't delete the currently active theme.", 422)
      }
      list.splice(list.indexOf(x), 1)
      break
    }
    case 'plugin_install':
    case 'theme_install':
      if (!find()) {
        list.push({
          name: input.slug!,
          title: input.slug!.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          status: 'inactive',
          version: '1.0.0',
          update: 'none',
          update_version: '',
        })
      }
      if (input.activate) {
        if (input.action === 'theme_install') for (const t of s.themes) t.status = 'inactive'
        find()!.status = 'active'
      }
      break
    case 'theme_activate':
      find() || missing()
      for (const t of s.themes) t.status = t.name === input.slug ? 'active' : 'inactive'
      break
    case 'core_update':
      s.coreVersion = '6.7.1'
      break
    case 'maintenance_on':
    case 'maintenance_off':
      s.maintenance = input.action === 'maintenance_on'
      break
    case 'debug_on':
    case 'debug_off':
      s.debug = input.action === 'debug_on'
      break
    case 'search_replace':
      return { replacements: 3 }
  }
  return {}
}
