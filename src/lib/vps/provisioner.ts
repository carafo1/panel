/**
 * VPS Provisioner
 * ===============
 *
 * Idempotently installs the APSAMO hosting stack on a fresh VPS:
 *
 *   1. Update apt + install essential packages (curl, git, ufw, jq, etc.)
 *   2. Install Docker Engine + docker compose plugin
 *   3. Install Caddy 2 as a systemd service (the reverse proxy + auto-HTTPS)
 *   4. Configure UFW firewall (allow 22, 80, 443; everything else denied)
 *   5. Create /opt/deployhub working directory + docker network
 *   6. Detect CPU/RAM/disk and write back to the Server row
 *
 * Each step is independently runnable via `provisionStep(name, creds)` so the
 * admin UI can show granular progress, and `provisionServer(server)` runs
 * them all in order with full logging.
 *
 * In DEMO MODE (VPS_DEMO_MODE=1 or server.sshHost is empty), every step
 * returns a simulated success result with realistic timing, so the platform
 * UX works end-to-end without a real VPS.
 */
import { db } from '@/lib/db'
import { decrypt, encrypt } from '@/lib/encryption'
import {
  withConnection,
  exec,
  testConnection,
  shellQuote,
  isVpsDemoMode,
  isServerInDemoMode,
  type SshCredentials,
  type ExecResult,
} from './ssh'

// ─── Types ───────────────────────────────────────────────────────────────

export type ProvisionStepName =
  | 'connect'
  | 'system_update'
  | 'install_docker'
  | 'install_caddy'
  | 'configure_firewall'
  | 'setup_directories'
  | 'detect_resources'

export interface ProvisionStepResult {
  step: ProvisionStepName
  status: 'success' | 'failed' | 'skipped'
  message: string
  logs: string
  durationMs: number
}

export interface ProvisionResult {
  ok: boolean
  serverId: string
  steps: ProvisionStepResult[]
  finalStatus: string
  dockerVersion?: string
  caddyVersion?: string
  osInfo?: string
  detectedCpuCores?: number
  detectedRamGB?: number
  detectedStorageGB?: number
}

export interface ServerCredentials extends SshCredentials {
  serverId: string
  rawPrivateKey?: string
  rawPassword?: string
}

// ─── Credential loader ───────────────────────────────────────────────────

/**
 * Load a Server row from the DB and decrypt its SSH credentials.
 * Throws if the server has no SSH credentials configured.
 */
export async function getServerCredentials(serverId: string): Promise<ServerCredentials> {
  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) throw new Error(`Server ${serverId} not found`)

  const sshHost = server.sshHost || server.ip
  if (!sshHost) {
    throw new Error('Server has no SSH host configured')
  }

  let privateKey: string | undefined
  if (server.sshPrivateKey) {
    try {
      privateKey = decrypt(server.sshPrivateKey)
    } catch {
      throw new Error('Failed to decrypt SSH private key — check ENCRYPTION_KEY')
    }
  }

  let password: string | undefined
  if (server.sshPassword) {
    try {
      password = decrypt(server.sshPassword)
    } catch {
      throw new Error('Failed to decrypt SSH password — check ENCRYPTION_KEY')
    }
  }

  if (!privateKey && !password && !process.env.SSH_AUTH_SOCK) {
    throw new Error('Server has no SSH credentials (need private key or password)')
  }

  return {
    serverId: server.id,
    host: sshHost,
    port: server.sshPort,
    username: server.sshUser,
    privateKey,
    password,
    readyTimeout: 20000,
  }
}

// ─── Per-step provisioners ───────────────────────────────────────────────

export const STEP_ORDER: ProvisionStepName[] = [
  'connect',
  'system_update',
  'install_docker',
  'install_caddy',
  'configure_firewall',
  'setup_directories',
  'detect_resources',
]

export const STEP_LABELS: Record<ProvisionStepName, string> = {
  connect: 'Test SSH connection',
  system_update: 'System update & essentials',
  install_docker: 'Install Docker Engine',
  install_caddy: 'Install Caddy reverse proxy',
  configure_firewall: 'Configure UFW firewall',
  setup_directories: 'Setup APSAMO directories',
  detect_resources: 'Detect CPU / RAM / disk',
}

