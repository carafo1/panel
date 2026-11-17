/**
 * App tools for non-WordPress websites
 * ====================================
 *
 * The everyday maintenance commands of each stack — Laravel's artisan,
 * Django's manage.py, package listings, the application log — as buttons,
 * run inside the site's container with `docker exec`. Only the commands in
 * the catalogue below can run: the customer picks an id, never a command.
 * Anything else is what the Terminal tab is for.
 *
 * DEMO MODE (development only) reports what would run.
 */
import { db } from '@/lib/db'
import { withConnection, exec, isServerInDemoMode, shellQuote } from './ssh'
import { getServerCredentials } from './provisioner'
import { SiteToolError } from './wordpress'
import type { ProjectPermission } from '@/lib/project-access'

export type AppStack = 'laravel' | 'django' | 'python' | 'nodejs' | 'php'

export interface AppTool {
  id: string
  label: string
  description: string
  command: string
  permission: ProjectPermission
  /** Shown with a confirmation in the UI. */
  confirm?: string
}

const T = (
  id: string,
  label: string,
  description: string,
  command: string,
  permission: ProjectPermission = 'configure',
  confirm?: string
): AppTool => ({ id, label, description, command, permission, confirm })

const CATALOGUE: Record<AppStack, AppTool[]> = {
  laravel: [
    T('migrate', 'Run migrations', 'Apply pending database migrations (php artisan migrate --force).', 'php artisan migrate --force', 'data', 'Run pending database migrations on the live database?'),
    T('optimize_clear', 'Clear all caches', 'Clear config, route, view and application caches.', 'php artisan optimize:clear'),
    T('optimize', 'Cache config & routes', 'Rebuild the config and route caches for speed.', 'php artisan optimize'),
    T('storage_link', 'Link storage', 'Create the public/storage symlink for uploaded files.', 'php artisan storage:link'),
    T('queue_restart', 'Restart queue workers', 'Ask queue workers to restart after their current job.', 'php artisan queue:restart'),
    T('down', 'Maintenance mode on', 'Show visitors a maintenance page.', 'php artisan down', 'configure', 'Put the site into maintenance mode? Visitors will see a 503 page.'),
    T('up', 'Maintenance mode off', 'Bring the site back from maintenance mode.', 'php artisan up'),
    T('about', 'Environment info', 'Laravel, PHP and driver versions (php artisan about).', 'php artisan about', 'view'),
  ],
  django: [
    T('migrate', 'Run migrations', 'Apply pending database migrations (manage.py migrate).', 'python manage.py migrate --noinput', 'data', 'Run pending database migrations on the live database?'),
    T('collectstatic', 'Collect static files', 'Gather static files for serving (manage.py collectstatic).', 'python manage.py collectstatic --noinput'),
    T('check', 'System check', 'Run Django’s deployment checks (manage.py check --deploy).', 'python manage.py check --deploy', 'view'),
    T('packages', 'Installed packages', 'List installed Python packages (pip freeze).', 'pip freeze', 'view'),
  ],
  python: [
    T('packages', 'Installed packages', 'List installed Python packages (pip freeze).', 'pip freeze', 'view'),
    T('version', 'Python version', 'Show the Python version in use.', 'python --version', 'view'),
  ],
  nodejs: [
    T('packages', 'Installed packages', 'Top-level npm dependencies (npm ls --depth=0).', 'npm ls --depth=0 --omit=dev 2>/dev/null || npm ls --depth=0', 'view'),
    T('version', 'Node.js version', 'Show the Node.js and npm versions in use.', 'node -v && npm -v', 'view'),
    T('audit', 'Security audit', 'Check dependencies for known vulnerabilities (npm audit).', 'npm audit --omit=dev || true', 'view'),
  ],
  php: [
    T('version', 'PHP version', 'Show the PHP version in use.', 'php -v', 'view'),
    T('modules', 'PHP extensions', 'List loaded PHP extensions (php -m).', 'php -m', 'view'),
    T('settings', 'Key PHP settings', 'memory_limit, upload size, execution time.', `php -r ${shellQuote("foreach (['memory_limit','upload_max_filesize','post_max_size','max_execution_time','display_errors'] as $k) echo $k, ' = ', ini_get($k), PHP_EOL;")}`, 'view'),
    T('composer_install', 'Install Composer packages', 'composer install --no-dev --optimize-autoloader (when the site uses Composer).', 'test -f composer.json && composer install --no-dev --optimize-autoloader --no-interaction || echo "No composer.json in this site."'),
  ],
}

