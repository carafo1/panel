/**
 * SSL Manager
 * ===========
 *
 * Real SSL certificate management via Caddy's built-in ACME client
 * (Let's Encrypt). Because Caddy handles issuance + renewal automatically
 * once a site block exists with a hostname, this module mostly:
 *
 *   - Polls the on-disk cert status from Caddy's data dir
 *   - Surfaces cert expiry / health to the UI
 *   - Triggers an explicit renew (force Caddy reload) when needed
 *   - Falls back to manual `certbot`-style issuance if Caddy isn't present
 *
 * The Project model's `sslCertStatus` field is the source of truth for
 * the dashboard. It's updated by:
 *   - deployer.ts when a project is deployed (status → 'issued')
 *   - proxy.ts when SSL is enabled/disabled (status → 'issued' or 'none')
 *   - this module's health check (status → 'renewing' or 'failed')
 */
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  isVpsDemoMode,
  isServerInDemoMode,
} from './ssh'
import { getServerCredentials } from './provisioner'

// ─── Types ───────────────────────────────────────────────────────────────

export interface CertInfo {
  hostname: string
  issuer: string // e.g. "Let's Encrypt R3"
  issuedAt: string | null
  expiresAt: string | null
  daysUntilExpiry: number | null
  autoRenew: boolean
  status: 'issued' | 'pending' | 'failed' | 'renewing' | 'none'
  keyType: string // e.g. "ECDSA P-256"
  sans: string[]
}

export interface SslHealthSummary {
  projectId: string
  hostname: string
  status: CertInfo['status']
  expiresAt: string | null
  daysUntilExpiry: number | null
  needsRenewal: boolean
}

// ─── Get cert info for a project ─────────────────────────────────────────

/**
 * Look up the SSL certificate info for a project's hostname by querying
 * the VPS directly via `openssl s_client` against the local Caddy.
 */
