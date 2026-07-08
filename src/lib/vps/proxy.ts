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
import { isLocalHost, ensureDir } from './local-exec'
import { ADMIN_EMAIL, BRAND_DOMAIN } from '@/lib/brand-config'
import path from 'path'
import fs from 'fs'

// ─── Local storage paths (for localhost servers) ─────────────────────────

const STORAGE_ROOT =
  process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage')
const LOCAL_CADDY_DIR = path.join(STORAGE_ROOT, 'caddy')
const LOCAL_CADDYFILE = path.join(LOCAL_CADDY_DIR, 'Caddyfile')

export interface ProxyConfig {
  hostname: string
  upstream: string // e.g. deployhub-myapp:3000 (container_name:port on deployhub net)
  ssl: boolean
  sslCertStatus?: 'none' | 'pending' | 'issued' | 'failed' | 'renewing'
  redirectToWww?: boolean
  basicAuth?: { username: string; passwordHash: string }[]
  /** Active URL redirects to inject as `redir` directives (BEFORE reverse_proxy). */
  redirects?: { fromPath: string; toUrl: string; statusCode: number }[]
  /** Active IP-block rules to inject as `@blocked client_ip ...` matchers (deny rules only). */
  ipBlocks?: { ipAddress: string; action: string }[]
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