/** Application log to tail, per stack (relative to the container's workdir). */
const LOG_COMMAND: Partial<Record<AppStack, string>> = {
  laravel: 'tail -n 300 storage/logs/laravel.log 2>/dev/null || echo "No Laravel log yet (storage/logs/laravel.log)."',
}

export function detectAppStack(p: { deploymentMethod: string | null; stack: string | null; framework: string | null }): AppStack | null {
  const m = p.deploymentMethod || ''
  if (m === 'laravel' || p.framework === 'laravel') return 'laravel'
  if (p.framework === 'django') return 'django'
  if (m === 'python' || p.stack === 'python' || ['flask', 'fastapi'].includes(p.framework || '')) return 'python'
  if (m === 'nodejs' || p.stack === 'nodejs') return 'nodejs'
  if (m === 'php' || p.stack === 'php') return 'php'
  return null
}

async function loadSite(projectId: string) {
  const project = await db.project.findUnique({ where: { id: projectId }, include: { server: true } })
  if (!project) throw new SiteToolError('Website not found', 404)
  const stack = detectAppStack(project)
  if (!stack) throw new SiteToolError('App tools are not available for this kind of website.', 409)
  if (project.status === 'suspended') {
    throw new SiteToolError('This website is suspended. Pay the outstanding invoice from Billing to restore it.', 402)
  }
  const demo = !project.serverId || !project.server || isServerInDemoMode(project.server)
  if (!demo && !project.containerName) throw new SiteToolError('This website has no running container yet.', 409)
  return { project, stack, demo }
}

export async function listAppTools(projectId: string) {
  const { stack, demo } = await loadSite(projectId)
  return {
    stack,
    demo,
    hasLog: !!LOG_COMMAND[stack],
    tools: CATALOGUE[stack].map(({ id, label, description, permission, confirm }) => ({ id, label, description, permission, confirm })),
  }
}

/** The permission a tool needs, or null for an unknown tool id. */
export async function appToolPermission(projectId: string, toolId: string): Promise<ProjectPermission | null> {
  const project = await db.project.findUnique({ where: { id: projectId }, select: { deploymentMethod: true, stack: true, framework: true } })
  const stack = project && detectAppStack(project)
  if (!stack) return null
  if (toolId === '__log') return LOG_COMMAND[stack] ? 'view' : null
  return CATALOGUE[stack].find((t) => t.id === toolId)?.permission ?? null
}

export async function runAppTool(projectId: string, toolId: string): Promise<{ demo: boolean; output: string; exitCode: number; label: string }> {
  const { project, stack, demo } = await loadSite(projectId)
  const tool = toolId === '__log' ? (LOG_COMMAND[stack] ? T('__log', 'Application log', '', LOG_COMMAND[stack]!, 'view') : undefined) : CATALOGUE[stack].find((t) => t.id === toolId)
  if (!tool) throw new SiteToolError('Unknown tool.')

  if (demo) {
    return { demo: true, label: tool.label, exitCode: 0, output: `[demo] would run in the site container:\n$ ${tool.command}` }
  }

  const cmd = `docker exec ${shellQuote(project.containerName!)} sh -c ${shellQuote(tool.command)}`
  try {
    const creds = await getServerCredentials(project.serverId!)
    const r = await withConnection(creds, (client) => exec(client, `${cmd} 2>&1`, { timeoutMs: 300_000 }))
    return { demo: false, label: tool.label, exitCode: r.exitCode ?? 1, output: `${r.stdout}${r.stderr}`.trim().slice(-8000) }
  } catch (err) {
    console.error('[app-tools] could not reach the server:', (err as Error).message)
    throw new SiteToolError('The server could not be reached. Please try again.', 502)
  }
}
