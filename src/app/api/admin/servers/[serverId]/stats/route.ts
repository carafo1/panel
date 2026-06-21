import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import {
  withConnection,
  exec,
  isVpsDemoMode,
  isServerInDemoMode,
} from '@/lib/vps/ssh'
import { getServerCredentials } from '@/lib/vps/provisioner'

/**
 * GET /api/admin/servers/[serverId]/stats
 *
 * Real-time server metrics pulled live over SSH:
 *   - CPU load average + per-core busy % (from `top`)
 *   - Memory usage (from `free -m`)
 *   - Disk usage on / (from `df -h /`)
 *   - Docker container list (from `docker ps`)
 *   - Per-container CPU/mem stats (from `docker stats --no-stream`)
 *   - Uptime + load avg (from `uptime`)
 *
 * In DEMO MODE (VPS_DEMO_MODE=1 or no sshHost), returns realistic simulated
 * stats so the admin UI works end-to-end.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ serverId: string }> }
) {
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

    const { serverId } = await params
    const server = await db.server.findUnique({ where: { id: serverId } })
    if (!server) {
      return NextResponse.json(
        { error: 'Server not found' },
        { status: 404 }
      )
    }

    // ── Demo mode: simulated realistic stats ───────────────────────────
    if (isServerInDemoMode(server)) {
      return NextResponse.json(buildDemoStats(server))
    }

    // ── Live SSH stats ──────────────────────────────────────────────────
    const creds = await getServerCredentials(serverId)
    const stats = await withConnection(creds, async (client) => {
      // Run every command in parallel for speed — each opens its own exec
      // channel over the same SSH connection.
      const [top, free, df, dockerPs, dockerStats, uptime, nproc, loadavg] =
        await Promise.all([
          exec(client, 'top -bn1 | head -5', { timeoutMs: 15000 }),
          exec(client, 'free -m', { timeoutMs: 10000 }),
          exec(client, 'df -h /', { timeoutMs: 10000 }),
          exec(
            client,
            "docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'",
            { timeoutMs: 15000 }
          ),
          exec(
            client,
            "docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'",
            { timeoutMs: 30000 }
          ),
          exec(client, 'uptime', { timeoutMs: 10000 }),
          exec(client, 'nproc', { timeoutMs: 10000 }),
          exec(client, 'cat /proc/loadavg', { timeoutMs: 10000 }),
        ])

      return {
        top: top.stdout,
        free: free.stdout,
        df: df.stdout,
        dockerPs: dockerPs.stdout,
        dockerStats: dockerStats.stdout,
        uptime: uptime.stdout,
        nproc: nproc.stdout,
        loadavg: loadavg.stdout,
      }
    })

    return NextResponse.json({
      serverId,
      demo: false,
      timestamp: new Date().toISOString(),
      cpu: parseCpuFromTop(stats.top, stats.nproc),
      memory: parseMemoryFromFree(stats.free),
      disk: parseDiskFromDf(stats.df),
      loadAvg: parseLoadAvg(stats.loadavg),
      uptime: parseUptime(stats.uptime),
      containers: parseDockerPs(stats.dockerPs),
      containerStats: parseDockerStats(stats.dockerStats),
      raw: {
        top: stats.top,
        free: stats.free,
        df: stats.df,
        uptime: stats.uptime,
      },
    })
  } catch (error) {
    console.error('Admin server stats error:', error)
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

// ─── Parsers ───────────────────────────────────────────────────────────────

/**
 * Extract the CPU busy percentage from `top -bn1 | head -5`.
 * The `%Cpu(s):  ... us,  ... sy,  ... id` line gives us idle %; busy = 100 - id.
 */
function parseCpuFromTop(topOut: string, nprocOut: string): {
  cpuCount: number
  busyPercent: number
  userPercent: number
  systemPercent: number
  idlePercent: number
} {
  const cpuCount = parseInt(nprocOut.trim(), 10) || 1
  const idleMatch = topOut.match(/%Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy,\s*([\d.]+)\s*ni,\s*([\d.]+)\s*id/)
  if (idleMatch) {
    const user = parseFloat(idleMatch[1])
    const system = parseFloat(idleMatch[2])
    const idle = parseFloat(idleMatch[4])
    return {
      cpuCount,
      busyPercent: Math.round((100 - idle) * 10) / 10,
      userPercent: user,
      systemPercent: system,
      idlePercent: idle,
    }
  }
  return { cpuCount, busyPercent: 0, userPercent: 0, systemPercent: 0, idlePercent: 100 }
}

