/**
 * Build Detector
 * ==============
 *
 * Auto-detects the deployment method + framework for a project based on the
 * files present in its repository or uploaded ZIP. Pure-data — does not
 * touch the database, SSH, or the filesystem. Callers (the wizard UI's
 * "auto-detect" button, the `/api/hosting/upload` endpoint after extracting
 * a ZIP, or the deployer's pre-flight check) pass in either:
 *
 *   - a list of filenames present at the repo root, OR
 *   - the parsed `package.json` object, OR
 *   - the parsed `composer.json` object
 *
 * and get back a {@link DetectionResult} describing the most-likely method,
 * runtime, framework, build/start commands, and a confidence score in [0,1].
 *
 * The detection rules mirror the `DEPLOYMENT_METHODS` catalog in
 * `/lib/deployment-methods.ts` — e.g. `wp-config.php` → wordpress,
 * `composer.json` with `laravel/framework` → laravel, `package.json` with
 * `next` → nodejs/nextjs, etc.
 */
import type { DeploymentMethodId } from '@/lib/deployment-methods'

export interface DetectionResult {
  method: DeploymentMethodId
  framework: string
  runtime: string
  runtimeVersion?: string
  buildCommand?: string
  startCommand?: string
  appPort?: number
  documentRoot?: string
  /** 0..1 — how confident the detector is in this match. */
  confidence: number
  /** Human-readable reasons explaining why this method was picked. */
  reasons: string[]
}

// ─── Filename-based detection ──────────────────────────────────────────────

/**
 * Detect a deployment method from a list of filenames present at the project
 * root. Returns `null` when nothing matches confidently.
 *
 * Order matters: docker-compose wins over Dockerfile (compose is preferred
 * when both exist); wp-config.php wins over everything else.
 */
export function detectFromFilenames(filenames: string[]): DetectionResult | null {
  if (!filenames || filenames.length === 0) return null
  const lower = filenames.map((f) => f.toLowerCase())
  const has = (name: string) => lower.includes(name.toLowerCase())

  // WordPress — strongest signal.
  if (has('wp-config.php') || has('wp-login.php')) {
    return {
      method: 'wordpress',
      framework: 'wordpress',
      runtime: 'php',
      runtimeVersion: '8.2',
      appPort: 80,
      documentRoot: '/var/www/html',
      confidence: 0.99,
      reasons: ['Found wp-config.php or wp-login.php — WordPress signature.'],
    }
  }

  // Docker compose (preferred over Dockerfile).
  if (has('docker-compose.yml') || has('docker-compose.yaml')) {
    return {
      method: 'docker',
      framework: 'docker-compose',
      runtime: 'docker',
      appPort: 8080,
      confidence: 0.95,
      reasons: ['Found docker-compose.yml — using compose-based deployment.'],
    }
  }

  // Dockerfile alone.
  if (has('dockerfile')) {
    return {
      method: 'docker',
      framework: 'dockerfile',
      runtime: 'docker',
      appPort: 8080,
      confidence: 0.9,
      reasons: ['Found Dockerfile — building the project image as-is.'],
    }
  }

  // Go.
  if (has('go.mod')) {
    return {
      method: 'custom',
      framework: 'go',
      runtime: 'go',
      runtimeVersion: '1.22',
      buildCommand: 'go build -o server ./...',
      startCommand: './server',
      appPort: 8080,
      confidence: 0.7,
      reasons: ['Found go.mod — Go project.'],
    }
  }

  // Java / Maven.
  if (has('pom.xml')) {
    return {
      method: 'custom',
      framework: 'maven',
      runtime: 'java',
      runtimeVersion: '17',
      buildCommand: 'mvn package -DskipTests',
      startCommand: 'java -jar target/app.jar',
      appPort: 8080,
      confidence: 0.7,
      reasons: ['Found pom.xml — Java/Maven project.'],
    }
  }

  // Ruby.
  if (has('gemfile')) {
    return {
      method: 'custom',
      framework: 'rails',
      runtime: 'ruby',
      runtimeVersion: '3.2',
      buildCommand: 'bundle install --deployment --without development test',
      startCommand: 'bundle exec puma -p 3000',
      appPort: 3000,
      confidence: 0.7,
      reasons: ['Found Gemfile — Ruby project.'],
    }
  }

  // Python — only when there is no package.json (Node would otherwise win).
  if (has('requirements.txt') && !has('package.json')) {
    // Framework detection within Python happens at content level
    // (detectFromPackageJson-equivalent for Python is not provided, so we
    // fall back to "generic python" with a sane default startCommand).
    return {
      method: 'python',
      framework: 'generic',
      runtime: 'python',
      runtimeVersion: '3.11',
      startCommand: 'gunicorn app:app --bind 0.0.0.0:8000',
      appPort: 8000,
      confidence: 0.6,
      reasons: ['Found requirements.txt and no package.json — Python project.'],
    }
  }

  // Plain static HTML.
  if (has('index.html') && !has('package.json') && !has('composer.json')) {
    return {
      method: 'static',
      framework: 'html',
      runtime: 'static',
      documentRoot: '.',
      appPort: 80,
      confidence: 0.6,
      reasons: ['Found index.html with no JS/PHP manifest — plain static site.'],
    }
  }

  return null
}