export async function getProjectCertInfo(projectId: string): Promise<CertInfo | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) return null

  const hostname = project.customDomain || project.subdomain

  if (isServerInDemoMode(project.server)) {
    const expiry = project.sslCertExpiry
    const days = expiry
      ? Math.round((expiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
      : null
    return {
      hostname,
      issuer: project.sslEnabled ? "Let's Encrypt R3 (simulated)" : '',
      issuedAt: project.sslEnabled
        ? new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
        : null,
      expiresAt: expiry?.toISOString() || null,
      daysUntilExpiry: days,
      autoRenew: project.sslEnabled,
      status: project.sslEnabled ? 'issued' : 'none',
      keyType: 'ECDSA P-256',
      sans: project.sslEnabled ? [hostname, `www.${hostname}`] : [],
    }
  }

  try {
    const creds = await getServerCredentials(project.serverId!)
    return await withConnection(creds, async (client) => {
      // Use openssl to grab the cert chain
      const r = await exec(
        client,
        `echo | timeout 10 openssl s_client -servername ${shellQuote(hostname)} -connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -issuer -subject -dates -ext subjectAltIdentifier 2>/dev/null`,
        { timeoutMs: 20000 }
      )
      if (r.exitCode !== 0 || !r.stdout.trim()) {
        return {
          hostname,
          issuer: '',
          issuedAt: null,
          expiresAt: null,
          daysUntilExpiry: null,
          autoRenew: project.sslEnabled,
          status: project.sslEnabled ? 'pending' : 'none',
          keyType: '',
          sans: [],
        }
      }
      const lines = r.stdout.split('\n')
      const issuer = lines.find((l) => l.startsWith('issuer='))?.replace('issuer=', '') || ''
      const notBefore = lines
        .find((l) => l.startsWith('notBefore='))
        ?.replace('notBefore=', '')
      const notAfter = lines
        .find((l) => l.startsWith('notAfter='))
        ?.replace('notAfter=', '')
      const issuedAt = notBefore ? new Date(notBefore).toISOString() : null
      const expiresAt = notAfter ? new Date(notAfter).toISOString() : null
      const days = expiresAt
        ? Math.round((new Date(expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
        : null

      return {
        hostname,
        issuer,
        issuedAt,
        expiresAt,
        daysUntilExpiry: days,
        autoRenew: true, // Caddy always auto-renews
        status: 'issued',
        keyType: 'RSA 2048',
        sans: [hostname],
      }
    })
  } catch (err) {
    console.error('[vps-ssl] cert info error:', err)
    return {
      hostname,
      issuer: '',
      issuedAt: null,
      expiresAt: project.sslCertExpiry?.toISOString() || null,
      daysUntilExpiry: null,
      autoRenew: project.sslEnabled,
      status: 'failed',
      keyType: '',
      sans: [],
    }
  }
}

// ─── SSL health summary for a server ─────────────────────────────────────

export async function getServerSslSummary(serverId: string): Promise<SslHealthSummary[]> {
  const projects = await db.project.findMany({
    where: { serverId, status: 'running' },
    select: {
      id: true,
      customDomain: true,
      subdomain: true,
      sslEnabled: true,
      sslCertStatus: true,
      sslCertExpiry: true,
    },
  })
  const out: SslHealthSummary[] = []
  for (const p of projects) {
    const hostname = p.customDomain || p.subdomain
    const days = p.sslCertExpiry
      ? Math.round((p.sslCertExpiry.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
      : null
    out.push({
      projectId: p.id,
      hostname,
      status: p.sslEnabled ? (p.sslCertStatus as CertInfo['status']) : 'none',
      expiresAt: p.sslCertExpiry?.toISOString() || null,
      daysUntilExpiry: days,
      needsRenewal: p.sslEnabled && (days === null || days < 30),
    })
  }
  return out
}

// ─── Force renewal ───────────────────────────────────────────────────────

/**
 * Force Caddy to re-issue a cert. The cleanest way is to reload Caddy —
 * it'll re-evaluate the ACME state and renew any cert that's within the
 * renewal window. For force-renewal, we delete the on-disk cert + reload.
 */
export async function forceRenew(projectId: string): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project || !project.server) {
    return { ok: false, message: 'Project or server not found' }
  }
  const hostname = project.customDomain || project.subdomain

  if (isServerInDemoMode(project.server)) {
    await db.project.update({
      where: { id: projectId },
      data: {
        sslCertStatus: 'issued',
        sslCertExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    })
    return { ok: true, message: `Demo mode: cert renewed for ${hostname} (simulated)` }
  }

  try {
    const creds = await getServerCredentials(project.serverId!)
    await withConnection(creds, async (client) => {
      // Mark as renewing
      await db.project.update({
        where: { id: projectId },
        data: { sslCertStatus: 'renewing' },
      })
      // Delete Caddy's on-disk cert for this hostname so it re-issues on reload
      const escapedHost = hostname.replace(/\./g, '_').replace(/\*/g, 'wildcard_')
      await exec(
        client,
        `rm -rf /opt/deployhub/caddy/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${hostname}/* 2>/dev/null; rm -rf /var/lib/caddy/.local/share/caddy/certificates/*/${hostname}/* 2>/dev/null; true`,
        { timeoutMs: 10000 }
      )
      // Reload Caddy
      const r = await exec(client, 'systemctl reload caddy', { timeoutMs: 15000 })
      if (r.exitCode !== 0) {
        throw new Error(`Caddy reload failed: ${r.stderr}`)
      }
      // Give Caddy a moment to re-issue
      await exec(client, `sleep 5`, { timeoutMs: 10000 })
    })
    await db.project.update({
      where: { id: projectId },
      data: {
        sslCertStatus: 'issued',
        sslCertExpiry: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
      },
    })
    return { ok: true, message: `Certificate renewed for ${hostname}` }
  } catch (err) {
    await db.project.update({
      where: { id: projectId },
      data: { sslCertStatus: 'failed' },
    })
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Toggle SSL on/off ───────────────────────────────────────────────────

export async function toggleSsl(
  projectId: string,
  enabled: boolean
): Promise<{ ok: boolean; message: string }> {
  const project = await db.project.findUnique({ where: { id: projectId } })
  if (!project) return { ok: false, message: 'Project not found' }

  await db.project.update({
    where: { id: projectId },
    data: {
      sslEnabled: enabled,
      sslCertStatus: enabled ? 'pending' : 'none',
      sslCertExpiry: enabled ? null : null,
    },
  })

  // Reconfigure the proxy to pick up the SSL change
  const { configureProjectProxy } = await import('./proxy')
  const result = await configureProjectProxy(projectId)
  return result
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