export async function runStep(
  step: ProvisionStepName,
  creds: ServerCredentials,
  onLog?: (msg: string) => void
): Promise<ProvisionStepResult> {
  const log = (msg: string) => {
    onLog?.(msg)
  }
  const start = Date.now()

  // DEMO MODE: short-circuit with simulated success.
  // Demo mode is active when VPS_DEMO_MODE=1, or when creds has no host,
  // or when creds has no private key AND no password (no way to auth).
  const noCreds =
    !creds.privateKey && !creds.password && !process.env.SSH_AUTH_SOCK
  if (isVpsDemoMode() || !creds.host || noCreds) {
    log(`[demo] ${STEP_LABELS[step]} — simulated success`)
    await sleep(300 + Math.random() * 500)
    return {
      step,
      status: 'success',
      message: `Simulated: ${STEP_LABELS[step]}`,
      logs: `[demo-mode] ${STEP_LABELS[step]} completed (simulated)`,
      durationMs: Date.now() - start,
    }
  }

  try {
    switch (step) {
      case 'connect': {
        log(`Connecting to ${creds.host}:${creds.port} as ${creds.username}…`)
        const t = await testConnection(creds)
        if (!t.ok) throw new Error(t.error || 'Connection failed')
        log(`Connected. OS: ${t.info?.osInfo ?? 'unknown'}`)
        return {
          step,
          status: 'success',
          message: 'SSH connection verified',
          logs: JSON.stringify(t.info, null, 2),
          durationMs: Date.now() - start,
        }
      }

      case 'system_update': {
        return await withConnection(creds, async (client) => {
          log('Running apt-get update…')
          const update = await exec(
            client,
            'export DEBIAN_FRONTEND=noninteractive && apt-get update -qq',
            { timeoutMs: 120000 }
          )
          log('Installing essentials (curl, git, ufw, jq, ca-certificates)…')
          const install = await exec(
            client,
            'export DEBIAN_FRONTEND=noninteractive && apt-get install -y -qq curl git ufw jq ca-certificates gnupg lsb-release software-properties-common',
            { timeoutMs: 180000 }
          )
          if (install.exitCode !== 0) {
            throw new Error(
              `apt install failed: ${install.stderr.slice(0, 500)}`
            )
          }
          return {
            step,
            status: 'success' as const,
            message: 'System packages installed',
            logs: update.stdout + '\n' + install.stdout,
            durationMs: Date.now() - start,
          }
        })
      }

      case 'install_docker': {
        return await withConnection(creds, async (client) => {
          // Check if Docker is already installed
          const existing = await exec(client, 'docker --version 2>/dev/null', {
            timeoutMs: 10000,
          })
          if (existing.exitCode === 0 && existing.stdout.includes('Docker version')) {
            log(`Docker already installed: ${existing.stdout.trim()}`)
            return {
              step,
              status: 'success' as const,
              message: `Docker already installed: ${existing.stdout.trim()}`,
              logs: existing.stdout,
              durationMs: Date.now() - start,
            }
          }
          log('Installing Docker via official convenience script…')
          const install = await exec(
            client,
            'curl -fsSL https://get.docker.com | sh',
            { timeoutMs: 300000 }
          )
          if (install.exitCode !== 0) {
            throw new Error(`Docker install failed: ${install.stderr.slice(0, 500)}`)
          }
          log('Enabling + starting docker service…')
          await exec(client, 'systemctl enable --now docker', { timeoutMs: 30000 })
          const ver = await exec(client, 'docker --version', { timeoutMs: 10000 })
          log(`Docker installed: ${ver.stdout.trim()}`)
          return {
            step,
            status: 'success' as const,
            message: ver.stdout.trim(),
            logs: install.stdout + '\n' + ver.stdout,
            durationMs: Date.now() - start,
          }
        })
      }

      case 'install_caddy': {
        return await withConnection(creds, async (client) => {
          const existing = await exec(client, 'caddy version 2>/dev/null', {
            timeoutMs: 10000,
          })
          if (existing.exitCode === 0 && existing.stdout.trim()) {
            log(`Caddy already installed: ${existing.stdout.trim().split('\n')[0]}`)
            return {
              step,
              status: 'success' as const,
              message: `Caddy already installed: ${existing.stdout.trim().split('\n')[0]}`,
              logs: existing.stdout,
              durationMs: Date.now() - start,
            }
          }
          log('Installing Caddy via official apt repository…')
          const cmds = [
            'apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https',
            'curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg',
            'curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | tee /etc/apt/sources.list.d/caddy-stable.list',
            'apt-get update -qq',
            'apt-get install -y -qq caddy',
            'systemctl enable --now caddy',
          ].join(' && ')
          const install = await exec(
            client,
            `export DEBIAN_FRONTEND=noninteractive && ${cmds}`,
            { timeoutMs: 180000 }
          )
          if (install.exitCode !== 0) {
            throw new Error(`Caddy install failed: ${install.stderr.slice(0, 500)}`)
          }
          const ver = await exec(client, 'caddy version', { timeoutMs: 10000 })
          log(`Caddy installed: ${ver.stdout.trim().split('\n')[0]}`)
          return {
            step,
            status: 'success' as const,
            message: ver.stdout.trim().split('\n')[0],
            logs: install.stdout + '\n' + ver.stdout,
            durationMs: Date.now() - start,
          }
        })
      }

      case 'configure_firewall': {
        return await withConnection(creds, async (client) => {
          log('Configuring UFW firewall (allow 22, 80, 443)…')
          const cmds = [
            'ufw --force reset',
            'ufw allow 22/tcp comment "SSH"',
            'ufw allow 80/tcp comment "HTTP"',
            'ufw allow 443/tcp comment "HTTPS"',
            'ufw --force enable',
            'ufw status verbose',
          ].join(' && ')
          const result = await exec(client, cmds, { timeoutMs: 60000 })
          if (result.exitCode !== 0) {
            throw new Error(`UFW setup failed: ${result.stderr.slice(0, 500)}`)
          }
          log('Firewall configured: SSH(22) + HTTP(80) + HTTPS(443) allowed')
          return {
            step,
            status: 'success' as const,
            message: 'Firewall configured (22/80/443 open)',
            logs: result.stdout,
            durationMs: Date.now() - start,
          }
        })
      }

      case 'setup_directories': {
        return await withConnection(creds, async (client) => {
          log('Creating /opt/deployhub directory + docker network…')
          const cmds = [
            'mkdir -p /opt/deployhub/{projects,caddy,logs}',
            'mkdir -p /opt/deployhub/caddy/{data,config}',
            // Caddy JSON config & main Caddyfile
            'touch /opt/deployhub/caddy/Caddyfile',
            // Shared docker network so Caddy can proxy to project containers
            'docker network create deployhub 2>/dev/null || true',
            'ls -la /opt/deployhub',
          ].join(' && ')
          const result = await exec(client, cmds, { timeoutMs: 30000 })
          if (result.exitCode !== 0) {
            throw new Error(`Directory setup failed: ${result.stderr.slice(0, 500)}`)
          }
          log('Directories + docker network ready')
          return {
            step,
            status: 'success' as const,
            message: 'Working directories + docker network created',
            logs: result.stdout,
            durationMs: Date.now() - start,
          }
        })
      }

      case 'detect_resources': {
        return await withConnection(creds, async (client) => {
          log('Detecting CPU, RAM, disk…')
          const cpu = await exec(client, 'nproc', { timeoutMs: 10000 })
          const ram = await exec(
            client,
            "free -g | awk '/^Mem:/{print $2}'",
            { timeoutMs: 10000 }
          )
          const disk = await exec(
            client,
            "df -BG / | awk 'NR==2{print $2}' | tr -d 'G'",
            { timeoutMs: 10000 }
          )
          const osInfo = await exec(client, '. /etc/os-release && echo "$PRETTY_NAME"', {
            timeoutMs: 10000,
          })
          const cpuCores = parseInt(cpu.stdout.trim(), 10) || 0
          const ramGB = parseInt(ram.stdout.trim(), 10) || 0
          const storageGB = parseInt(disk.stdout.trim(), 10) || 0
          log(`Detected: ${cpuCores} CPU, ${ramGB}GB RAM, ${storageGB}GB disk`)
          return {
            step,
            status: 'success' as const,
            message: `Detected ${cpuCores} CPU / ${ramGB}GB RAM / ${storageGB}GB disk`,
            logs: `CPU: ${cpu.stdout}\nRAM: ${ram.stdout}\nDisk: ${disk.stdout}\nOS: ${osInfo.stdout}`,
            durationMs: Date.now() - start,
            // Custom fields for the caller to persist
            ...({
              detectedCpuCores: cpuCores,
              detectedRamGB: ramGB,
              detectedStorageGB: storageGB,
              osInfoDetected: osInfo.stdout.trim(),
            } as Record<string, unknown>),
          } as ProvisionStepResult
        })
      }

      default:
        return {
          step,
          status: 'skipped',
          message: `Unknown step: ${step}`,
          logs: '',
          durationMs: 0,
        }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(`FAILED: ${message}`)
    return {
      step,
      status: 'failed',
      message,
      logs: message,
      durationMs: Date.now() - start,
    }
  }
}

// ─── Full provisioning ───────────────────────────────────────────────────

/**
 * Run the full provisioning pipeline for a Server row. Updates the DB row
 * with status, detected resources, and installed versions as it goes.
 */
export async function provisionServer(
  serverId: string,
  onProgress?: (step: ProvisionStepResult) => void
): Promise<ProvisionResult> {
  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) throw new Error(`Server ${serverId} not found`)

  await db.server.update({
    where: { id: serverId },
    data: { status: 'provisioning' },
  })

  // Check if the server is in demo mode (no real SSH access possible).
  // In demo mode, we skip credential loading and let runStep() simulate each step.
  const demoMode = server ? isServerInDemoMode(server) : true
  let creds: ServerCredentials
  if (!demoMode) {
    creds = await getServerCredentials(serverId).catch((err) => {
      throw err
    })
  } else {
    // Minimal stub credentials for demo mode (won't be used — runStep short-circuits)
    creds = {
      serverId,
      host: server?.sshHost || server?.ip || '',
      port: server?.sshPort || 22,
      username: server?.sshUser || 'root',
    }
  }

  const steps: ProvisionStepResult[] = []
  let detectedCpu: number | undefined
  let detectedRam: number | undefined
  let detectedDisk: number | undefined
  let detectedOs: string | undefined
  let dockerVer: string | undefined
  let caddyVer: string | undefined

  for (const stepName of STEP_ORDER) {
    const result = await runStep(stepName, creds, (msg) =>
      console.log(`[vps-provision:${serverId}:${stepName}] ${msg}`)
    )
    steps.push(result)
    onProgress?.(result)

    // Persist detected resources after detect_resources
    if (stepName === 'detect_resources' && result.status === 'success') {
      const extra = result as ProvisionStepResult & Record<string, unknown>
      detectedCpu = extra.detectedCpuCores as number | undefined
      detectedRam = extra.detectedRamGB as number | undefined
      detectedDisk = extra.detectedStorageGB as number | undefined
      detectedOs = extra.osInfoDetected as string | undefined
    }
    // Capture versions from connect step's info
    if (stepName === 'connect' && result.status === 'success') {
      try {
        const info = JSON.parse(result.logs)
        dockerVer = info.dockerVersion
        caddyVer = info.caddyVersion
      } catch {
        /* ignore */
      }
    }

    if (result.status === 'failed') {
      await db.server.update({
        where: { id: serverId },
        data: { status: 'offline', healthStatus: 'down' },
      })
      return {
        ok: false,
        serverId,
        steps,
        finalStatus: 'failed',
      }
    }
  }

  // After successful detection, also re-fetch versions if we didn't get them
  if (!dockerVer || !caddyVer) {
    if (!demoMode && creds.host) {
      try {
        const t = await testConnection(creds)
        if (t.ok && t.info) {
          dockerVer = dockerVer || t.info.dockerVersion
          caddyVer = caddyVer || t.info.caddyVersion
          detectedOs = detectedOs || t.info.osInfo
        }
      } catch {
        /* ignore */
      }
    }
  }

  // In demo mode, simulate versions + detected resources
  if (demoMode) {
    dockerVer = dockerVer || 'Docker version 24.0.7, build afdd53b (simulated)'
    caddyVer = caddyVer || 'v2.7.6 h1:w0NmbG92kH3BdBkzM6P0i7BhgP4zK4C4B8OQ3ZfQI7Y= (simulated)'
    detectedOs = detectedOs || 'Ubuntu 22.04.3 LTS (simulated)'
    detectedCpu = detectedCpu || server.cpuCores || 4
    detectedRam = detectedRam || server.ramGB || 8
    detectedDisk = detectedDisk || server.storageGB || 80
  }

  await db.server.update({
    where: { id: serverId },
    data: {
      status: 'active',
      healthStatus: 'healthy',
      dockerInstalled: true,
      caddyInstalled: true,
      firewallConfigured: true,
      dockerVersion: dockerVer,
      caddyVersion: caddyVer,
      osInfo: detectedOs,
      cpuCores: detectedCpu ?? server.cpuCores,
      ramGB: detectedRam ?? server.ramGB,
      storageGB: detectedDisk ?? server.storageGB,
      lastProvisionedAt: new Date(),
      lastHealthCheckAt: new Date(),
    },
  })

  return {
    ok: true,
    serverId,
    steps,
    finalStatus: 'success',
    dockerVersion: dockerVer,
    caddyVersion: caddyVer,
    osInfo: detectedOs,
    detectedCpuCores: detectedCpu,
    detectedRamGB: detectedRam,
    detectedStorageGB: detectedDisk,
  }
}

