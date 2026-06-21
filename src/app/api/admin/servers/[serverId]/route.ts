import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { encrypt } from '@/lib/encryption'

/**
 * GET/PATCH/DELETE /api/admin/servers/[serverId]
 *
 * Admin-only management of a single Server row. NEVER returns raw SSH
 * credentials — only presence flags (hasSshKey / hasSshPassword).
 */

// ─── Auth + admin guard ───────────────────────────────────────────────────
async function requireAdmin(request: Request) {
  const authHeader = request.headers.get('Authorization')
  const token = extractTokenFromHeader(authHeader)
  if (!token) {
    return {
      error: NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      ),
    }
  }
  const decoded = verifyToken(token)
  if (!decoded) {
    return {
      error: NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      ),
    }
  }
  if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
    return {
      error: NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      ),
    }
  }
  return { decoded }
}

// ─── Serializer (presence flags, never raw creds) ─────────────────────────
function serializeServer(s: {
  id: string
  name: string
  ip: string
  provider: string
  status: string
  cpuCores: number
  ramGB: number
  storageGB: number
  bandwidthGB: number
  usedRamGB: number
  usedStorageGB: number
  region: string
  sshHost: string
  sshPort: number
  sshUser: string
  sshPrivateKey: string | null
  sshPassword: string | null
  sshFingerprint: string | null
  dockerInstalled: boolean
  caddyInstalled: boolean
  firewallConfigured: boolean
  caddyVersion: string | null
  dockerVersion: string | null
  osInfo: string | null
  lastProvisionedAt: Date | null
  lastHealthCheckAt: Date | null
  healthStatus: string
  deployedPublicKey: string | null
  createdAt: Date
  updatedAt: Date
  _count?: { projects: number }
}) {
  return {
    id: s.id,
    name: s.name,
    ip: s.ip,
    provider: s.provider,
    status: s.status,
    cpuCores: s.cpuCores,
    ramGB: s.ramGB,
    storageGB: s.storageGB,
    bandwidthGB: s.bandwidthGB,
    usedRamGB: s.usedRamGB,
    usedStorageGB: s.usedStorageGB,
    region: s.region,
    sshHost: s.sshHost,
    sshPort: s.sshPort,
    sshUser: s.sshUser,
    hasSshKey: !!s.sshPrivateKey,
    hasSshPassword: !!s.sshPassword,
    sshFingerprint: s.sshFingerprint,
    dockerInstalled: s.dockerInstalled,
    caddyInstalled: s.caddyInstalled,
    firewallConfigured: s.firewallConfigured,
    caddyVersion: s.caddyVersion,
    dockerVersion: s.dockerVersion,
    osInfo: s.osInfo,
    lastProvisionedAt: s.lastProvisionedAt?.toISOString() ?? null,
    lastHealthCheckAt: s.lastHealthCheckAt?.toISOString() ?? null,
    healthStatus: s.healthStatus,
    deployedPublicKey: s.deployedPublicKey,
    projectCount: s._count?.projects ?? 0,
    ramUsagePercent: s.ramGB > 0 ? Math.round((s.usedRamGB / s.ramGB) * 100) : 0,
    storageUsagePercent:
      s.storageGB > 0 ? Math.round((s.usedStorageGB / s.storageGB) * 100) : 0,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

// ─── GET ───────────────────────────────────────────────────────────────────
export async function GET(
  request: Request,
  { params }: { params: Promise<{ serverId: string }> }
) {
  try {
    const guard = await requireAdmin(request)
    if ('error' in guard) return guard.error
    const { decoded } = guard

    const { serverId } = await params
    const server = await db.server.findUnique({
      where: { id: serverId },
      include: { _count: { select: { projects: true } } },
    })

    if (!server) {
      return NextResponse.json(
        { error: 'Server not found' },
        { status: 404 }
      )
    }

    await logAudit({
      userId: decoded.userId,
      action: 'server.view',
      resource: 'server',
      resourceId: serverId,
      req: request,
      metadata: { name: server.name },
    })

    return NextResponse.json({ server: serializeServer(server) })
  } catch (error) {
    console.error('Admin server GET error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

// ─── PATCH ─────────────────────────────────────────────────────────────────
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ serverId: string }> }
) {
  try {
    const guard = await requireAdmin(request)
    if ('error' in guard) return guard.error
    const { decoded } = guard

    const { serverId } = await params
    const server = await db.server.findUnique({ where: { id: serverId } })
    if (!server) {
      return NextResponse.json(
        { error: 'Server not found' },
        { status: 404 }
      )
    }

    const body = await request.json().catch(() => ({} as Record<string, unknown>))
    const {
      name,
      ip,
      provider,
      sshHost,
      sshPort,
      sshUser,
      sshPassword,
      sshPrivateKey,
      sshFingerprint,
      cpuCores,
      ramGB,
      storageGB,
      bandwidthGB,
      region,
      status,
      deployedPublicKey,
    } = body as Record<string, unknown>

    const updateData: Record<string, unknown> = {}

    // Plain string/number fields
    if (typeof name === 'string' && name.trim()) updateData.name = name.trim()
    if (typeof ip === 'string' && ip.trim()) updateData.ip = ip.trim()
    if (typeof provider === 'string') updateData.provider = provider
    if (typeof sshHost === 'string') updateData.sshHost = sshHost
    if (typeof sshPort === 'number') updateData.sshPort = sshPort
    if (typeof sshUser === 'string') updateData.sshUser = sshUser
    if (typeof sshFingerprint === 'string') updateData.sshFingerprint = sshFingerprint || null
    if (typeof cpuCores === 'number' && cpuCores > 0) updateData.cpuCores = cpuCores
    if (typeof ramGB === 'number' && ramGB > 0) updateData.ramGB = ramGB
    if (typeof storageGB === 'number' && storageGB > 0) updateData.storageGB = storageGB
    if (typeof bandwidthGB === 'number') updateData.bandwidthGB = bandwidthGB
    if (typeof region === 'string') updateData.region = region
    if (typeof deployedPublicKey === 'string') {
      updateData.deployedPublicKey = deployedPublicKey || null
    }
    // Status — validate against known set
    if (typeof status === 'string') {
      const allowed = ['active', 'maintenance', 'offline', 'provisioning']
      if (!allowed.includes(status)) {
        return NextResponse.json(
          { error: `Invalid status. Allowed: ${allowed.join(', ')}` },
          { status: 400 }
        )
      }
      updateData.status = status
    }

    // ── Credentials ────────────────────────────────────────────────────
    // Empty string → clear; non-empty string → re-encrypt; absent → leave alone.
    if (typeof sshPassword === 'string') {
      updateData.sshPassword = sshPassword.length > 0 ? encrypt(sshPassword) : null
    }
    if (typeof sshPrivateKey === 'string') {
      updateData.sshPrivateKey =
        sshPrivateKey.length > 0 ? encrypt(sshPrivateKey) : null
    }

    const updated = await db.server.update({
      where: { id: serverId },
      data: updateData as Parameters<typeof db.server.update>[0]['data'],
      include: { _count: { select: { projects: true } } },
    })

    await logAudit({
      userId: decoded.userId,
      action: 'server.update',
      resource: 'server',
      resourceId: serverId,
      req: request,
      metadata: {
        name: updated.name,
        changedFields: Object.keys(updateData),
        // Don't log raw credential values — only whether they changed.
        credentialsChanged:
          'sshPassword' in updateData || 'sshPrivateKey' in updateData,
      },
    })

    return NextResponse.json({ server: serializeServer(updated) })
  } catch (error) {
    console.error('Admin server PATCH error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

// ─── DELETE ────────────────────────────────────────────────────────────────
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ serverId: string }> }
) {
  try {
    const guard = await requireAdmin(request)
    if ('error' in guard) return guard.error
    const { decoded } = guard

    const { serverId } = await params
    const server = await db.server.findUnique({
      where: { id: serverId },
      include: { _count: { select: { projects: true } } },
    })
    if (!server) {
      return NextResponse.json(
        { error: 'Server not found' },
        { status: 404 }
      )
    }

    // Refuse if any projects are still attached — caller must reassign first.
    if (server._count.projects > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete server: ${server._count.projects} project(s) are still attached. Reassign or delete them first.`,
        },
        { status: 409 }
      )
    }

    await db.server.delete({ where: { id: serverId } })

    await logAudit({
      userId: decoded.userId,
      action: 'server.delete',
      resource: 'server',
      resourceId: serverId,
      req: request,
      metadata: { name: server.name, ip: server.ip },
    })

    return NextResponse.json({
      message: 'Server deleted successfully',
      serverId,
    })
  } catch (error) {
    console.error('Admin server DELETE error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