// ─── package.json detection ────────────────────────────────────────────────

interface MinimalPackageJson {
  name?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: { node?: string }
}

/**
 * Detect a Node.js / static framework from a parsed `package.json` object.
 * Returns `null` for objects that don't look like a package.json.
 */
export function detectFromPackageJson(pkg: unknown): DetectionResult | null {
  if (!pkg || typeof pkg !== 'object') return null
  const p = pkg as MinimalPackageJson
  const deps: Record<string, string> = {
    ...(p.dependencies || {}),
    ...(p.devDependencies || {}),
  }
  const hasDep = (name: string) => Object.prototype.hasOwnProperty.call(deps, name)
  const scripts = p.scripts || {}
  const reasons: string[] = []

  // Node version from engines.node (e.g. ">=20" → "20").
  let runtimeVersion: string | undefined
  if (p.engines?.node) {
    const m = p.engines.node.match(/\d+/)
    if (m) runtimeVersion = m[0]
  }
  if (!runtimeVersion) runtimeVersion = '20'

  // Next.js
  if (hasDep('next')) {
    reasons.push('package.json depends on next — Next.js app.')
    const buildCommand = scripts.build ? 'npm run build' : 'next build'
    const startCommand = scripts.start ? 'npm start' : 'next start'
    return {
      method: 'nodejs',
      framework: 'nextjs',
      runtime: 'nodejs',
      runtimeVersion,
      buildCommand,
      startCommand,
      appPort: 3000,
      confidence: 0.95,
      reasons,
    }
  }

  // Nuxt
  if (hasDep('nuxt') || hasDep('nuxt3') || hasDep('nuxt-edge')) {
    reasons.push('package.json depends on nuxt — Nuxt app.')
    return {
      method: 'nodejs',
      framework: 'nuxt',
      runtime: 'nodejs',
      runtimeVersion,
      buildCommand: scripts.build ? 'npm run build' : 'nuxt build',
      startCommand: scripts.start ? 'npm start' : 'node .output/server/index.mjs',
      appPort: 3000,
      confidence: 0.95,
      reasons,
    }
  }

  // NestJS
  if (hasDep('@nestjs/core')) {
    reasons.push('package.json depends on @nestjs/core — NestJS app.')
    return {
      method: 'nodejs',
      framework: 'nestjs',
      runtime: 'nodejs',
      runtimeVersion,
      buildCommand: scripts.build ? 'npm run build' : 'nest build',
      startCommand: scripts.start ? 'npm start' : 'node dist/main.js',
      appPort: 3000,
      confidence: 0.95,
      reasons,
    }
  }

  // Astro (static output)
  if (hasDep('astro')) {
    reasons.push('package.json depends on astro — Astro static site.')
    return {
      method: 'static',
      framework: 'astro',
      runtime: 'static',
      buildCommand: scripts.build ? 'npm run build' : 'astro build',
      documentRoot: 'dist',
      appPort: 80,
      confidence: 0.85,
      reasons,
    }
  }

  // Angular (static)
  if (hasDep('@angular/core')) {
    reasons.push('package.json depends on @angular/core — Angular static site.')
    return {
      method: 'static',
      framework: 'angular',
      runtime: 'static',
      buildCommand: scripts.build ? 'npm run build' : 'ng build',
      documentRoot: 'dist',
      appPort: 80,
      confidence: 0.85,
      reasons,
    }
  }

  // Vue + Vite (static)
  if (hasDep('vue') && hasDep('vite')) {
    reasons.push('package.json depends on vue + vite — Vue static site.')
    return {
      method: 'static',
      framework: 'vue',
      runtime: 'static',
      buildCommand: scripts.build ? 'npm run build' : 'vite build',
      documentRoot: 'dist',
      appPort: 80,
      confidence: 0.8,
      reasons,
    }
  }

  // React + Vite (static)
  if (hasDep('react') && hasDep('vite')) {
    reasons.push('package.json depends on react + vite — React static site.')
    return {
      method: 'static',
      framework: 'react',
      runtime: 'static',
      buildCommand: scripts.build ? 'npm run build' : 'vite build',
      documentRoot: 'dist',
      appPort: 80,
      confidence: 0.8,
      reasons,
    }
  }

  // Svelte (static)
  if (hasDep('svelte')) {
    reasons.push('package.json depends on svelte — Svelte static site.')
    return {
      method: 'static',
      framework: 'svelte',
      runtime: 'static',
      buildCommand: scripts.build ? 'npm run build' : 'vite build',
      documentRoot: 'dist',
      appPort: 80,
      confidence: 0.8,
      reasons,
    }
  }

  // Express (Node)
  if (hasDep('express')) {
    reasons.push('package.json depends on express — Node.js app.')
    return {
      method: 'nodejs',
      framework: 'express',
      runtime: 'nodejs',
      runtimeVersion,
      buildCommand: scripts.build ? 'npm run build' : undefined,
      startCommand: scripts.start ? 'npm start' : 'node index.js',
      appPort: 3000,
      confidence: 0.85,
      reasons,
    }
  }

  // Generic Node (package.json but no recognized framework).
  if (Object.keys(deps).length > 0 || Object.keys(scripts).length > 0) {
    reasons.push('package.json present without a recognized framework — generic Node.js app.')
    return {
      method: 'nodejs',
      framework: 'generic',
      runtime: 'nodejs',
      runtimeVersion,
      buildCommand: scripts.build ? 'npm run build' : undefined,
      startCommand: scripts.start ? 'npm start' : 'node index.js',
      appPort: 3000,
      confidence: 0.5,
      reasons,
    }
  }

  return null
}

