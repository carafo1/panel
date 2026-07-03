import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { encrypt } from '@/lib/encryption'

/**
 * Shared shape used by every admin server response. NEVER includes the raw
 * `sshPrivateKey` / `sshPassword` columns — only the boolean presence flags
 * `hasSshKey` / `hasSshPassword`.
 */
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
    // SSH connection info — presence flags only, never raw values
    sshHost: s.sshHost,
    sshPort: s.sshPort,
    sshUser: s.sshUser,
    hasSshKey: !!s.sshPrivateKey,
    hasSshPassword: !!s.sshPassword,
    sshFingerprint: s.sshFingerprint,
    // Provisioning state
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
    // Aggregates
    projectCount: s._count?.projects ?? 0,
    ramUsagePercent: s.ramGB > 0 ? Math.round((s.usedRamGB / s.ramGB) * 100) : 0,
    storageUsagePercent:
      s.storageGB > 0 ? Math.round((s.usedStorageGB / s.storageGB) * 100) : 0,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  }
}

// ─── GET /api/admin/servers ───────────────────────────────────────────────
export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // Admin role check (super_admin OR admin — backward compatible)
    if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      )
    }

    const servers = await db.server.findMany({
      include: {
        _count: {
          select: { projects: true },
        },
      },
      orderBy: { createdAt: 'asc' },
    })

    return NextResponse.json({
      servers: servers.map(serializeServer),
    })
  } catch (error) {
    console.error('Admin servers GET error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}

// ─── POST /api/admin/servers ──────────────────────────────────────────────
export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    if (decoded.role !== 'admin' && decoded.role !== 'super_admin') {
      return NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
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
      cpuCores,
      ramGB,
      storageGB,
      bandwidthGB,
      region,
    } = body as Record<string, unknown>

    // ── Required field validation ──────────────────────────────────────
    if (!name || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json(
        { error: 'name is required' },
        { status: 400 }
      )
    }
    if (!ip || typeof ip !== 'string' || !ip.trim()) {
      return NextResponse.json(
        { error: 'ip is required' },
        { status: 400 }
      )
    }
    if (typeof cpuCores !== 'number' || cpuCores <= 0) {
      return NextResponse.json(
        { error: 'cpuCores must be a positive number' },
        { status: 400 }
      )
    }
    if (typeof ramGB !== 'number' || ramGB <= 0) {
      return NextResponse.json(
        { error: 'ramGB must be a positive number' },
        { status: 400 }
      )
    }
    if (typeof storageGB !== 'number' || storageGB <= 0) {
      return NextResponse.json(
        { error: 'storageGB must be a positive number' },
        { status: 400 }
      )
    }

    // ── Build the create payload ───────────────────────────────────────
    const resolvedSshHost =
      typeof sshHost === 'string' && sshHost.trim() ? sshHost.trim() : String(ip).trim()

    const data: Record<string, unknown> = {
      name: String(name).trim(),
      ip: String(ip).trim(),
      provider: typeof provider === 'string' && provider.trim() ? provider.trim() : 'custom',
      cpuCores,
      ramGB,
      storageGB,
      bandwidthGB: typeof bandwidthGB === 'number' ? bandwidthGB : 1000,
      region: typeof region === 'string' && region.trim() ? region.trim() : 'unknown',
      sshHost: resolvedSshHost,
      sshPort: typeof sshPort === 'number' ? sshPort : 22,
      sshUser: typeof sshUser === 'string' && sshUser.trim() ? sshUser.trim() : 'root',
      // New servers start active; provisioning will overwrite to 'provisioning'
      // when provisionServer() runs.
      status: 'active',
      healthStatus: 'unknown',
    }

    // ── Encrypt credentials at rest ────────────────────────────────────
    if (typeof sshPassword === 'string' && sshPassword.length > 0) {
      data.sshPassword = encrypt(sshPassword)
    }
    if (typeof sshPrivateKey === 'string' && sshPrivateKey.length > 0) {
      data.sshPrivateKey = encrypt(sshPrivateKey)
    }

    const server = await db.server.create({
      data: data as Parameters<typeof db.server.create>[0]['data'],
      include: { _count: { select: { projects: true } } },
    })

    await logAudit({
      userId: decoded.userId,
      action: 'server.create',
      resource: 'server',
      resourceId: server.id,
      req: request,
      metadata: {
        name: server.name,
        ip: server.ip,
        sshHost: server.sshHost,
        hasSshKey: !!server.sshPrivateKey,
        hasSshPassword: !!server.sshPassword,
      },
    })

    return NextResponse.json(
      { server: serializeServer(server) },
      { status: 201 }
    )
  } catch (error) {
    console.error('Admin servers POST error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: 'Internal server error',
      },
      { status: 500 }
    )
  }
}
