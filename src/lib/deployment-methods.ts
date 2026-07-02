/**
 * Deployment Methods Catalog
 * ==========================
 *
 * The single source of truth for the 8 deployment methods supported by the
 * Create Website Wizard. Used by:
 *
 *   - The wizard UI (`/components/hosting/create-website-wizard.tsx`) — to
 *     render the method picker cards and per-method config forms.
 *   - The hosting/create API route — to validate the user's payload.
 *   - The VPS deployer (`/lib/vps/deployer.ts`) — to know which Dockerfile
 *     template + build pipeline to use for each method.
 *
 * Each method declares:
 *   - `id`           : machine identifier (stored on Project.deploymentMethod)
 *   - `name`         : human label
 *   - `description`  : short marketing-style description
 *   - `icon`         : Lucide icon name (consumed by the UI's icon registry)
 *   - `category`     : "cms" | "framework" | "language" | "container" | "custom"
 *   - `stack`        : the matching Project.stack value (drives the deployer)
 *   - `runtime`      : the runtime that should be selected by default
 *   - `defaultPort`  : the port the container will listen on
 *   - `supportsGit`  : can deploy from a Git repo
 *   - `supportsZip`  : can deploy from a ZIP upload
 *   - `supportsManual`: can be created with just placeholder files
 *   - `needsDatabase`: auto-provisions a DB at deploy time
 *   - `detectable`   : whether the build detector can auto-pick this method
 *                      from project files (e.g. composer.json → laravel)
 *   - `fields`       : per-method extra config fields rendered in the wizard
 *
 * No backend code lives here — this is pure data so it can be imported from
 * both client and server components without pulling in `ssh2` / `db` etc.
 */

export type DeploymentMethodId =
  | 'wordpress'
  | 'laravel'
  | 'nodejs'
  | 'php'
  | 'static'
  | 'python'
  | 'docker'
  | 'custom'

export type MethodCategory =
  | 'cms'
  | 'framework'
  | 'language'
  | 'container'
  | 'custom'

export interface MethodField {
  id: string
  label: string
  type: 'text' | 'email' | 'password' | 'select' | 'number'
  placeholder?: string
  defaultValue?: string | number
  options?: { value: string; label: string }[]
  required?: boolean
  helpText?: string
  /** Field is sensitive (stored encrypted) — UI hides it by default. */
  secret?: boolean
  /** Only show this field when `deploymentSource` is one of these values. */
  showForSources?: Array<'git' | 'zip' | 'manual' | 'template'>
}

export interface DeploymentMethod {
  id: DeploymentMethodId
  name: string
  tagline: string
  description: string
  icon: string
  category: MethodCategory
  stack: string
  runtime: string
  defaultRuntimeVersion: string
  defaultPort: number
  supportsGit: boolean
  supportsZip: boolean
  supportsManual: boolean
  needsDatabase: boolean
  detectable: boolean
  defaultBuildCommand?: string
  defaultStartCommand?: string
  fields: MethodField[]
}

