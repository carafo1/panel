/**
 * Resources Module
 * ================
 *
 * Returns real-time CPU/RAM/storage/network usage for a project's running
 * container. Used by the panel's "Resources" tab to render live charts and
 * current-usage cards.
 *
 * In REAL mode we SSH to the VPS and run:
 *
 *   docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}'
 *   df -h <deployPath> | tail -1
 *
 * then parse the output. Allocated limits come from `project.resourceCpuCores`,
 * `resourceRamMB`, `resourceStorageGB` (snapshot of the user's plan at
 * project-creation time).
 *
 * In DEMO mode we generate a plausible random-walk within the allocated
 * limits so the UI's charts look alive without a real VPS.
 *
 * `getProjectResourceHistory` synthesizes 24 hourly data points from the
 * current usage with some jitter — we don't persist continuous metrics,
 * so this is a best-effort approximation for charting purposes.
 */
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  isServerInDemoMode,
  type SshCredentials,
} from './ssh'
import { getServerCredentials } from './provisioner'

// ─── Types ───────────────────────────────────────────────────────────────

export interface ResourceUsage {
  /** Allocated CPU cores (from plan). */
  cpuCores: number
  /** Current CPU usage percent (0..100 * cores). */
  cpuPercent: number
  /** Allocated RAM in MB. */
  ramMB: number
  /** Current RAM used in MB. */
  ramUsedMB: number
  /** Allocated storage in GB. */
  storageGB: number
  /** Current storage used in GB. */
  storageUsedGB: number
  /** Cumulative network RX bytes since container start. */
  networkRxBytes: number
  /** Cumulative network TX bytes since container start. */
  networkTxBytes: number
  /** Container uptime in seconds. */
  uptimeSeconds: number
  status: 'running' | 'stopped' | 'error'
}