  // Demo mode: pretend we wrote the config (but still load redirects + ipBlocks
  // so the returned snippet reflects the full site block).
  if (isServerInDemoMode(project.server)) {
    const [redirects, ipBlocks] = await Promise.all([
      db.redirect.findMany({
        where: { projectId, enabled: true },
        select: { fromPath: true, toUrl: true, statusCode: true },
      }),
      db.ipBlock.findMany({
        where: { projectId, enabled: true },
        select: { ipAddress: true, action: true },
      }),
    ])
    const snippet = generateCaddyBlock({
      hostname,
      upstream,
      ssl,
      redirects: redirects.map((r) => ({
        fromPath: r.fromPath,
        toUrl: r.toUrl,
        statusCode: r.statusCode,
      })),
      ipBlocks: ipBlocks.map((b) => ({
        ipAddress: b.ipAddress,
        action: b.action,
      })),
    })
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
  // and atomically swap it in. Each project's redirects + ipBlocks are loaded
  // so the generated Caddyfile includes `redir` and `@blocked` directives.
  const isLocal = isLocalHost(project.server?.sshHost)
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
          externalPort: true,
          sslEnabled: true,
        },
      })

      // Load redirects + ipBlocks for every project on this server in parallel.
      const [allRedirects, allIpBlocks] = await Promise.all([
        db.redirect.findMany({
          where: { projectId: { in: allProjects.map((p) => p.id) }, enabled: true },
          select: { projectId: true, fromPath: true, toUrl: true, statusCode: true },
        }),
        db.ipBlock.findMany({
          where: { projectId: { in: allProjects.map((p) => p.id) }, enabled: true },
          select: { projectId: true, ipAddress: true, action: true },
        }),
      ])

      const configs: ProxyConfig[] = allProjects.map((p) => ({
        hostname: p.customDomain || p.subdomain,
        // Localhost single-box: the host Caddy isn't on the docker network, so
        // it reaches the container via its published host port. Remote VPS:
        // Caddy shares the deployhub network and resolves the container name.
        upstream: isLocal
          ? `localhost:${p.externalPort || p.containerPort || 3000}`
          : `${p.containerName}:${p.containerPort || 3000}`,
        ssl: p.sslEnabled,
        redirects: allRedirects
          .filter((r) => r.projectId === p.id)
          .map((r) => ({
            fromPath: r.fromPath,
            toUrl: r.toUrl,
            statusCode: r.statusCode,
          })),
        ipBlocks: allIpBlocks
          .filter((b) => b.projectId === p.id)
          .map((b) => ({ ipAddress: b.ipAddress, action: b.action })),
      }))

      // On single-box installs, include the panel's own block so regenerating
      // the Caddyfile for a project never knocks the control panel offline.
      const caddyfile = generateFullCaddyfile(configs, { includePanelBlock: isLocal })
      log(`Writing Caddyfile (${caddyfile.length} bytes, ${configs.length} sites)…`)

      // Write the REAL system Caddyfile + validate + reload — for BOTH localhost
      // (LocalClient runs cp/mv/caddy/systemctl on the panel host) and remote.
      await exec(client, 'cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak 2>/dev/null || true', { timeoutMs: 5000 })
      await putFile(client, '/etc/caddy/Caddyfile.new', caddyfile, { mode: 0o644 })
      await exec(client, 'mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile', { timeoutMs: 5000 })
      log('Validating Caddyfile…')
      const validate = await exec(client, 'caddy validate --config /etc/caddy/Caddyfile', { timeoutMs: 20000 })
      if (validate.exitCode !== 0) {
        await exec(client, 'mv /etc/caddy/Caddyfile.bak /etc/caddy/Caddyfile 2>/dev/null || true', { timeoutMs: 5000 })
        throw new Error(`Caddyfile validation failed: ${validate.stderr}`)
      }
      log('Reloading Caddy…')
      const reload = await exec(client, 'systemctl reload caddy', { timeoutMs: 20000 })
      if (reload.exitCode !== 0) {
        throw new Error(`Caddy reload failed: ${reload.stderr}`)
      }
      log('Caddy reloaded successfully')
      // Keep a copy in storage for display/debugging.
      if (isLocal) {
        try {
          await ensureDir(LOCAL_CADDY_DIR)
          fs.writeFileSync(LOCAL_CADDYFILE, caddyfile, { mode: 0o644 })
        } catch {
          /* noop */
        }
      }
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

    // Re-load this project's redirects + ipBlocks for the returned snippet.
    const [snippetRedirects, snippetIpBlocks] = await Promise.all([
      db.redirect.findMany({
        where: { projectId, enabled: true },
        select: { fromPath: true, toUrl: true, statusCode: true },
      }),
      db.ipBlock.findMany({
        where: { projectId, enabled: true },
        select: { ipAddress: true, action: true },
      }),
    ])
    return {
      ok: true,
      message: `Proxy configured for ${hostname}`,
      configSnippet: generateCaddyBlock({
        hostname,
        upstream,
        ssl,
        redirects: snippetRedirects.map((r) => ({
          fromPath: r.fromPath,
          toUrl: r.toUrl,
          statusCode: r.statusCode,
        })),
        ipBlocks: snippetIpBlocks.map((b) => ({
          ipAddress: b.ipAddress,
          action: b.action,
        })),
      }),
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
          id: true,
          customDomain: true,
          subdomain: true,
          containerName: true,
          containerPort: true,
          externalPort: true,
          sslEnabled: true,
        },
      })
      const isLocal = isLocalHost(project.server?.sshHost)
      // Load redirects + ipBlocks for the remaining projects so the regenerated
      // Caddyfile still has their `redir` + `@blocked` directives.
      const [allRedirects, allIpBlocks] = await Promise.all([
        db.redirect.findMany({
          where: { projectId: { in: allProjects.map((p) => p.id) }, enabled: true },
          select: { projectId: true, fromPath: true, toUrl: true, statusCode: true },
        }),
        db.ipBlock.findMany({
          where: { projectId: { in: allProjects.map((p) => p.id) }, enabled: true },
          select: { projectId: true, ipAddress: true, action: true },
        }),
      ])
      const configs: ProxyConfig[] = allProjects.map((p) => ({
        hostname: p.customDomain || p.subdomain,
        upstream: isLocal
          ? `localhost:${p.externalPort || p.containerPort || 3000}`
          : `${p.containerName}:${p.containerPort || 3000}`,
        ssl: p.sslEnabled,
        redirects: allRedirects
          .filter((r) => r.projectId === p.id)
          .map((r) => ({
            fromPath: r.fromPath,
            toUrl: r.toUrl,
            statusCode: r.statusCode,
          })),
        ipBlocks: allIpBlocks
          .filter((b) => b.projectId === p.id)
          .map((b) => ({ ipAddress: b.ipAddress, action: b.action })),
      }))
      const caddyfile = generateFullCaddyfile(configs, { includePanelBlock: isLocal })
      await exec(client, 'cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak 2>/dev/null || true', { timeoutMs: 5000 })
      await putFile(client, '/etc/caddy/Caddyfile.new', caddyfile, { mode: 0o644 })
      await exec(client, 'mv /etc/caddy/Caddyfile.new /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy', {
        timeoutMs: 30000,
      })
      if (isLocal) {
        try {
          await ensureDir(LOCAL_CADDY_DIR)
          fs.writeFileSync(LOCAL_CADDYFILE, caddyfile, { mode: 0o644 })
        } catch {
          /* noop */
        }
      }
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

  if (cfg.ssl) {
    lines.push(`${cfg.hostname} {`)
  } else {
    lines.push(`:80 {`)
    lines.push(`  @host host ${cfg.hostname}`)
    lines.push(`  handle @host {`)
  }

  // ── IP blocks (deny rules) — injected BEFORE reverse_proxy so they take ──
  // precedence. Allow rules are enforced at the middleware layer (Caddy's
  // `client_ip` matcher is deny-oriented; whitelist semantics are easier in
  // the panel middleware).
  const denyIps = (cfg.ipBlocks || [])
    .filter((b) => b.action === 'deny')
    .map((b) => b.ipAddress)
    .filter(Boolean)
  if (denyIps.length > 0) {
    lines.push(`    @blocked {`)
    lines.push(`      client_ip ${denyIps.join(' ')}`)
    lines.push(`    }`)
    lines.push(`    respond @blocked 403`)
  }

  // ── Redirects — injected BEFORE reverse_proxy so they short-circuit. ──
  // Caddy syntax: `redir <from> <to> [code]` (code defaults to 301).
  for (const r of cfg.redirects || []) {
    lines.push(`    redir ${r.fromPath} ${r.toUrl} ${r.statusCode}`)
  }

  lines.push(`    reverse_proxy ${cfg.upstream} {`)
  lines.push(`      header_up Host {host}`)
  lines.push(`      header_up X-Real-IP {remote_host}`)
  lines.push(`      header_up X-Forwarded-For {remote_host}`)
  lines.push(`      header_up X-Forwarded-Proto {scheme}`)
  lines.push(`    }`)

  if (cfg.basicAuth && cfg.basicAuth.length > 0) {
    lines.push(`    basic_auth {`)
    for (const u of cfg.basicAuth) {
      lines.push(`      ${u.username} ${u.passwordHash}`)
    }
    lines.push(`    }`)
  }

  if (cfg.ssl) {
    lines.push(`    encode gzip zstd`)
    // (Access logs go to journald by default — no file-log directive, which
    // would need a caddy-writable path and can break `caddy reload`.)
    // Caddy will automatically use Let's Encrypt — no explicit tls directive needed.
    // But we can be explicit about the email for ACME account.
    // Hostname is explicit in the site address, so Caddy auto-issues a normal
    // Let's Encrypt cert. (No on_demand — that needs a global on_demand_tls ask
    // policy or Caddy refuses it.)
    const email = process.env.LE_EMAIL || ADMIN_EMAIL
    lines.push(`    tls ${email}`)
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
export function generateFullCaddyfile(
  configs: ProxyConfig[],
  opts: { includePanelBlock?: boolean } = {}
): string {
  const email = process.env.LE_EMAIL || ADMIN_EMAIL
  const out: string[] = [
    `# Managed by Apsamo Panel — DO NOT EDIT MANUALLY`,
    `# Generated: ${new Date().toISOString()}`,
    `# Sites: ${configs.length}`,
    ``,
    `{`,
    `  email ${email}`,
    `}`,
    ``,
  ]
  // On a single-box (localhost) install the panel AND the hosted projects share
  // this Caddy. ALWAYS emit the panel's own block first, so regenerating the
  // file for a project deploy never knocks the control panel offline.
  if (opts.includePanelBlock) {
    const panel = generatePanelBlock()
    if (panel) {
      out.push(panel)
      out.push('')
    }
  }
  for (const cfg of configs) {
    out.push(generateCaddyBlock(cfg))
    out.push('')
  }
  if (configs.length === 0 && !opts.includePanelBlock) {
    out.push(`# No sites configured yet — Apsamo Panel will add them here.`)
    out.push(`:80 { respond "Apsamo Panel — no sites configured" 200 }`)
  }
  return out.join('\n')
}

/**
 * The panel's own Caddy site block (control plane). Serves the dashboard on the
 * APP_URL host + the brand apex → the Next.js server on :3000, with Socket.IO
 * (realtime) routed via the XTransformPort query param. Included in the
 * generated Caddyfile only on single-box (localhost) servers, where the panel
 * shares Caddy with the projects it hosts.
 */
function generatePanelBlock(): string {
  let appHost = ''
  try {
    appHost = new URL(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').host
  } catch {
    /* ignore malformed APP_URL */
  }
  const brand = process.env.BRAND_DOMAIN || BRAND_DOMAIN
  const hosts = [...new Set([appHost, brand].filter(Boolean))]
  if (hosts.length === 0) return ''
  return [
    `# ── Apsamo Panel (control plane) — auto-managed ──`,
    `${hosts.join(', ')} {`,
    `    encode gzip zstd`,
    `    @realtime {`,
    `        query XTransformPort=*`,
    `        path /socket.io/*`,
    `    }`,
    `    handle @realtime {`,
    `        reverse_proxy localhost:{query.XTransformPort} {`,
    `            header_up Host {host}`,
    `        }`,
    `    }`,
    `    handle {`,
    `        reverse_proxy localhost:3000 {`,
    `            header_up Host {host}`,
    `            header_up X-Forwarded-For {remote_host}`,
    `            header_up X-Forwarded-Proto {scheme}`,
    `        }`,
    `    }`,
    `}`,
  ].join('\n')
}

// ─── Get current Caddyfile from a server ─────────────────────────────────

export async function getServerCaddyfile(serverId: string): Promise<string> {
  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) throw new Error('Server not found')

  if (isServerInDemoMode(server)) {
    const projects = await db.project.findMany({
      where: { serverId, status: 'running', containerName: { not: null } },
      select: {
        id: true,
        customDomain: true,
        subdomain: true,
        containerName: true,
        containerPort: true,
        sslEnabled: true,
      },
    })
    const [allRedirects, allIpBlocks] = await Promise.all([
      db.redirect.findMany({
        where: { projectId: { in: projects.map((p) => p.id) }, enabled: true },
        select: { projectId: true, fromPath: true, toUrl: true, statusCode: true },
      }),
      db.ipBlock.findMany({
        where: { projectId: { in: projects.map((p) => p.id) }, enabled: true },
        select: { projectId: true, ipAddress: true, action: true },
      }),
    ])
    const configs: ProxyConfig[] = projects.map((p) => ({
      hostname: p.customDomain || p.subdomain,
      upstream: `${p.containerName}:${p.containerPort || 3000}`,
      ssl: p.sslEnabled,
      redirects: allRedirects
        .filter((r) => r.projectId === p.id)
        .map((r) => ({
          fromPath: r.fromPath,
          toUrl: r.toUrl,
          statusCode: r.statusCode,
        })),
      ipBlocks: allIpBlocks
        .filter((b) => b.projectId === p.id)
        .map((b) => ({ ipAddress: b.ipAddress, action: b.action })),
    }))
    return generateFullCaddyfile(configs)
  }

  const creds = await getServerCredentials(serverId)
  // Local mode: read from storage/caddy/Caddyfile
  if (isLocalHost(server.sshHost)) {
    try {
      if (fs.existsSync(LOCAL_CADDYFILE)) {
        return fs.readFileSync(LOCAL_CADDYFILE, 'utf8')
      }
    } catch {
      /* fall through */
    }
  }
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
  // Local mode: no Caddy daemon running locally — enforcement is via the
  // Next.js proxy. The Caddyfile on disk is for display/debugging only.
  if (isLocalHost(server.sshHost)) {
    return {
      ok: true,
      message: 'Local mode: Caddyfile is in storage/caddy/Caddyfile (enforcement via Next.js proxy)',
    }
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
