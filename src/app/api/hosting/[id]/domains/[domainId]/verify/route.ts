import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequestFresh } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import { logAudit } from '@/lib/audit'
import {
  checkOwnership,
  getServerIps,
  generateVerificationToken,
  findConflict,
  VERIFY_PREFIX,
  probeHttps,
  describeConnection,
  ensureZoneForDomain,
} from '@/lib/custom-domains'
import { APSAMO_NAMESERVERS } from '@/lib/dns-zones'
import { configureProjectProxy } from '@/lib/vps/proxy'

/**
 * POST /api/hosting/[id]/domains/[domainId]/verify
 *
 * Prove the customer controls an attached custom domain, and only then put it
 * into the reverse proxy.
 *
 * This is the gate that makes external domains safe. Attaching a domain is
 * just a database row; nothing is served until this succeeds. On success the
 * domain is marked verified, promoted to `project.customDomain` if it is the
 * primary, and the Caddy config is regenerated so it starts serving with
 * automatic HTTPS.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; domainId: string }> }
) {
  try {
    const decoded = await authenticateRequestFresh(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, domainId } = await params

    const project = await db.project.findFirst({
      where: isAdmin(decoded.role)
        ? { id: projectId }
        : { id: projectId, userId: decoded.userId },
    })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const row = await db.websiteDomain.findFirst({
      where: { id: domainId, projectId },
    })
    if (!row) {
      return NextResponse.json({ error: 'Domain not found' }, { status: 404 })
    }

    if (row.verified) {
      return NextResponse.json({
        verified: true,
        message: `${row.domain} is already verified and live.`,
      })
    }

    // Re-check conflicts at verify time too: another project could have
    // claimed and verified this hostname while this row sat pending.
    const conflict = await findConflict(row.domain, projectId)
    if (conflict.conflict) {
      return NextResponse.json(
        {
          verified: false,
          error: `${row.domain} is now in use elsewhere on this platform and cannot be verified here.`,
        },
        { status: 409 }
      )
    }

    // A row created before this feature existed has no token — mint one so
    // the customer has something to publish.
    let token = row.verificationToken
    if (!token) {
      token = generateVerificationToken()
      await db.websiteDomain.update({
        where: { id: row.id },
        data: { verificationToken: token },
      })
    }

    const serverIps = await getServerIps()
    const result = await checkOwnership({
      domain: row.domain,
      token,
      serverIps,
      method: row.connectionMethod,
    })

    if (!result.verified) {
      await db.websiteDomain.update({
        where: { id: row.id },
        data: { lastCheckedAt: new Date(), lastCheckError: result.detail.slice(0, 300) },
      })
      return NextResponse.json(
        {
          verified: false,
          message: result.detail,
          // Nameservers first — this is the default path and needs no DNS
          // knowledge. The record options are only for the advanced flow.
          nameservers: APSAMO_NAMESERVERS,
          advanced: {
            txtRecord: {
              type: 'TXT',
              name: `${VERIFY_PREFIX}.${row.domain}`,
              value: token,
            },
            aRecord: { type: 'A', name: row.domain, value: serverIps },
          },
        },
        { status: 200 }
      )
    }

    // ── Verified ──────────────────────────────────────────────────────
    await db.websiteDomain.update({
      where: { id: row.id },
      data: {
        verified: true,
        verifiedAt: new Date(),
        verificationMethod: result.method,
        lastCheckedAt: new Date(),
        lastCheckError: null,
        sslStatus: row.sslEnabled ? 'pending' : 'none',
      },
    })

    // Delegated to us → publish the zone before anything else, since we are
    // now the authoritative answer for this domain.
    let zoneDetail = ''
    if (result.method === 'nameserver') {
      const zone = await ensureZoneForDomain({
        domainRowId: row.id,
        domain: row.domain,
      }).catch((err) => ({ ok: false, detail: String(err) }))
      zoneDetail = zone.detail
      if (!zone.ok) console.error('[domain-verify] zone creation failed:', zone.detail)
    }

    // Only now does the hostname enter the proxy. Promoting the primary
    // writes `project.customDomain`, which is what the Caddy generator emits.
    if (row.isPrimary) {
      await db.project.update({
        where: { id: projectId },
        data: { customDomain: row.domain },
      })
    }

    let served = false
    let proxyDetail = ''
    try {
      const proxied = await configureProjectProxy(projectId)
      served = proxied.ok
      proxyDetail = proxied.message || ''
    } catch (err) {
      proxyDetail = err instanceof Error ? err.message : String(err)
      console.error('[domain-verify] proxy reload failed:', proxyDetail)
    }

    // Trigger AND confirm the certificate in one step. Caddy issues lazily on
    // the first request, so probing here means "Verify Now" usually lands the
    // customer straight on Live instead of leaving them at "Issuing SSL".
    let sslIssued = false
    if (served && row.sslEnabled) {
      const probe = await probeHttps(row.domain)
      sslIssued = probe.ok
      await db.websiteDomain
        .update({
          where: { id: row.id },
          data: {
            sslStatus: probe.ok ? 'issued' : 'pending',
            lastCheckError: probe.ok ? null : (probe.error?.slice(0, 300) ?? null),
          },
        })
        .catch(() => {})
    }

    await logAudit({
      userId: decoded.userId,
      action: 'project.domain.verify',
      resource: 'project',
      resourceId: projectId,
      req: request,
      metadata: { domain: row.domain, method: result.method, served },
    }).catch(() => {})

    const fresh = await db.websiteDomain.findUnique({ where: { id: row.id } })
    return NextResponse.json({
      verified: true,
      method: result.method,
      served,
      sslIssued,
      zoneDetail,
      connection: fresh ? describeConnection(fresh) : null,
      message: !served
        ? `${row.domain} is verified, but the web server could not be reloaded yet${proxyDetail ? `: ${proxyDetail}` : ''}. It will be picked up on the next deploy.`
        : sslIssued
          ? `${row.domain} is live over HTTPS with a valid certificate.`
          : `${row.domain} is verified and being served. The certificate is still being issued — this usually takes a few seconds.`,
      detail: result.detail,
    })
  } catch (error) {
    console.error('[domain-verify] failed:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
