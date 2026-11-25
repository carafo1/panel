/**
 * Information architecture of the website page.
 *
 * The page used to stack ~20 management sections on one scrolling page. It is
 * now a handful of areas (top-level tabs). Only the active area is rendered.
 * Every old section id still resolves, so links such as `#files`, `#cron` or
 * `#redirects` open the area that now holds that section.
 *
 * Pure module (no React) so the mapping is unit-tested.
 */

export type SiteKind = 'wordpress' | 'apptools' | null

export type AreaId =
  | 'overview'
  | 'wordpress'
  | 'apptools'
  | 'files'
  | 'domains'
  | 'email'
  | 'databases'
  | 'backups'
  | 'advanced'

/** Sub-sections of the Advanced area (rendered one at a time). */
export type AdvancedId =
  | 'deployments'
  | 'environment'
  | 'container'
  | 'terminal'
  | 'cron'
  | 'resources'
  | 'security'
  | 'settings'

export interface AreaDef {
  id: AreaId
  label: string
}

export interface AdvancedDef {
  id: AdvancedId
  label: string
  description: string
}

export const ADVANCED_SECTIONS: AdvancedDef[] = [
  { id: 'deployments', label: 'Deployments', description: 'Deploy history, build logs and GitHub' },
  { id: 'environment', label: 'Environment', description: 'Environment variables' },
  { id: 'container', label: 'Container & logs', description: 'Restart, stop and live logs' },
  { id: 'terminal', label: 'Terminal', description: 'Run commands on the site' },
  { id: 'cron', label: 'Cron jobs', description: 'Scheduled tasks' },
  { id: 'resources', label: 'Resource usage', description: 'CPU, memory and storage' },
  { id: 'security', label: 'IP blocker', description: 'Allow or block visitors by IP' },
  { id: 'settings', label: 'Settings', description: 'Auto-deploy, delete website' },
]

/**
 * Old section ids (and a few aliases) → where they live now. Sections inside a
 * stacked area keep their element id so the page can scroll to them.
 */
const SECTION_TO_AREA: Record<string, { area: AreaId; advanced?: AdvancedId }> = {
  overview: { area: 'overview' },
  wordpress: { area: 'wordpress' },
  apptools: { area: 'apptools' },
  files: { area: 'files' },
  sftp: { area: 'files' },
  databases: { area: 'databases' },
  domains: { area: 'domains' },
  ssl: { area: 'domains' },
  redirects: { area: 'domains' },
  cdn: { area: 'domains' },
  email: { area: 'email' },
  backups: { area: 'backups' },
  staging: { area: 'backups' },
  import: { area: 'backups' },
  advanced: { area: 'advanced' },
  deployments: { area: 'advanced', advanced: 'deployments' },
  github: { area: 'advanced', advanced: 'deployments' },
  environment: { area: 'advanced', advanced: 'environment' },
  env: { area: 'advanced', advanced: 'environment' },
  container: { area: 'advanced', advanced: 'container' },
  logs: { area: 'advanced', advanced: 'container' },
  terminal: { area: 'advanced', advanced: 'terminal' },
  cron: { area: 'advanced', advanced: 'cron' },
  resources: { area: 'advanced', advanced: 'resources' },
  security: { area: 'advanced', advanced: 'security' },
  settings: { area: 'advanced', advanced: 'settings' },
}

/** Areas in tab order for a site of the given kind. */
export function areasFor(kind: SiteKind): AreaDef[] {
  const areas: AreaDef[] = [{ id: 'overview', label: 'Overview' }]
  if (kind === 'wordpress') areas.push({ id: 'wordpress', label: 'WordPress' })
  if (kind === 'apptools') areas.push({ id: 'apptools', label: 'App tools' })
  areas.push(
    { id: 'files', label: 'Files' },
    { id: 'domains', label: 'Domains & SSL' },
    { id: 'email', label: 'Email' },
    { id: 'databases', label: 'Databases' },
    { id: 'backups', label: 'Backups' },
    { id: 'advanced', label: 'Advanced' }
  )
  return areas
}

export interface AreaLocation {
  area: AreaId
  advanced: AdvancedId
  /** Element id inside the area to scroll to, when the hash named one. */
  section: string | null
}

/**
 * Resolve a location hash (`#files`, `files`, `#cron`) for a site. Unknown or
 * unavailable ids (e.g. `#wordpress` on a static site) fall back to Overview.
 */
export function resolveHash(hash: string | null | undefined, kind: SiteKind): AreaLocation {
  const id = (hash || '').replace(/^#/, '').trim().toLowerCase()
  const hit = SECTION_TO_AREA[id]
  const fallback: AreaLocation = { area: 'overview', advanced: 'deployments', section: null }
  if (!hit) return fallback
  const available = areasFor(kind).some((a) => a.id === hit.area)
  if (!available) return fallback
  const isStackedSection = hit.area !== 'advanced' && id !== hit.area
  return {
    area: hit.area,
    advanced: hit.advanced ?? 'deployments',
    section: isStackedSection ? id : null,
  }
}

/** The hash that represents a location (Advanced sub-sections get their own). */
export function hashFor(area: AreaId, advanced: AdvancedId): string {
  return area === 'advanced' ? advanced : area
}

/** Same rule hosting-panel.tsx used to choose stack-specific tools. */
export function siteKind(p: {
  deploymentMethod?: string | null
  stack?: string | null
  framework?: string | null
}): SiteKind {
  if (p.deploymentMethod === 'wordpress' || p.stack === 'wordpress' || p.framework === 'wordpress') return 'wordpress'
  const m = p.deploymentMethod || ''
  if (['laravel', 'nodejs', 'python', 'php'].includes(m)) return 'apptools'
  if (['nodejs', 'python', 'php'].includes(p.stack || '')) return 'apptools'
  if (['laravel', 'django', 'flask', 'fastapi'].includes(p.framework || '')) return 'apptools'
  return null
}