// ─── Health check ────────────────────────────────────────────────────────

/**
 * Lightweight health check — verifies SSH connectivity + that docker is
 * responsive + that caddy is running. Called by the worker every few minutes.
 */
export async function checkServerHealth(serverId: string): Promise<{
  status: 'healthy' | 'degraded' | 'down'
  details: string
}> {
  const server = await db.server.findUnique({ where: { id: serverId } })
  if (!server) return { status: 'down', details: 'Server row not found' }

  // Demo mode: always healthy
  if (isServerInDemoMode(server)) {
    return { status: 'healthy', details: 'Demo mode: simulated healthy' }
  }

  try {
    const creds = await getServerCredentials(serverId)
    return await withConnection(creds, async (client) => {
      const dkr = await exec(client, 'docker info --format "{{.ServerVersion}}"', {
        timeoutMs: 10000,
      })
      const cdy = await exec(client, 'systemctl is-active caddy', {
        timeoutMs: 10000,
      })
      const dockerOk = dkr.exitCode === 0 && !!dkr.stdout.trim()
      const caddyOk = cdy.exitCode === 0 && cdy.stdout.trim() === 'active'

      let status: 'healthy' | 'degraded' | 'down' = 'healthy'
      if (!dockerOk && !caddyOk) status = 'down'
      else if (!dockerOk || !caddyOk) status = 'degraded'

      await db.server.update({
        where: { id: serverId },
        data: { lastHealthCheckAt: new Date(), healthStatus: status },
      })

      return {
        status,
        details: `docker=${dockerOk ? 'up' : 'down'}, caddy=${caddyOk ? 'active' : 'inactive'}`,
      }
    })
  } catch (err) {
    await db.server.update({
      where: { id: serverId },
      data: { lastHealthCheckAt: new Date(), healthStatus: 'down' },
    })
    return {
      status: 'down',
      details: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export { shellQuote, encrypt, decrypt }
export type { ExecResult, SshCredentials }
