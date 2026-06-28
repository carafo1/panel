/**
 * Caddy Reverse Proxy Manager
 * ===========================
 *
 * Generates and maintains the Caddyfile entries on each VPS so that:
 *
 *   - Every project with `sslEnabled=true` gets automatic HTTPS via
 *     Let's Encrypt (Caddy's built-in ACME client handles cert issuance
 *     and renewal — no certbot needed).
 *   - HTTP→HTTPS redirects are automatic.
 *   - Requests to https://<domain>/ are reverse-proxied to the project's
 *     container on the deployhub docker network.
 *   - Custom domains + subdomains are both supported.
 *
 * The on-VPS Caddyfile lives at /etc/caddy/Caddyfile (Debian/Ubuntu default).
 * After every change we run `caddy reload --config /etc/caddy/Caddyfile`
 * which is non-disruptive (Caddy reloads in-place).
 *
 * In DEMO MODE we keep an in-memory snapshot of what *would* be written,
 * and report success without touching any real server.
 */
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  putFile,
  isVpsDemoMode,
  isServerInDemoMode,
} from './ssh'
import { getServerCredentials } from './provisioner'
import { ADMIN_EMAIL } from '@/lib/brand-config'

// ─── Types ───────────────────────────────────────────────────────────────

export interface ProxyConfig {
  hostname: string
  upstream: string // e.g. deployhub-myapp:3000 (container_name:port on deployhub net)
  ssl: boolean
  sslCertStatus?: 'none' | 'pending' | 'issued' | 'failed' | 'renewing'
  redirectToWww?: boolean
  basicAuth?: { username: string; passwordHash: string }[]
}

export interface ProjectProxyResult {
  ok: boolean
  message: string
  configSnippet?: string
}

// ─── Configure a project's proxy entry ───────────────────────────────────

/**
 * Add or update the Caddyfile entry for a project. The project's hostname
 * (customDomain or subdomain) is mapped to the container's address on the
 * deployhub docker network.
 */