export interface ResourceHistoryPoint {
  timestamp: string
  cpuPercent: number
  ramUsedMB: number
  storageUsedGB: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseDfRow(line: string): { usedGB: number; totalGB: number } | null {
  // Example: /dev/sda1       80G   45G   31G  60% /opt/deployhub/projects/foo
  const parts = line.trim().split(/\s+/)
  if (parts.length < 4) return null
  const toGB = (s: string): number => {
    const m = s.match(/^([\d.]+)([KMGT]?)/i)
    if (!m) return 0
    const n = parseFloat(m[1])
    const unit = (m[2] || '').toUpperCase()
    const mult: Record<string, number> = { K: 1e-6, M: 1e-3, G: 1, T: 1e3 }
    return n * (mult[unit] || 1)
  }
  return { usedGB: toGB(parts[2]), totalGB: toGB(parts[1]) }
}

function parseMemUsage(s: string): { usedMB: number; limitMB: number } | null {
  // Example: 245.6MiB / 1GiB
  const m = s.match(/([\d.]+)([KMGT]?i?B)\s*\/\s*([\d.]+)([KMGT]?i?B)/i)
  if (!m) return null
  const toMB = (val: string, unit: string): number => {
    const n = parseFloat(val)
    const u = unit.toUpperCase().replace('IB', 'B')
    const mult: Record<string, number> = {
      B: 1e-6,
      KB: 1e-3,
      MB: 1,
      GB: 1024,
      TB: 1024 * 1024,
    }
    return n * (mult[u] || 1)
  }
  return {
    usedMB: toMB(m[1], m[2]),
    limitMB: toMB(m[3], m[4]),
  }
}

function parseNetIo(s: string): { rxBytes: number; txBytes: number } | null {
  // Example: 1.23kB / 4.56kB
  const m = s.match(/([\d.]+)([kKMG]?)B?\s*\/\s*([\d.]+)([kKMG]?)B?/)
  if (!m) return { rxBytes: 0, txBytes: 0 }
  const toBytes = (val: string, unit: string): number => {
    const n = parseFloat(val)
    const u = unit.toUpperCase()
    const mult: Record<string, number> = { K: 1e3, M: 1e6, G: 1e9, '': 1 }
    return n * (mult[u] || 1)
  }
  return { rxBytes: toBytes(m[1], m[2]), txBytes: toBytes(m[3], m[4]) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Deterministic-ish pseudo-random in [0, 1) seeded by the project id so the
// demo "current usage" stays stable within a single page render.
function seededRandom(seed: string): () => number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h += 0x6d2b79f5
    let t = h
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function getProjectResourceUsage(
  projectId: string
): Promise<ResourceUsage | null> {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) return null

  const cpuCores = project.resourceCpuCores ?? 1
  const ramMB = project.resourceRamMB ?? 1024
  const storageGB = project.resourceStorageGB ?? 10

  // If the project has no container at all, return zeros + stopped.
  if (!project.containerName) {
    return {
      cpuCores,
      cpuPercent: 0,
      ramMB,
      ramUsedMB: 0,
      storageGB,
      storageUsedGB: 0,
      networkRxBytes: 0,
      networkTxBytes: 0,
      uptimeSeconds: 0,
      status: project.status === 'running' ? 'running' : 'stopped',
    }
  }

  if (isServerInDemoMode(project.server)) {
    // Demo mode: random-walk within the allocated limits.
    const rand = seededRandom(project.id + Date.now().toString().slice(0, -4))
    const usedRam = Math.round(ramMB * (0.2 + rand() * 0.5))
    const usedStorage = +(storageGB * (0.15 + rand() * 0.4)).toFixed(2)
    const cpuPercent = +(cpuCores * (10 + rand() * 60)).toFixed(1)
    const uptime = Math.floor(3600 + rand() * 30 * 24 * 3600)
    return {
      cpuCores,
      cpuPercent,
      ramMB,
      ramUsedMB: usedRam,
      storageGB,
      storageUsedGB: usedStorage,
      networkRxBytes: Math.floor(rand() * 1e9),
      networkTxBytes: Math.floor(rand() * 5e8),
      uptimeSeconds: uptime,
      status: 'running',
    }
  }

  try {
    const creds: SshCredentials = await getServerCredentials(project.serverId!)
    return await withConnection(creds, async (client) => {
      // docker stats --no-stream
      const stats = await exec(
        client,
        `docker stats --no-stream --format '{{.CPUPerc}}|{{.MemUsage}}|{{.NetIO}}' ${project.containerName} 2>&1`,
        { timeoutMs: 15000 }
      )
      let cpuPercent = 0
      let ramUsedMB = 0
      let netRx = 0
      let netTx = 0
      if (stats.exitCode === 0 && stats.stdout.trim()) {
        const [cpuStr, memStr, netStr] = stats.stdout.trim().split('|')
        cpuPercent = parseFloat((cpuStr || '').replace('%', '').trim()) || 0
        const mem = parseMemUsage(memStr || '')
        if (mem) ramUsedMB = Math.round(mem.usedMB)
        const net = parseNetIo(netStr || '')
        if (net) {
          netRx = net.rxBytes
          netTx = net.txBytes
        }
      }

      // df -h deployPath
      let storageUsedGB = 0
      if (project.deployPath) {
        const df = await exec(
          client,
          `df -h ${project.deployPath} 2>/dev/null | tail -1`,
          { timeoutMs: 10000 }
        )
        const parsed = parseDfRow(df.stdout)
        if (parsed) storageUsedGB = +parsed.usedGB.toFixed(2)
      }

      // Uptime
      const up = await exec(
        client,
        `docker inspect --format '{{.State.StartedAt}}' ${project.containerName} 2>/dev/null`,
        { timeoutMs: 10000 }
      )
      let uptimeSeconds = 0
      const startedAt = up.stdout.trim()
      if (startedAt) {
        const t = new Date(startedAt).getTime()
        if (!isNaN(t)) uptimeSeconds = Math.max(0, Math.floor((Date.now() - t) / 1000))
      }

      return {
        cpuCores,
        cpuPercent,
        ramMB,
        ramUsedMB,
        storageGB,
        storageUsedGB,
        networkRxBytes: netRx,
        networkTxBytes: netTx,
        uptimeSeconds,
        status: 'running' as const,
      }
    })
  } catch (err) {
    console.error('[vps-resources] getProjectResourceUsage error:', err)
    return {
      cpuCores,
      cpuPercent: 0,
      ramMB,
      ramUsedMB: 0,
      storageGB,
      storageUsedGB: 0,
      networkRxBytes: 0,
      networkTxBytes: 0,
      uptimeSeconds: 0,
      status: 'error',
    }
  }
}

/**
 * Synthesize `hours` hourly data points leading up to "now". We don't store
 * continuous metrics — instead we query the current usage (one SSH call) and
 * generate a plausible walk backwards in time with mild jitter, so the chart
 * always renders something useful.
 */
export async function getProjectResourceHistory(
  projectId: string,
  hours = 24
): Promise<ResourceHistoryPoint[]> {
  const current = await getProjectResourceUsage(projectId)
  if (!current) return []

  const now = Date.now()
  const rand = seededRandom(projectId + Math.floor(now / 60000).toString())
  const points: ResourceHistoryPoint[] = []
  const stepSec = (hours * 3600) / Math.max(1, hours)
  for (let i = hours; i >= 0; i--) {
    const ts = new Date(now - i * stepSec * 1000).toISOString()
    // Walk the values around the current measurement with +/- 15% jitter.
    const cpuJitter = (rand() - 0.5) * 0.3
    const ramJitter = (rand() - 0.5) * 0.2
    const storJitter = (rand() - 0.5) * 0.05
    points.push({
      timestamp: ts,
      cpuPercent: +Math.max(0, current.cpuPercent * (1 + cpuJitter)).toFixed(1),
      ramUsedMB: Math.max(0, Math.round(current.ramUsedMB * (1 + ramJitter))),
      storageUsedGB: +Math.max(0, current.storageUsedGB * (1 + storJitter)).toFixed(2),
    })
  }
  return points
}