/**
 * Parse `free -m` output into structured memory info.
 * Example:
 *                total        used        free      shared  buff/cache   available
 * Mem:            7976        3214         832         142        3929        4321
 * Swap:           2047           0        2047
 */
function parseMemoryFromFree(freeOut: string): {
  totalMB: number
  usedMB: number
  freeMB: number
  availableMB: number
  cacheMB: number
  swapTotalMB: number
  swapUsedMB: number
  usedPercent: number
} {
  const lines = freeOut.split('\n')
  const memLine = lines.find((l) => /^Mem:/.test(l))
  const swapLine = lines.find((l) => /^Swap:/.test(l))

  const memParts = memLine ? memLine.split(/\s+/).slice(1).map(Number) : []
  const swapParts = swapLine ? swapLine.split(/\s+/).slice(1).map(Number) : []

  const totalMB = memParts[0] ?? 0
  const usedMB = memParts[1] ?? 0
  const freeMB = memParts[2] ?? 0
  const cacheMB = memParts[4] ?? 0
  const availableMB = memParts[5] ?? freeMB
  const swapTotalMB = swapParts[0] ?? 0
  const swapUsedMB = swapParts[1] ?? 0

  return {
    totalMB,
    usedMB,
    freeMB,
    availableMB,
    cacheMB,
    swapTotalMB,
    swapUsedMB,
    usedPercent: totalMB > 0 ? Math.round((usedMB / totalMB) * 1000) / 10 : 0,
  }
}

/**
 * Parse `df -h /` output.
 * Example:
 * Filesystem      Size  Used Avail Use% Mounted on
 * /dev/vda1        80G   24G   54G  31% /
 */
function parseDiskFromDf(dfOut: string): {
  filesystem: string
  size: string
  used: string
  available: string
  usePercent: number
  mountedOn: string
} {
  const lines = dfOut.trim().split('\n')
  if (lines.length < 2) {
    return {
      filesystem: '',
      size: '',
      used: '',
      available: '',
      usePercent: 0,
      mountedOn: '',
    }
  }
  const parts = lines[1].split(/\s+/)
  return {
    filesystem: parts[0] ?? '',
    size: parts[1] ?? '',
    used: parts[2] ?? '',
    available: parts[3] ?? '',
    usePercent: parseInt((parts[4] ?? '0').replace('%', ''), 10) || 0,
    mountedOn: parts[5] ?? '/',
  }
}

/**
 * Parse `/proc/loadavg`. Example:
 *   0.42 0.38 0.31 3/421 12345
 */
function parseLoadAvg(loadavgOut: string): {
  load1: number
  load5: number
  load15: number
  runningProcs: number
  totalProcs: number
} {
  const parts = loadavgOut.trim().split(/\s+/)
  const runningTotal = parts[3] ? parts[3].split('/') : ['0', '0']
  return {
    load1: parseFloat(parts[0] ?? '0') || 0,
    load5: parseFloat(parts[1] ?? '0') || 0,
    load15: parseFloat(parts[2] ?? '0') || 0,
    runningProcs: parseInt(runningTotal[0] ?? '0', 10) || 0,
    totalProcs: parseInt(runningTotal[1] ?? '0', 10) || 0,
  }
}

/**
 * Parse `uptime` for the human-readable uptime string.
 * Example: ` 14:23:01 up 12 days,  3:45,  2 users,  load average: 0.42, 0.38, 0.31`
 */
function parseUptime(uptimeOut: string): {
  uptimeString: string
  users: number
} {
  const upMatch = uptimeOut.match(/up\s+(.+?),\s+\d+\s+users?/)
  const usersMatch = uptimeOut.match(/(\d+)\s+users?/)
  return {
    uptimeString: upMatch ? upMatch[1].trim() : uptimeOut.trim(),
    users: usersMatch ? parseInt(usersMatch[1], 10) : 0,
  }
}

