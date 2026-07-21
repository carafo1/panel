/**
 * Host-level server metrics, measured live over SSH.
 *
 * This is INFRASTRUCTURE data — what the physical/virtual machine is actually
 * doing right now. It is deliberately separate from plan quotas and from
 * per-customer usage: a plan's "10 GB storage" is a billing limit, not a
 * property of the host, and showing one in place of the other misleads
 * whoever is reading the dashboard.
 *
 *   host metrics   (this file)      → what the server is doing
 *   lib/usage.ts                    → what a customer is consuming
 *   Plan.* limits                   → what a customer is entitled to
 *
 * Extracted from the per-server stats route so the fleet-wide infrastructure
 * endpoint parses the same output the same way, rather than growing a second
 * copy of these parsers that silently drifts.
 */
import { db } from '@/lib/db'
import { withConnection, exec, isServerInDemoMode } from '@/lib/vps/ssh'
import { getServerCredentials } from '@/lib/vps/provisioner'

export interface CpuMetrics {
  cpuCount: number
  busyPercent: number
  userPercent: number
  systemPercent: number
  idlePercent: number
}

export interface MemoryMetrics {
  totalMB: number
  usedMB: number
  freeMB: number
  availableMB: number
  cacheMB: number
  swapTotalMB: number
  swapUsedMB: number
  usedPercent: number
}

export interface DiskMetrics {
  filesystem: string
  size: string
  used: string
  available: string
  usePercent: number
  mountedOn: string
}

export interface LoadMetrics {
  load1: number
  load5: number
  load15: number
  runningProcs: number
  totalProcs: number
}

export interface ContainerInfo {
  name: string
  status: string
  ports: string
}

export interface ContainerStat {
  name: string
  cpuPercent: number
  memUsage: string
  memPercent: number
}

export interface ServerMetrics {
  serverId: string
  serverName: string
  /** True when these numbers are simulated rather than measured. */
  demo: boolean
  /** Set when the server was unreachable — never silently reported as 0. */
  error?: string
  timestamp: string
  /** null when `top` output could not be parsed — never a fake 0%. */
  cpu: CpuMetrics | null
  memory: MemoryMetrics
  disk: DiskMetrics
  loadAvg: LoadMetrics
  uptime: { uptimeString: string; users: number }
  containers: ContainerInfo[]
  containerStats: ContainerStat[]
}

/* ── Parsers ───────────────────────────────────────────────────────── */

/**
 * Busy % from `top -bn1`; the line reports idle, so busy = 100 - idle.
 *
 * IMPORTANT: `top` formats numbers using the host's locale, so on a machine
 * with a European locale the line reads `90,7 id` rather than `90.7 id`. The
 * original regex only accepted `[\d.]+`, silently failed to match, and fell
 * back to a hardcoded 0% — so a busy server reported as completely idle. Both
 * separators are accepted, and an unparseable line now returns null instead of
 * a confident zero.
 */
export function parseCpuFromTop(
  topOut: string,
  nprocOut: string
): CpuMetrics | null {
  const cpuCount = parseInt(nprocOut.trim(), 10) || 1
  const num = String.raw`[\d]+(?:[.,][\d]+)?`
  const m = topOut.match(
    new RegExp(
      `%Cpu\\(s\\):\\s*(${num})\\s*us,\\s*(${num})\\s*sy,\\s*(${num})\\s*ni,\\s*(${num})\\s*id`
    )
  )
  if (!m) return null

  const n = (v: string) => parseFloat(v.replace(',', '.'))
  const idle = n(m[4])
  return {
    cpuCount,
    busyPercent: Math.round((100 - idle) * 10) / 10,
    userPercent: n(m[1]),
    systemPercent: n(m[2]),
    idlePercent: idle,
  }
}

/**
 * CPU busy % from two /proc/stat samples taken a short interval apart.
 *
 * PREFERRED over parseCpuFromTop. `top -bn1` run over SSH reports the CPU
 * spike caused by starting the SSH session and top itself — measured against
 * this host it read ~55% while the machine was genuinely ~5% busy, a 10x
 * overstatement that would have had an operator chasing a non-existent load
 * problem. /proc/stat deltas measure a real interval, contain no locale-
 * formatted decimals, and cost nothing.
 *
 * Input is the concatenation of two `cat /proc/stat` runs.
 */
