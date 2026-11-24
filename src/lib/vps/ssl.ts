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
 *   - proxy.ts after every Caddy reload, via recordCertificateStatus: a
 *     verified TLS handshake → 'issued' with the certificate's real expiry,
 *     otherwise 'pending' (never a made-up expiry)
 *   - this module's cert-info lookup (same probe, persisted) and forceRenew
 *   - 'none' when SSL is off, 'failed' when the proxy update itself fails
 */
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  isVpsDemoMode,
  isServerInDemoMode,
} from './ssh'
import { getServerCredentials } from './provisioner'
import { isValidHostname } from '@/lib/custom-domains'

// ─── Real certificate check ──────────────────────────────────────────────

export interface CertProbe {
  ok: boolean
  issuer?: string
  notBefore?: Date
  notAfter?: Date
}

/**
 * Ask the host's Caddy for the certificate it serves for `hostname` and
 * verify it (chain + hostname). Only a verified, unexpired certificate counts.
 * Retries briefly because Caddy obtains certificates in the background right
 * after a reload.
 */
export async function probeCertificate(
  client: Parameters<typeof exec>[0],
  hostname: string,
  opts: { attempts?: number } = {}
): Promise<CertProbe> {
  if (!isValidHostname(hostname)) return { ok: false }
  const h = shellQuote(hostname)
  const attempts = Math.max(1, Math.min(opts.attempts ?? 3, 10))
  const cmd =
    `for i in $(seq 1 ${attempts}); do ` +
    `out=$(echo | timeout 10 openssl s_client -servername ${h} -verify_hostname ${h} -verify_return_error ` +
    `-connect 127.0.0.1:443 2>/dev/null | openssl x509 -noout -issuer -dates 2>/dev/null); ` +
    `if [ -n "$out" ]; then echo "$out"; exit 0; fi; [ "$i" -lt ${attempts} ] && sleep 3; done; exit 1`
  const r = await exec(client, cmd, { timeoutMs: attempts * 15000 + 5000 }).catch(() => null)
  if (!r || r.exitCode !== 0 || !r.stdout.trim()) return { ok: false }
  const lines = r.stdout.split('\n').map((l) => l.trim())
  const field = (k: string) => lines.find((l) => l.startsWith(k + '='))?.slice(k.length + 1)
  const notAfterRaw = field('notAfter')
  const notBeforeRaw = field('notBefore')
  const notAfter = notAfterRaw ? new Date(notAfterRaw) : undefined
  const notBefore = notBeforeRaw ? new Date(notBeforeRaw) : undefined
  if (!notAfter || Number.isNaN(notAfter.getTime()) || notAfter.getTime() <= Date.now()) {
    return { ok: false }
  }
  return {
    ok: true,
    issuer: field('issuer') || '',
    notAfter,
    notBefore: notBefore && !Number.isNaN(notBefore.getTime()) ? notBefore : undefined,
  }
}

/**
 * Probe and persist: 'issued' with the certificate's REAL expiry, or
 * 'pending' (expiry cleared) when no verified certificate is being served.
 */
export async function recordCertificateStatus(
  client: Parameters<typeof exec>[0],
  projectId: string,
  hostname: string,
  opts: { attempts?: number } = {}
): Promise<CertProbe> {
  const cert = await probeCertificate(client, hostname, opts)
  await db.project
    .update({
      where: { id: projectId },
      data: cert.ok
        ? { sslCertStatus: 'issued', sslCertExpiry: cert.notAfter }
        : { sslCertStatus: 'pending', sslCertExpiry: null },
    })
    .catch(() => {})
  return cert
}

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
      // Verified TLS handshake against the host's Caddy. (This used to pass
      // `-ext subjectAltIdentifier`, which is not an extension name, and did
      // not verify the chain, so any certificate — or none — was reported.)
      // The result is persisted, so a site left 'pending' after deploy flips
      // to 'issued' with its real expiry the next time anyone looks.
      const cert = project.sslEnabled
        ? await recordCertificateStatus(client, projectId, hostname)
        : { ok: false as const }
      if (!cert.ok) {
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
      const issuer = cert.issuer || ''
      const issuedAt = cert.notBefore ? cert.notBefore.toISOString() : null
      const expiresAt = cert.notAfter ? cert.notAfter.toISOString() : null
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

  // SECURITY: the hostname becomes part of an `rm -rf` path run as root. It
  // used to be interpolated unquoted, so a value with a space, `*`, `..` or a
  // `;` reached the shell. Only a strict DNS name is accepted, and it is
  // quoted (the glob stays outside the quotes).
  if (!isValidHostname(hostname)) {
    return { ok: false, message: 'This website does not have a valid hostname to renew a certificate for.' }
  }
  const hostDir = shellQuote(hostname.toLowerCase())

  try {
    const creds = await getServerCredentials(project.serverId!)
    let cert: CertProbe = { ok: false }
    await withConnection(creds, async (client) => {
      // Mark as renewing
      await db.project.update({
        where: { id: projectId },
        data: { sslCertStatus: 'renewing' },
      })
      // Delete Caddy's on-disk cert for this hostname so it re-issues on reload
      await exec(
        client,
        `rm -rf /opt/deployhub/caddy/data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/${hostDir}/* 2>/dev/null; ` +
          `rm -rf /var/lib/caddy/.local/share/caddy/certificates/*/${hostDir}/* 2>/dev/null; true`,
        { timeoutMs: 10000 }
      )
      // Reload Caddy
      const r = await exec(client, 'systemctl reload caddy', { timeoutMs: 15000 })
      if (r.exitCode !== 0) {
        throw new Error(`Caddy reload failed: ${r.stderr}`)
      }
      // Issued only once a verified certificate is actually served; otherwise
      // 'pending' (Caddy keeps retrying in the background).
      cert = await recordCertificateStatus(client, projectId, hostname)
    })
    return cert.ok
      ? { ok: true, message: `Certificate renewed for ${hostname}` }
      : {
          ok: true,
          message: `Renewal requested for ${hostname}. The new certificate is not being served yet — it usually appears within a few minutes.`,
        }
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