/**
 * Parse `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`.
 */
function parseDockerPs(psOut: string): Array<{
  name: string
  status: string
  ports: string
}> {
  return psOut
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [name, status, ports] = line.split('\t')
      return {
        name: name ?? '',
        status: status ?? '',
        ports: ports ?? '',
      }
    })
}

/**
 * Parse `docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'`.
 * Example: `deployhub-myapp\t0.42%\t25.5MiB / 7.78GiB\t0.32%`
 */
function parseDockerStats(statsOut: string): Array<{
  name: string
  cpuPercent: number
  memUsage: string
  memPercent: number
}> {
  return statsOut
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [name, cpu, memUsage, memPerc] = line.split('\t')
      return {
        name: name ?? '',
        cpuPercent: parseFloat((cpu ?? '0%').replace('%', '')) || 0,
        memUsage: memUsage ?? '',
        memPercent: parseFloat((memPerc ?? '0%').replace('%', '')) || 0,
      }
    })
}

// ─── Demo stats generator ──────────────────────────────────────────────────

function buildDemoStats(server: {
  id: string
  cpuCores: number
  ramGB: number
  storageGB: number
}): unknown {
  const usedRam = Math.round(server.ramGB * 0.4 * 10) / 10
  const usedDisk = Math.round(server.storageGB * 0.3 * 10) / 10
  const now = new Date().toISOString()
  return {
    serverId: server.id,
    demo: true,
    timestamp: now,
    cpu: {
      cpuCount: server.cpuCores,
      busyPercent: 28.4,
      userPercent: 18.2,
      systemPercent: 6.1,
      idlePercent: 71.6,
    },
    memory: {
      totalMB: server.ramGB * 1024,
      usedMB: usedRam * 1024,
      freeMB: (server.ramGB - usedRam) * 1024,
      availableMB: (server.ramGB - usedRam * 0.7) * 1024,
      cacheMB: usedRam * 0.4 * 1024,
      swapTotalMB: 2048,
      swapUsedMB: 0,
      usedPercent: Math.round((usedRam / server.ramGB) * 1000) / 10,
    },
    disk: {
      filesystem: '/dev/vda1',
      size: `${server.storageGB}G`,
      used: `${usedDisk}G`,
      available: `${server.storageGB - usedDisk}G`,
      usePercent: Math.round((usedDisk / server.storageGB) * 100),
      mountedOn: '/',
    },
    loadAvg: {
      load1: 0.42,
      load5: 0.38,
      load15: 0.31,
      runningProcs: 2,
      totalProcs: 142,
    },
    uptime: {
      uptimeString: '12 days,  3:45',
      users: 1,
    },
    containers: [
      {
        name: 'deployhub-demo-app',
        status: 'Up 6 hours',
        ports: '0.0.0.0:8080->3000/tcp',
      },
      {
        name: 'caddy',
        status: 'Up 6 hours',
        ports: '0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp',
      },
    ],
    containerStats: [
      {
        name: 'deployhub-demo-app',
        cpuPercent: 0.42,
        memUsage: '25.5MiB / 7.78GiB',
        memPercent: 0.32,
      },
      {
        name: 'caddy',
        cpuPercent: 0.05,
        memUsage: '18.2MiB / 7.78GiB',
        memPercent: 0.23,
      },
    ],
    raw: {
      top: 'top - 14:23:01 up 12 days,  3:45,  1 user,  load average: 0.42, 0.38, 0.31\nTasks: 142 total,   2 running, 140 sleeping,   0 stopped,   0 zombie\n%Cpu(s): 18.2 us,  6.1 sy,  0.0 ni, 71.6 id,  3.8 wa,  0.0 hi,  0.3 si,  0.0 st\nMiB Mem :   7976.0 total,    832.5 free,   3214.1 used,   3929.4 buff/cache',
      free: '               total        used        free      shared  buff/cache   available\nMem:            7976        3214         832         142        3929        4321\nSwap:           2047           0        2047',
      df: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        80G   24G   54G  31% /',
      uptime: ' 14:23:01 up 12 days,  3:45,  1 user,  load average: 0.42, 0.38, 0.31',
    },
  }
}