export function parseCpuFromProcStat(
  procStatOut: string,
  nprocOut: string
): CpuMetrics | null {
  const cpuCount = parseInt(nprocOut.trim(), 10) || 1

  // Aggregate "cpu " lines only (not per-core "cpu0", "cpu1", …).
  const samples = procStatOut
    .split('\n')
    .filter((l) => /^cpu\s/.test(l))
    .map((l) => l.trim().split(/\s+/).slice(1).map((v) => parseInt(v, 10) || 0))

  if (samples.length < 2) return null

  const [a, b] = [samples[0], samples[samples.length - 1]]
  // Fields: user nice system idle iowait irq softirq steal ...
  const total = (s: number[]) => s.reduce((x, y) => x + y, 0)
  const idleOf = (s: number[]) => (s[3] ?? 0) + (s[4] ?? 0) // idle + iowait

  const totalDelta = total(b) - total(a)
  const idleDelta = idleOf(b) - idleOf(a)
  if (totalDelta <= 0) return null

  const busy = ((totalDelta - idleDelta) / totalDelta) * 100
  const userDelta = (b[0] ?? 0) - (a[0] ?? 0)
  const sysDelta = (b[2] ?? 0) - (a[2] ?? 0)

  return {
    cpuCount,
    busyPercent: Math.round(Math.max(0, Math.min(100, busy)) * 10) / 10,
    userPercent: Math.round((userDelta / totalDelta) * 1000) / 10,
    systemPercent: Math.round((sysDelta / totalDelta) * 1000) / 10,
    idlePercent: Math.round((idleDelta / totalDelta) * 1000) / 10,
  }
}

export function parseMemoryFromFree(freeOut: string): MemoryMetrics {
  const lines = freeOut.split('\n')
  const mem = lines.find((l) => /^Mem:/.test(l))
  const swap = lines.find((l) => /^Swap:/.test(l))
  const m = mem ? mem.split(/\s+/).slice(1).map(Number) : []
  const s = swap ? swap.split(/\s+/).slice(1).map(Number) : []
  const totalMB = m[0] ?? 0
  const usedMB = m[1] ?? 0
  const freeMB = m[2] ?? 0
  return {
    totalMB,
    usedMB,
    freeMB,
    cacheMB: m[4] ?? 0,
    availableMB: m[5] ?? freeMB,
    swapTotalMB: s[0] ?? 0,
    swapUsedMB: s[1] ?? 0,
    usedPercent: totalMB > 0 ? Math.round((usedMB / totalMB) * 1000) / 10 : 0,
  }
}

export function parseDiskFromDf(dfOut: string): DiskMetrics {
  const lines = dfOut.trim().split('\n')
  if (lines.length < 2) {
    return { filesystem: '', size: '', used: '', available: '', usePercent: 0, mountedOn: '' }
  }
  const p = lines[1].split(/\s+/)
  return {
    filesystem: p[0] ?? '',
    size: p[1] ?? '',
    used: p[2] ?? '',
    available: p[3] ?? '',
    usePercent: parseInt((p[4] ?? '0').replace('%', ''), 10) || 0,
    mountedOn: p[5] ?? '/',
  }
}

export function parseLoadAvg(out: string): LoadMetrics {
  const p = out.trim().split(/\s+/)
  const rt = p[3] ? p[3].split('/') : ['0', '0']
  return {
    load1: parseFloat(p[0] ?? '0') || 0,
    load5: parseFloat(p[1] ?? '0') || 0,
    load15: parseFloat(p[2] ?? '0') || 0,
    runningProcs: parseInt(rt[0] ?? '0', 10) || 0,
    totalProcs: parseInt(rt[1] ?? '0', 10) || 0,
  }
}

export function parseUptime(out: string): { uptimeString: string; users: number } {
  const up = out.match(/up\s+(.+?),\s+\d+\s+users?/)
  const users = out.match(/(\d+)\s+users?/)
  return {
    uptimeString: up ? up[1].trim() : out.trim(),
    users: users ? parseInt(users[1], 10) : 0,
  }
}

export function parseDockerPs(out: string): ContainerInfo[] {
  return out
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const [name, status, ports] = line.split('\t')
      return { name: name ?? '', status: status ?? '', ports: ports ?? '' }
    })
}