// ─── composer.json detection ───────────────────────────────────────────────

interface MinimalComposerJson {
  require?: Record<string, string>
  'require-dev'?: Record<string, string>
  type?: string
}

/**
 * Detect a PHP framework from a parsed `composer.json` object.
 * Returns `null` when the object does not look like a composer.json.
 */
export function detectFromComposerJson(composer: unknown): DetectionResult | null {
  if (!composer || typeof composer !== 'object') return null
  const c = composer as MinimalComposerJson
  const require = { ...(c.require || {}), ...(c['require-dev'] || {}) }
  const hasReq = (name: string) => Object.prototype.hasOwnProperty.call(require, name)
  const reasons: string[] = []

  // Laravel
  if (hasReq('laravel/framework')) {
    reasons.push('composer.json requires laravel/framework — Laravel app.')
    return {
      method: 'laravel',
      framework: 'laravel',
      runtime: 'php',
      runtimeVersion: detectPhpVersion(require['php']) || '8.2',
      buildCommand: 'composer install --no-dev --optimize-autoloader',
      startCommand: 'php artisan migrate --force && php artisan config:cache && php-fpm',
      appPort: 80,
      documentRoot: '/var/www/html/public',
      confidence: 0.95,
      reasons,
    }
  }

  // Symfony
  if (hasReq('symfony/framework-bundle') || hasReq('symfony/symfony')) {
    reasons.push('composer.json requires symfony — Symfony app.')
    return {
      method: 'laravel', // Treat as PHP framework — reuse laravel pipeline.
      framework: 'symfony',
      runtime: 'php',
      runtimeVersion: detectPhpVersion(require['php']) || '8.2',
      buildCommand: 'composer install --no-dev --optimize-autoloader',
      startCommand: 'php-fpm',
      appPort: 80,
      documentRoot: '/var/www/html/public',
      confidence: 0.9,
      reasons,
    }
  }

  // Generic PHP composer project.
  if (Object.keys(require).length > 0) {
    reasons.push('composer.json present without Laravel — generic PHP project.')
    return {
      method: 'php',
      framework: 'composer',
      runtime: 'php',
      runtimeVersion: detectPhpVersion(require['php']) || '8.2',
      appPort: 80,
      documentRoot: '/var/www/html',
      confidence: 0.7,
      reasons,
    }
  }

  return null
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Parse a composer `php` constraint (e.g. `^8.1`, `>=8.0`, `8.2.*`) and
 * return the major.minor version string. Falls back to undefined.
 */
function detectPhpVersion(constraint: string | undefined): string | undefined {
  if (!constraint) return undefined
  const m = constraint.match(/(\d+\.\d+)/)
  return m ? m[1] : undefined
}

/**
 * Pick a package manager from a list of filenames. Used by callers that
 * have already enumerated the repo root and want to know whether to use
 * `npm`, `pnpm`, `yarn`, or `bun` for installs.
 */
export function detectPackageManager(filenames: string[]): 'npm' | 'pnpm' | 'yarn' | 'bun' {
  const lower = filenames.map((f) => f.toLowerCase())
  if (lower.includes('pnpm-lock.yaml')) return 'pnpm'
  if (lower.includes('yarn.lock')) return 'yarn'
  if (lower.includes('bun.lockb') || lower.includes('bun.lock')) return 'bun'
  return 'npm'
}

/**
 * Combine multiple detection passes (filename, package.json, composer.json)
 * and pick the highest-confidence result. Each pass is optional.
 */
export function detectBest(opts: {
  filenames?: string[]
  packageJson?: unknown
  composerJson?: unknown
}): DetectionResult | null {
  const candidates: DetectionResult[] = []
  if (opts.filenames) {
    const r = detectFromFilenames(opts.filenames)
    if (r) candidates.push(r)
  }
  if (opts.packageJson) {
    const r = detectFromPackageJson(opts.packageJson)
    if (r) candidates.push(r)
  }
  if (opts.composerJson) {
    const r = detectFromComposerJson(opts.composerJson)
    if (r) candidates.push(r)
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.confidence - a.confidence)
  return candidates[0]
}
