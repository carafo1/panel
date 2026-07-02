/**
 * VPS module — barrel export for the real hosting layer.
 *
 * Provides SSH-based VPS management, container deployment via Docker Compose,
 * Caddy reverse proxy with automatic Let's Encrypt SSL, and health monitoring.
 *
 * All modules gracefully fall back to DEMO MODE when VPS_DEMO_MODE=1 or when
 * no Server row has a non-empty sshHost, so the platform UX is intact even
 * without a real VPS.
 */
export * from './ssh'
export * from './provisioner'
export * from './deployer'
export * from './proxy'
export * from './ssl'
export * from './database'
export * from './files'
export * from './terminal'
export * from './backups'
export * from './resources'
export * from './cron'
export * from './ftp'
export * from './redirects'
export * from './security'