export function parseDockerStats(out: string): ContainerStat[] {
  return out
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

/* ── Collection ────────────────────────────────────────────────────── */

function demoMetrics(server: {
  id: string
  name: string
  cpuCores: number
  ramGB: number
  storageGB: number
}): ServerMetrics {
  const usedMB = Math.round(server.ramGB * 1024 * 0.4)
  return {
    serverId: server.id,
    serverName: server.name,
    demo: true,
    timestamp: new Date().toISOString(),
    cpu: {
      cpuCount: server.cpuCores,
      busyPercent: 28.4,
      userPercent: 18.2,
      systemPercent: 6.1,
      idlePercent: 71.6,
    },
    memory: {
      totalMB: server.ramGB * 1024,
      usedMB,
      freeMB: server.ramGB * 1024 - usedMB,
      availableMB: server.ramGB * 1024 - usedMB,
      cacheMB: 0,
      swapTotalMB: 0,
      swapUsedMB: 0,
      usedPercent: 40,
    },
    disk: {
      filesystem: '/dev/vda1',
      size: `${server.storageGB}G`,
      used: `${Math.round(server.storageGB * 0.3)}G`,
      available: `${Math.round(server.storageGB * 0.7)}G`,
      usePercent: 30,
      mountedOn: '/',
    },
    loadAvg: { load1: 0.4, load5: 0.35, load15: 0.3, runningProcs: 2, totalProcs: 120 },
    uptime: { uptimeString: 'demo', users: 0 },
    containers: [],
    containerStats: [],
  }
}

/**
 * Measure one server. Never throws: an unreachable host returns `error` set,
 * so the caller can show "unreachable" instead of a confident 0%.
 */
export async function getServerMetrics(serverId: string): Promise<ServerMetrics | null> {
  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) return null

  if (isServerInDemoMode(server)) return demoMetrics(server)

  try {
    const creds = await getServerCredentials(server.id)
    const raw = await withConnection(creds, async (client) => {
      // The CPU sample runs ALONE and FIRST, before the other commands.
      //
      // Running it inside the Promise.all below made it overlap
      // `docker stats`, which walks every container and is expensive: on a
      // host with 21 containers the dashboard reported ~55% CPU while the
      // machine was genuinely ~6% busy. It was accurately measuring the load
      // its own polling created. Isolating the sampling window fixes that.
      const cpuSample = await exec(
        client,
        'cat /proc/stat; sleep 0.5; cat /proc/stat',
        { timeoutMs: 15000 }
      )

      const [free, df, ps, dstats, up, nproc, load] = await Promise.all([
        exec(client, 'free -m', { timeoutMs: 10000 }),
        exec(client, 'df -h /', { timeoutMs: 10000 }),
        exec(client, "docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'", {
          timeoutMs: 15000,
        }),
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
        top: cpuSample.stdout,
        free: free.stdout,
        df: df.stdout,
        ps: ps.stdout,
        dstats: dstats.stdout,
        up: up.stdout,
        nproc: nproc.stdout,
        load: load.stdout,
      }
    })

    return {
      serverId: server.id,
      serverName: server.name,
      demo: false,
      timestamp: new Date().toISOString(),
      cpu: parseCpuFromProcStat(raw.top, raw.nproc),
      memory: parseMemoryFromFree(raw.free),
      disk: parseDiskFromDf(raw.df),
      loadAvg: parseLoadAvg(raw.load),
      uptime: parseUptime(raw.up),
      containers: parseDockerPs(raw.ps),
      containerStats: parseDockerStats(raw.dstats),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[host-metrics] failed for', server.id, message)
    // Reporting zeros here would render as a healthy, idle server.
    return {
      serverId: server.id,
      serverName: server.name,
      demo: false,
      error: message.slice(0, 200),
      timestamp: new Date().toISOString(),
      cpu: null,
      memory: {
        totalMB: 0,
        usedMB: 0,
        freeMB: 0,
        availableMB: 0,
        cacheMB: 0,
        swapTotalMB: 0,
        swapUsedMB: 0,
        usedPercent: 0,
      },
      disk: { filesystem: '', size: '', used: '', available: '', usePercent: 0, mountedOn: '' },
      loadAvg: { load1: 0, load5: 0, load15: 0, runningProcs: 0, totalProcs: 0 },
      uptime: { uptimeString: 'unreachable', users: 0 },
      containers: [],
      containerStats: [],
    }
  }
}

/** Measure every server in the fleet, in parallel. */
export async function getFleetMetrics(): Promise<ServerMetrics[]> {
  const servers = await db.server.findMany({ select: { id: true } })
  const all = await Promise.all(servers.map((s) => getServerMetrics(s.id)))
  return all.filter((m): m is ServerMetrics => m !== null)
}