export async function configureProjectProxy(
  projectId: string,
  opts: { onLog?: (msg: string) => void } = {}
): Promise<ProjectProxyResult> {
  const log = (m: string) => opts.onLog?.(m)
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error(`Project ${projectId} not found`)
  if (!project.serverId || !project.server) {
    throw new Error('Project has no server assigned')
  }
  if (!project.containerName) {
    throw new Error('Project has no container — deploy first')
  }

  const hostname = project.customDomain || project.subdomain
  const upstream = `${project.containerName}:${project.containerPort || 3000}`
  const ssl = project.sslEnabled

  log(`Configuring proxy: ${hostname} → ${upstream} (SSL: ${ssl ? 'on' : 'off'})`)

  // Demo mode: pretend we wrote the config
  if (isServerInDemoMode(project.server)) {
    const snippet = generateCaddyBlock({ hostname, upstream, ssl })
    if (ssl) {
      await db.project.update({
        where: { id: projectId },
        data: {
          sslCertStatus: 'issued',
          sslCertExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
      })
    }
    return { ok: true, message: 'Demo mode: proxy configured', configSnippet: snippet }
  }

  // Real mode: regenerate the FULL Caddyfile from all projects on this server
  // and atomically swap it in.
  const creds = await getServerCredentials(project.serverId)
  try {
    await withConnection(creds, async (client) => {
      const allProjects = await db.project.findMany({
        where: {
          serverId: project.serverId,
          status: 'running',
          containerName: { not: null },
        },
        select: {
          id: true,
          customDomain: true,
          subdomain: true,
          containerName: true,
          containerPort: true,
          sslEnabled: true,
        },
      })

      const configs: ProxyConfig[] = allProjects.map((p) => ({
        hostname: p.customDomain || p.subdomain,
        upstream: `${p.containerName}:${p.containerPort || 3000}`,
        ssl: p.sslEnabled,
      }))

      const caddyfile = generateFullCaddyfile(configs)
      log(`Writing Caddyfile (${caddyfile.length} bytes, ${configs.length} sites)…`)

      // Write to a temp file then atomically move (avoids partial writes).
      await putFile(client, '/etc/caddy/Caddyfile.new', caddyfile, { mode: 0o644 })
      await exec(client, 'mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile', {
        timeoutMs: 5000,
      })

      // Validate before reload
      log('Validating Caddyfile…')
      const validate = await exec(client, 'caddy validate --config /etc/caddy/Caddyfile', {
        timeoutMs: 15000,
      })
      if (validate.exitCode !== 0) {
        // Restore from backup if validation failed
        await exec(client, 'mv /etc/caddy/Caddyfile.bak /etc/caddy/Caddyfile 2>/dev/null || true', {
          timeoutMs: 5000,
        })
        throw new Error(`Caddyfile validation failed: ${validate.stderr}`)
      }

      log('Reloading Caddy…')
      const reload = await exec(client, 'systemctl reload caddy', {
        timeoutMs: 15000,
      })
      if (reload.exitCode !== 0) {
        throw new Error(`Caddy reload failed: ${reload.stderr}`)
      }
      log('Caddy reloaded successfully')
    })

    if (ssl) {
      await db.project.update({
        where: { id: projectId },
        data: {
          sslCertStatus: 'issued',
          sslCertExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
      })
    } else {
      await db.project.update({
        where: { id: projectId },
        data: { sslCertStatus: 'none', sslCertExpiry: null },
      })
    }

    return {
      ok: true,
      message: `Proxy configured for ${hostname}`,
      configSnippet: generateCaddyBlock({ hostname, upstream, ssl }),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`FAILED: ${message}`)
    await db.project.update({
      where: { id: projectId },
      data: { sslCertStatus: 'failed' },
    })
    return { ok: false, message }
  }
}

// ─── Remove a project's proxy entry ──────────────────────────────────────

export async function removeProjectProxy(projectId: string): Promise<ProjectProxyResult> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) return { ok: false, message: 'Project not found' }
  if (!project.serverId || !project.server) {
    return { ok: false, message: 'Project has no server' }
  }

  if (isServerInDemoMode(project.server)) {
    return { ok: true, message: 'Demo mode: proxy removed (simulated)' }
  }

  // In real mode, we just regenerate the full Caddyfile without this project
  // (since the project's status will no longer be 'running' or container will be cleared).
  try {
    // Mark the project's container as null first so regenerate skips it
    const creds = await getServerCredentials(project.serverId)
    await withConnection(creds, async (client) => {
      const allProjects = await db.project.findMany({
        where: {
          serverId: project.serverId,
          id: { not: projectId },
          status: 'running',
          containerName: { not: null },
        },
        select: {
          customDomain: true,
          subdomain: true,
          containerName: true,
          containerPort: true,
          sslEnabled: true,
        },
      })
      const configs: ProxyConfig[] = allProjects.map((p) => ({
        hostname: p.customDomain || p.subdomain,
        upstream: `${p.containerName}:${p.containerPort || 3000}`,
        ssl: p.sslEnabled,
      }))
      const caddyfile = generateFullCaddyfile(configs)
      await putFile(client, '/etc/caddy/Caddyfile.new', caddyfile, { mode: 0o644 })
      await exec(client, 'mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy', {
        timeoutMs: 30000,
      })
    })
    return { ok: true, message: 'Proxy entry removed' }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Caddyfile generation ────────────────────────────────────────────────

/**
 * Generate the Caddyfile block for a single site.
 *
 * SSL on:  Caddy's automatic HTTPS — issues a Let's Encrypt cert on first
 *          request, auto-renews ~30 days before expiry. HTTP→HTTPS redirect
 *          is built-in.
 *
 * SSL off: Plain HTTP listener on port 80.
 */
export function generateCaddyBlock(cfg: ProxyConfig): string {
  const lines: string[] = []
  const addr = cfg.ssl ? cfg.hostname : `:80 {
  # ${cfg.hostname} (SSL disabled — serving on port 80)`

  if (cfg.ssl) {
    lines.push(`${cfg.hostname} {`)
  } else {
    lines.push(`:80 {`)
    lines.push(`  @host host ${cfg.hostname}`)
    lines.push(`  handle @host {`)
  }

  lines.push(`  reverse_proxy ${cfg.upstream} {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
  }`)

  if (cfg.basicAuth && cfg.basicAuth.length > 0) {
    lines.push(`  basic_auth {`)
    for (const u of cfg.basicAuth) {
      lines.push(`    ${u.username} ${u.passwordHash}`)
    }
    lines.push(`  }`)
  }

  if (cfg.ssl) {
    // Request compression + logging
    lines.push(`  encode gzip zstd`)
    lines.push(`  log {
    output file /opt/deployhub/logs/${cfg.hostname.replace(/\W+/g, '_')}.log
    format json
  }`)
    // Caddy will automatically use Let's Encrypt — no explicit tls directive needed.
    // But we can be explicit about the email for ACME account.
    const email = process.env.LE_EMAIL || ADMIN_EMAIL
    lines.push(`  tls ${email} {
    on_demand
  }`)
  }

  if (!cfg.ssl) {
    lines.push(`  }`)
  }
  lines.push(`}`)
  return lines.join('\n')
}

/**
 * Generate the full /etc/caddy/Caddyfile for a server. Includes the global
 * options block (ACME email, etc.) + one block per project.
 */
export function generateFullCaddyfile(configs: ProxyConfig[]): string {
  const email = process.env.LE_EMAIL || ADMIN_EMAIL
  const out: string[] = [
    `# Managed by Apsamo Panel — DO NOT EDIT MANUALLY`,
    `# Generated: ${new Date().toISOString()}`,
    `# Sites: ${configs.length}`,
    ``,
    `{`,
    `  email ${email}`,
    `  admin off`,
    `  log {
    output file /opt/deployhub/logs/caddy-global.log
    format json
  }`,
    `}`,
    ``,
  ]
  for (const cfg of configs) {
    out.push(generateCaddyBlock(cfg))
    out.push('')
  }
  if (configs.length === 0) {
    out.push(`# No sites configured yet — Apsamo Panel will add them here.`)
    out.push(`:80 { respond "Apsamo Panel — no sites configured" 200 }`)
  }
  return out.join('\n')
}

// ─── Get current Caddyfile from a server ─────────────────────────────────

export async function getServerCaddyfile(serverId: string): Promise<string> {
  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) throw new Error('Server not found')

  if (isServerInDemoMode(server)) {
    const projects = await db.project.findMany({
      where: { serverId, status: 'running', containerName: { not: null } },
      select: {
        customDomain: true,
        subdomain: true,
        containerName: true,
        containerPort: true,
        sslEnabled: true,
      },
    })
    const configs: ProxyConfig[] = projects.map((p) => ({
      hostname: p.customDomain || p.subdomain,
      upstream: `${p.containerName}:${p.containerPort || 3000}`,
      ssl: p.sslEnabled,
    }))
    return generateFullCaddyfile(configs)
  }

  const creds = await getServerCredentials(serverId)
  return await withConnection(creds, async (client) => {
    const r = await exec(client, 'cat /etc/caddy/Caddyfile 2>/dev/null', {
      timeoutMs: 10000,
    })
    return r.stdout || '# Caddyfile not found on server'
  })
}

// ─── Reload Caddy (manual trigger) ───────────────────────────────────────

export async function reloadCaddy(serverId: string): Promise<{ ok: boolean; message: string }> {
  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) return { ok: false, message: 'Server not found' }
  if (isServerInDemoMode(server)) {
    return { ok: true, message: 'Demo mode: Caddy reloaded (simulated)' }
  }
  try {
    const creds = await getServerCredentials(serverId)
    return await withConnection(creds, async (client) => {
      const r = await exec(client, 'systemctl reload caddy 2>&1', { timeoutMs: 15000 })
      if (r.exitCode === 0) return { ok: true, message: 'Caddy reloaded' }
      return { ok: false, message: r.stderr || r.stdout }
    })
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