export const DEPLOYMENT_METHODS: DeploymentMethod[] = [
  {
    id: 'wordpress',
    name: 'WordPress',
    tagline: 'One-click managed WordPress',
    description:
      'Managed WordPress 6.x on PHP 8.2 with MariaDB. Automatic SSL, persistent storage, and secure admin credentials. Just enter your admin username, password, and email.',
    icon: 'Layout',
    category: 'cms',
    stack: 'wordpress',
    runtime: 'php',
    defaultRuntimeVersion: '8.2',
    defaultPort: 80,
    supportsGit: false,
    supportsZip: false,
    supportsManual: true,
    needsDatabase: true,
    detectable: true,
    fields: [
      {
        id: 'wpAdminUser',
        label: 'Admin Username',
        type: 'text',
        placeholder: 'admin',
        defaultValue: 'admin',
        required: true,
        helpText: 'The WordPress administrator login username.',
      },
      {
        id: 'wpAdminPassword',
        label: 'Admin Password',
        type: 'password',
        placeholder: 'Choose a strong password',
        required: true,
        secret: true,
        helpText: 'Used for the wp-admin login. Stored encrypted.',
      },
      {
        id: 'wpAdminEmail',
        label: 'Admin Email',
        type: 'email',
        placeholder: 'you@example.com',
        required: true,
        helpText: 'Receives WordPress notifications and password resets.',
      },
    ],
  },
  {
    id: 'laravel',
    name: 'Laravel',
    tagline: 'PHP framework with artisan + composer',
    description:
      'Laravel 10/11 on PHP 8.2 with Nginx + PHP-FPM. Auto-clones your repo, runs composer install, generates APP_KEY, runs migrations, caches config, and serves via PHP-FPM.',
    icon: 'Triangle',
    category: 'framework',
    stack: 'php',
    runtime: 'php',
    defaultRuntimeVersion: '8.2',
    defaultPort: 80,
    supportsGit: true,
    supportsZip: true,
    supportsManual: false,
    needsDatabase: true,
    detectable: true,
    defaultBuildCommand: 'composer install --no-dev --optimize-autoloader',
    defaultStartCommand: 'php artisan serve --host=0.0.0.0 --port=80',
    fields: [
      {
        id: 'runtimeVersion',
        label: 'PHP Version',
        type: 'select',
        defaultValue: '8.2',
        options: [
          { value: '8.3', label: 'PHP 8.3' },
          { value: '8.2', label: 'PHP 8.2' },
          { value: '8.1', label: 'PHP 8.1' },
          { value: '8.0', label: 'PHP 8.0' },
        ],
      },
      {
        id: 'buildCommand',
        label: 'Build Command',
        type: 'text',
        placeholder: 'composer install --no-dev --optimize-autoloader',
        defaultValue: 'composer install --no-dev --optimize-autoloader',
        helpText: 'Run after cloning. Defaults to composer install.',
        showForSources: ['git', 'zip'],
      },
      {
        id: 'startCommand',
        label: 'Start Command',
        type: 'text',
        placeholder: 'php artisan migrate --force && php artisan serve',
        defaultValue:
          'php artisan migrate --force && php artisan config:cache && php-fpm',
        helpText: 'Runs migrations, caches config, then starts PHP-FPM.',
      },
    ],
  },
  {
    id: 'nodejs',
    name: 'Node.js',
    tagline: 'Express, Next.js, NestJS, Nuxt & more',
    description:
      'Node.js apps with a package.json. Auto-detects Express/Next.js/NestJS/Nuxt, installs deps (npm/pnpm/yarn), builds, and starts. Optimized for production.',
    icon: 'Hexagon',
    category: 'framework',
    stack: 'nodejs',
    runtime: 'nodejs',
    defaultRuntimeVersion: '20',
    defaultPort: 3000,
    supportsGit: true,
    supportsZip: true,
    supportsManual: true,
    needsDatabase: false,
    detectable: true,
    defaultBuildCommand: 'npm run build',
    defaultStartCommand: 'npm start',
    fields: [
      {
        id: 'framework',
        label: 'Framework',
        type: 'select',
        defaultValue: 'express',
        options: [
          { value: 'express', label: 'Express' },
          { value: 'nextjs', label: 'Next.js' },
          { value: 'nestjs', label: 'NestJS' },
          { value: 'nuxt', label: 'Nuxt' },
          { value: 'fastify', label: 'Fastify' },
          { value: 'koa', label: 'Koa' },
          { value: 'generic', label: 'Generic Node' },
        ],
        helpText: 'Used to fine-tune the build/start commands.',
      },
      {
        id: 'runtimeVersion',
        label: 'Node Version',
        type: 'select',
        defaultValue: '20',
        options: [
          { value: '22', label: 'Node 22' },
          { value: '20', label: 'Node 20 (LTS)' },
          { value: '18', label: 'Node 18 (LTS)' },
          { value: '16', label: 'Node 16' },
        ],
      },
      {
        id: 'packageManager',
        label: 'Package Manager',
        type: 'select',
        defaultValue: 'npm',
        options: [
          { value: 'npm', label: 'npm' },
          { value: 'pnpm', label: 'pnpm' },
          { value: 'yarn', label: 'yarn' },
          { value: 'bun', label: 'bun' },
        ],
        helpText: 'Auto-detected from lockfile; override here if needed.',
      },
      {
        id: 'buildCommand',
        label: 'Build Command',
        type: 'text',
        placeholder: 'npm run build',
        defaultValue: 'npm run build',
        helpText: 'Leave empty to skip the build step.',
        showForSources: ['git', 'zip'],
      },
      {
        id: 'startCommand',
        label: 'Start Command',
        type: 'text',
        placeholder: 'npm start',
        defaultValue: 'npm start',
        required: true,
      },
    ],
  },
  {
    id: 'php',
    name: 'PHP',
    tagline: 'Plain PHP on Apache or Nginx + FPM',
    description:
      'Plain PHP projects on PHP 8.x with Apache. Choose your PHP version and deploy from Git or ZIP. Document root defaults to /var/www/html.',
    icon: 'FileCode',
    category: 'language',
    stack: 'php',
    runtime: 'php',
    defaultRuntimeVersion: '8.2',
    defaultPort: 80,
    supportsGit: true,
    supportsZip: true,
    supportsManual: true,
    needsDatabase: false,
    detectable: true,
    fields: [
      {
        id: 'runtimeVersion',
        label: 'PHP Version',
        type: 'select',
        defaultValue: '8.2',
        options: [
          { value: '8.3', label: 'PHP 8.3' },
          { value: '8.2', label: 'PHP 8.2' },
          { value: '8.1', label: 'PHP 8.1' },
          { value: '8.0', label: 'PHP 8.0' },
          { value: '7.4', label: 'PHP 7.4 (legacy)' },
        ],
      },
      {
        id: 'documentRoot',
        label: 'Document Root',
        type: 'text',
        placeholder: '/var/www/html',
        defaultValue: '/var/www/html',
        helpText: 'Where Apache serves files from. Usually /var/www/html or /public.',
      },
    ],
  },
  {
    id: 'static',
    name: 'Static Website',
    tagline: 'HTML, React, Vue, Angular, Astro builds',
    description:
      'Static sites served by Nginx. Drop in HTML/CSS/JS, or deploy a built React/Vue/Angular/Astro/Svelte bundle. Build step runs if a build command is set.',
    icon: 'Layout',
    category: 'framework',
    stack: 'static',
    runtime: 'static',
    defaultRuntimeVersion: '1',
    defaultPort: 80,
    supportsGit: true,
    supportsZip: true,
    supportsManual: true,
    needsDatabase: false,
    detectable: true,
    defaultBuildCommand: 'npm run build',
    fields: [
      {
        id: 'framework',
        label: 'Static Type',
        type: 'select',
        defaultValue: 'html',
        options: [
          { value: 'html', label: 'Plain HTML/CSS/JS' },
          { value: 'react', label: 'React (Vite/CRA build)' },
          { value: 'vue', label: 'Vue (Vite build)' },
          { value: 'angular', label: 'Angular build' },
          { value: 'astro', label: 'Astro' },
          { value: 'svelte', label: 'Svelte / SvelteKit' },
          { value: 'gatsby', label: 'Gatsby' },
        ],
      },
      {
        id: 'documentRoot',
        label: 'Output Directory',
        type: 'text',
        placeholder: 'dist',
        defaultValue: 'dist',
        helpText:
          'After the build, the directory that Nginx serves (dist, build, out, public).',
      },
      {
        id: 'buildCommand',
        label: 'Build Command',
        type: 'text',
        placeholder: 'npm run build',
        defaultValue: 'npm run build',
        helpText: 'Leave empty for plain HTML (no build step).',
        showForSources: ['git', 'zip'],
      },
    ],
  },
  {
    id: 'python',
    name: 'Python',
    tagline: 'Django, Flask, FastAPI on gunicorn/uvicorn',
    description:
      'Python 3.11 WSGI/ASGI apps. Auto-installs requirements.txt and serves Django/Flask via gunicorn, FastAPI via uvicorn. Production-grade.',
    icon: 'Terminal',
    category: 'language',
    stack: 'python',
    runtime: 'python',
    defaultRuntimeVersion: '3.11',
    defaultPort: 8000,
    supportsGit: true,
    supportsZip: true,
    supportsManual: true,
    needsDatabase: false,
    detectable: true,
    fields: [
      {
        id: 'framework',
        label: 'Framework',
        type: 'select',
        defaultValue: 'flask',
        options: [
          { value: 'flask', label: 'Flask (gunicorn)' },
          { value: 'django', label: 'Django (gunicorn)' },
          { value: 'fastapi', label: 'FastAPI (uvicorn)' },
          { value: 'generic', label: 'Generic WSGI/ASGI' },
        ],
      },
      {
        id: 'runtimeVersion',
        label: 'Python Version',
        type: 'select',
        defaultValue: '3.11',
        options: [
          { value: '3.12', label: 'Python 3.12' },
          { value: '3.11', label: 'Python 3.11' },
          { value: '3.10', label: 'Python 3.10' },
          { value: '3.9', label: 'Python 3.9' },
        ],
      },
      {
        id: 'startCommand',
        label: 'Start Command',
        type: 'text',
        placeholder: 'gunicorn app:app --bind 0.0.0.0:8000',
        helpText:
          'Defaults to gunicorn for Flask/Django, uvicorn for FastAPI.',
      },
    ],
  },
  {
    id: 'docker',
    name: 'Docker Project',
    tagline: 'Bring your own Dockerfile or compose file',
    description:
      'Deploy from a repository containing a Dockerfile or docker-compose.yml. The panel builds the image as-is and runs it — full control, zero magic.',
    icon: 'Container',
    category: 'container',
    stack: 'docker',
    runtime: 'docker',
    defaultRuntimeVersion: '1',
    defaultPort: 8080,
    supportsGit: true,
    supportsZip: true,
    supportsManual: false,
    needsDatabase: false,
    detectable: true,
    fields: [
      {
        id: 'appPort',
        label: 'Exposed Port',
        type: 'number',
        placeholder: '8080',
        defaultValue: 8080,
        helpText: 'The port your Dockerfile EXPOSEs. Caddy proxies to it.',
      },
      {
        id: 'useCompose',
        label: 'Use docker-compose.yml',
        type: 'select',
        defaultValue: 'auto',
        options: [
          { value: 'auto', label: 'Auto-detect (prefer compose)' },
          { value: 'compose', label: 'Force docker-compose.yml' },
          { value: 'dockerfile', label: 'Force Dockerfile only' },
        ],
        helpText:
          'When a docker-compose.yml is present, the panel runs `docker compose up -d --build` instead of `docker build`.',
      },
    ],
  },
  {
    id: 'custom',
    name: 'Custom Application',
    tagline: 'Bring your own runtime + commands',
    description:
      'Total control: pick the runtime (Node, PHP, Python, Ruby, Go, Java, static, Bun), set your own build/start commands, port, and env vars. The panel wires it into Docker + Caddy for you.',
    icon: 'Settings',
    category: 'custom',
    stack: 'docker',
    runtime: 'nodejs',
    defaultRuntimeVersion: '20',
    defaultPort: 3000,
    supportsGit: true,
    supportsZip: true,
    supportsManual: true,
    needsDatabase: false,
    detectable: false,
    fields: [
      {
        id: 'runtime',
        label: 'Runtime',
        type: 'select',
        defaultValue: 'nodejs',
        options: [
          { value: 'nodejs', label: 'Node.js' },
          { value: 'bun', label: 'Bun' },
          { value: 'php', label: 'PHP' },
          { value: 'python', label: 'Python' },
          { value: 'ruby', label: 'Ruby' },
          { value: 'go', label: 'Go' },
          { value: 'java', label: 'Java' },
          { value: 'static', label: 'Static (Nginx)' },
          { value: 'docker', label: 'Docker (custom Dockerfile)' },
        ],
        required: true,
      },
      {
        id: 'runtimeVersion',
        label: 'Runtime Version',
        type: 'text',
        placeholder: '20',
        defaultValue: '20',
      },
      {
        id: 'buildCommand',
        label: 'Build Command',
        type: 'text',
        placeholder: 'npm run build',
        helpText: 'Optional. Runs after source is fetched.',
        showForSources: ['git', 'zip'],
      },
      {
        id: 'startCommand',
        label: 'Start Command',
        type: 'text',
        placeholder: 'npm start',
        required: true,
      },
      {
        id: 'appPort',
        label: 'App Port',
        type: 'number',
        placeholder: '3000',
        defaultValue: 3000,
        required: true,
        helpText: 'The port your app listens on inside the container.',
      },
    ],
  },
]

/** Get a method by id. Returns null if unknown. */
export function getDeploymentMethod(
  id: string
): DeploymentMethod | null {
  return DEPLOYMENT_METHODS.find((m) => m.id === id) || null
}

/** Group methods by category for the wizard UI. */
export function getMethodsByCategory(): Record<
  MethodCategory,
  DeploymentMethod[]
> {
  const out: Record<MethodCategory, DeploymentMethod[]> = {
    cms: [],
    framework: [],
    language: [],
    container: [],
    custom: [],
  }
  for (const m of DEPLOYMENT_METHODS) {
    out[m.category].push(m)
  }
  return out
}
