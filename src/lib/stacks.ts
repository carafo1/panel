/**
 * Deployment stack definitions.
 *
 * Pure-data module describing the application stacks APSAMO knows how to
 * provision. Used by:
 *  - /api/provisioning/stacks (the public stack picker endpoint)
 *  - the provisioning UI (stack labels/descriptions)
 *
 * This module was originally part of the Coolify integration; it has been
 * preserved because the stack definitions themselves are just metadata and
 * do not depend on any external API.
 */

/**
 * Static definitions for every stack APSAMO knows how to provision.
 *
 * Each entry carries:
 *  - `name`:           human-readable label
 *  - `dockerfile`:     the Dockerfile content to use. `null` for the `docker`
 *                      stack, which means "use the repo's own Dockerfile".
 *  - `buildCommand`:   optional pre-build command (e.g. `npm run build`).
 *                      `null` if not applicable.
 *  - `startCommand`:   optional start command. `null` if the Dockerfile's
 *                      `CMD` is sufficient.
 *  - `port`:           the port the container listens on.
 *  - `healthCheck`:    HTTP path to hit to confirm the app is up.
 */
export const STACK_DEFINITIONS = {
  nodejs: {
    name: 'Node.js',
    // `npm ci` REQUIRES a package-lock.json and hard-fails without one — which
    // is exactly the case for a freshly provisioned site (the generated
    // placeholder app has a package.json but no lockfile). Fall back to
    // `npm install`. Also `--production` is deprecated in npm 9+; use
    // `--omit=dev`. Matches the newer method-aware deployer pipeline.
    dockerfile: `FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]`,
    buildCommand: 'npm run build',
    startCommand: 'npm start',
    port: 3000,
    healthCheck: '/api/health',
  },
  php: {
    name: 'PHP',
    dockerfile: `FROM php:8.2-apache
COPY . /var/www/html/
RUN chown -R www-data:www-data /var/www/html
EXPOSE 80`,
    buildCommand: null,
    startCommand: null,
    port: 80,
    healthCheck: '/',
  },
  python: {
    name: 'Python',
    dockerfile: `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "app:app"]`,
    buildCommand: null,
    startCommand: null,
    port: 8000,
    healthCheck: '/',
  },
  docker: {
    name: 'Custom Docker',
    dockerfile: null, // uses user's Dockerfile
    buildCommand: null,
    startCommand: null,
    port: 8080,
    healthCheck: '/',
  },
  wordpress: {
    name: 'WordPress',
    dockerfile: `FROM wordpress:6.4-php8.2-apache
COPY wp-content/ /var/www/html/wp-content/
EXPOSE 80`,
    buildCommand: null,
    startCommand: null,
    port: 80,
    healthCheck: '/',
  },
} as const

export type StackType = keyof typeof STACK_DEFINITIONS

/**
 * Return the stack definition for a given stack id, or `null` if unknown.
 */
export function getStackDefinition(
  stack: string
): typeof STACK_DEFINITIONS[StackType] | null {
  if (stack in STACK_DEFINITIONS) {
    return STACK_DEFINITIONS[stack as StackType]
  }
  return null
}

/**
 * List every supported stack with a short description + icon name (Lucide).
 * Used by the deployment UI to render the stack picker.
 */
export function listStacks(): Array<{
  id: string
  name: string
  description: string
  icon: string
}> {
  return [
    {
      id: 'nodejs',
      name: STACK_DEFINITIONS.nodejs.name,
      description:
        'Node.js apps with a package.json — Next.js, Express, Fastify, etc. Built with npm ci and started with npm start.',
      icon: 'box',
    },
    {
      id: 'php',
      name: STACK_DEFINITIONS.php.name,
      description:
        'PHP 8.2 on Apache. Drop your PHP files in the repo root and they are served from /var/www/html.',
      icon: 'file-code',
    },
    {
      id: 'python',
      name: STACK_DEFINITIONS.python.name,
      description:
        'Python 3.11 WSGI apps served by gunicorn. Provide a requirements.txt and an `app` callable.',
      icon: 'terminal',
    },
    {
      id: 'docker',
      name: STACK_DEFINITIONS.docker.name,
      description:
        'Bring your own Dockerfile. Apsamo Panel builds & runs it as-is on port 8080.',
      icon: 'container',
    },
    {
      id: 'wordpress',
      name: STACK_DEFINITIONS.wordpress.name,
      description:
        'Managed WordPress 6.4 on PHP 8.2/Apache. Apsamo Panel provisions a MySQL database alongside the container.',
      icon: 'layout-template',
    },
  ]
}
