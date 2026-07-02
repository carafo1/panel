/**
 * Real VPS SSH Client
 * ===================
 *
 * A thin wrapper around the `ssh2` library providing:
 *   - connect(opts)        → reusable SSH connection with key OR password auth
 *   - exec(cmd)            → run a shell command, return stdout/stderr/exit code
 *   - execStream(cmd)      → async generator yielding stdout/stderr chunks live
 *   - putFile(path, data)  → SFTP upload a file
 *   - getFile(path)        → SFTP download a file
 *   - testConnection()     → lightweight connectivity check used by admin UI
 *
 * The module is intentionally side-effect free: callers (the VPS provisioner,
 * the container deployer, the reverse proxy manager, the API routes) supply
 * the decrypted credentials and the module just runs the commands.
 *
 * When NO real VPS is configured (i.e. every Server row has sshHost = '' ),
 * callers should check `isVpsDemoMode()` and fall back to simulated behavior
 * so the platform still works end-to-end in development and demos.
 */
import { Client, type ClientChannel } from 'ssh2'
import { readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, readFile, unlink } from 'fs/promises'
import { LocalClient, isLocalHost, execLocal, execStreamLocal } from './local-exec'

// Union type so TypeScript accepts either ssh2 Client or LocalClient.
type AnyClient = Client | LocalClient

// ─── Types ───────────────────────────────────────────────────────────────

export interface SshCredentials {
  host: string
  port: number
  username: string
  privateKey?: string // PEM string
  password?: string
  passphrase?: string
  readyTimeout?: number // ms
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number | null
  signal?: string
  durationMs: number
}

export interface StreamChunk {
  stream: 'stdout' | 'stderr'
  data: string
}

export interface SshConnectionInfo {
  host: string
  port: number
  username: string
  authMethod: 'private-key' | 'password' | 'agent'
  connected: boolean
  serverVersion?: string
  remoteBanner?: string
}

// ─── Connection helper ───────────────────────────────────────────────────

/**
 * Open a one-shot connection, run a function with it, and always close it.
 *
 * When `creds.host` is `localhost` / `127.0.0.1` / `::1`, a `LocalClient` is
 * used instead of an SSH connection — commands run on the panel host itself
 * via `child_process`. This makes every VPS feature (databases, deploys, cron,
 * ftp, files, terminal, backups) execute REAL operations in dev/sandbox
 * without needing a remote SSH server. In production, point the Server row at
 * a real host and the normal SSH path is used.
 *
 * Throws if the connection fails. Callers MUST handle errors.
 */
export async function withConnection<T>(
  creds: SshCredentials,
  fn: (client: AnyClient) => Promise<T>
): Promise<T> {
  // ── Local execution path ────────────────────────────────────────────
  if (isLocalHost(creds.host)) {
    const client = new LocalClient()
    try {
      return await fn(client)
    } finally {
      client.end()
      client.destroy()
    }
  }

  // ── Remote SSH path ─────────────────────────────────────────────────
  const client = new Client()
  try {
    await connectAsync(client, creds)
    return await fn(client)
  } finally {
    client.end()
    client.destroy()
  }
}

function connectAsync(client: Client, creds: SshCredentials): Promise<void> {
  return new Promise((resolve, reject) => {
    const opts: Record<string, unknown> = {
      host: creds.host,
      port: creds.port || 22,
      username: creds.username,
      readyTimeout: creds.readyTimeout ?? 15000,
      // Be permissive about host key verification in this automation context.
      // Real production deployments should pin sshFingerprint and verify.
      keepaliveInterval: 0,
    }
    if (creds.privateKey) {
      opts.privateKey = creds.privateKey
      if (creds.passphrase) opts.passphrase = creds.passphrase
    } else if (creds.password) {
      opts.password = creds.password
    } else {
      opts.agent = process.env.SSH_AUTH_SOCK
    }

    const timer = setTimeout(() => {
      client.end()
      client.destroy()
      reject(new Error(`SSH connection timeout to ${creds.host}:${creds.port}`))
    }, (creds.readyTimeout ?? 15000) + 5000)

    client.once('ready', () => {
      clearTimeout(timer)
      resolve()
    })
    client.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    client.connect(opts as ConstructorParameters<typeof Client.connect>[0])
  })
}

// ─── exec (buffered) ─────────────────────────────────────────────────────

/**
 * Run a shell command on the remote host and return the buffered output.
 * The command is wrapped with `bash -lc` so $PATH includes /usr/local/bin etc.
 */
export async function exec(
  client: AnyClient,
  command: string,
  opts: { cwd?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const wrapped = opts.cwd
      ? `cd ${shellQuote(opts.cwd)} && ${command}`
      : command
    const fullCmd = `bash -lc ${shellQuote(wrapped)}`

    const timeout = setTimeout(() => {
      // We can't easily kill the channel from outside, but the ssh2 stream
      // supports .end() to terminate the channel.
      try {
        streamRef?.end()
      } catch {
        /* noop */
      }
      reject(
        new Error(
          `SSH exec timeout after ${opts.timeoutMs ?? 60000}ms: ${command.slice(0, 120)}`
        )
      )
    }, opts.timeoutMs ?? 60000)

    let streamRef: ClientChannel | null = null
    let stdout = ''
    let stderr = ''

    client.exec(fullCmd, { pty: false }, (err, stream) => {
      if (err) {
        clearTimeout(timeout)
        reject(err)
        return
      }
      streamRef = stream

      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
      })
      stream.on('close', (code: number | null, signal?: string) => {
        clearTimeout(timeout)
        resolve({
          stdout,
          stderr,
          exitCode: code,
          signal: signal ?? undefined,
          durationMs: Date.now() - start,
        })
      })
      stream.on('error', (e: Error) => {
        clearTimeout(timeout)
        reject(e)
      })
    })
  })
}

// ─── execStream (live output) ────────────────────────────────────────────

/**
 * Run a command and yield stdout/stderr chunks as they arrive.
 * Useful for live build logs streamed to the dashboard via socket.io.
 *
 * The generator returns the final ExecResult when the command completes.
 */
export async function* execStream(
  client: AnyClient,
  command: string,
  opts: { cwd?: string; timeoutMs?: number } = {}
): AsyncGenerator<StreamChunk, ExecResult, void> {
  const start = Date.now()
  const wrapped = opts.cwd
    ? `cd ${shellQuote(opts.cwd)} && ${command}`
    : command
  const fullCmd = `bash -lc ${shellQuote(wrapped)}`

  const stream = await new Promise<ClientChannel>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`SSH exec timeout: ${command.slice(0, 120)}`))
    }, opts.timeoutMs ?? 60000)
    client.exec(fullCmd, { pty: false }, (err, s) => {
      clearTimeout(timer)
      if (err) reject(err)
      else resolve(s)
    })
  })

  // Build a queue + close promise so we can expose chunks as an async iter.
  const chunks: StreamChunk[] = []
  let resolved = false
  let finalResult!: ExecResult
  let waiters: Array<() => void> = []

  const notify = () => {
    while (waiters.length > 0) {
      const w = waiters.shift()!
      w()
    }
  }

  stream.on('data', (chunk: Buffer) => {
    chunks.push({ stream: 'stdout', data: chunk.toString('utf8') })
    notify()
  })
  stream.stderr.on('data', (chunk: Buffer) => {
    chunks.push({ stream: 'stderr', data: chunk.toString('utf8') })
    notify()
  })
  stream.on('close', (code: number | null, signal?: string) => {
    const stdout = chunks
      .filter((c) => c.stream === 'stdout')
      .map((c) => c.data)
      .join('')
    const stderr = chunks
      .filter((c) => c.stream === 'stderr')
      .map((c) => c.data)
      .join('')
    finalResult = {
      stdout,
      stderr,
      exitCode: code,
      signal: signal ?? undefined,
      durationMs: Date.now() - start,
    }
    resolved = true
    notify()
  })
  stream.on('error', (e: Error) => {
    finalResult = {
      stdout: '',
      stderr: e.message,
      exitCode: -1,
      durationMs: Date.now() - start,
    }
    resolved = true
    notify()
  })

  while (!resolved || chunks.length > 0) {
    while (chunks.length > 0) {
      yield chunks.shift()!
    }
    if (!resolved) {
      await new Promise<void>((r) => waiters.push(r))
    }
  }

  return finalResult
}

// ─── SFTP file transfer ──────────────────────────────────────────────────

/**
 * Upload a file to the remote host via SFTP. `content` may be a string or Buffer.
 */
export async function putFile(
  client: AnyClient,
  remotePath: string,
  content: string | Buffer,
  opts: { mode?: number } = {}
): Promise<void> {
  const sftp = await new Promise<any>((resolve, reject) => {
    client.sftp((err, s) => (err ? reject(err) : resolve(s)))
  })

  // Write to a temp local file then upload via SFTP fast path.
  const tmpFile = join(tmpdir(), `deployhub-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await writeFile(tmpFile, content)

  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(tmpFile, remotePath, (err: Error | undefined) => {
        if (err) reject(err)
        else resolve()
      })
    })

    if (opts.mode !== undefined) {
      await new Promise<void>((resolve, reject) => {
        sftp.chmod(remotePath, opts.mode!, (err: Error | undefined) => {
          if (err) reject(err)
          else resolve()
        })
      })
    }
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

/**
 * Download a file from the remote host via SFTP.
 */
export async function getFile(client: AnyClient, remotePath: string): Promise<Buffer> {
  const sftp = await new Promise<any>((resolve, reject) => {
    client.sftp((err, s) => (err ? reject(err) : resolve(s)))
  })

  const tmpFile = join(tmpdir(), `deployhub-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, tmpFile, (err: Error | undefined) => {
      if (err) reject(err)
      else resolve()
    })
  })
  try {
    return await readFile(tmpFile)
  } finally {
    await unlink(tmpFile).catch(() => {})
  }
}

// ─── Connection testing ──────────────────────────────────────────────────

/**
 * Lightweight connectivity check. Runs `uname -a` and `docker --version` (if present)
 * and returns a structured info object the admin UI can display.
 */
export async function testConnection(creds: SshCredentials): Promise<{
  ok: boolean
  error?: string
  info?: {
    host: string
    port: number
    username: string
    authMethod: 'private-key' | 'password' | 'agent'
    serverVersion?: string
    osInfo?: string
    dockerVersion?: string
    caddyVersion?: string
  }
}> {
  try {
    const result = await withConnection(creds, async (client) => {
      const authMethod: SshConnectionInfo['authMethod'] = creds.privateKey
        ? 'private-key'
        : creds.password
          ? 'password'
          : 'agent'

      const uname = await exec(client, 'uname -a', { timeoutMs: 10000 })
      const osInfo = uname.stdout.trim() || undefined

      let dockerVersion: string | undefined
      const dkr = await exec(client, 'docker --version 2>/dev/null || true', {
        timeoutMs: 10000,
      })
      if (dkr.exitCode === 0 && dkr.stdout.trim()) {
        dockerVersion = dkr.stdout.trim()
      }

      let caddyVersion: string | undefined
      const cdy = await exec(client, 'caddy version 2>/dev/null || true', {
        timeoutMs: 10000,
      })
      if (cdy.exitCode === 0 && cdy.stdout.trim()) {
        caddyVersion = cdy.stdout.trim().split('\n')[0]
      }

      return {
        host: creds.host,
        port: creds.port,
        username: creds.username,
        authMethod,
        osInfo,
        dockerVersion,
        caddyVersion,
      }
    })
    return { ok: true, info: result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Minimal POSIX shell quoting. Wraps the string in single quotes and escapes
 * any embedded single quotes via the '\'' trick.
 */
export function shellQuote(s: string): string {
  if (s === '') return "''"
  // If the string is "safe" (alnum + a few punctuation), skip quoting for readability.
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Resolve an encrypted private key stored on disk to a PEM string.
 * Used by callers that load keys from a file path rather than a DB column.
 */
export function loadPrivateKeyFromFile(path: string, passphrase?: string): {
  privateKey: string
  passphrase?: string
} {
  const privateKey = readFileSync(path, 'utf8')
  return passphrase ? { privateKey, passphrase } : { privateKey }
}

// ─── Demo mode detection ─────────────────────────────────────────────────

/**
 * True when no real VPS infrastructure is configured. In demo mode, the VPS
 * modules fall back to simulated behavior so the full platform UX still works.
 *
 * Demo mode is active when VPS_DEMO_MODE=1 OR when no Server row in the DB
 * has a non-empty sshHost (callers check the latter themselves before calling
 * VPS functions).
 */
export function isVpsDemoMode(): boolean {
  return process.env.VPS_DEMO_MODE === '1' || process.env.VPS_DEMO_MODE === 'true'
}

/**
 * Check if a server object is "demo-mode eligible" — i.e. we can't actually
 * run real commands against it. This is true when:
 *   - Global demo mode is on (VPS_DEMO_MODE=1), OR
 *   - The server has no sshHost, OR
 *   - The server is NOT local (localhost/127.0.0.1/::1) AND has neither a
 *     private key nor a password configured.
 *
 * Local-host servers are ALWAYS considered real (not demo) because the
 * LocalClient can run commands on the panel host without SSH credentials.
 * Callers should use this instead of `isVpsDemoMode() || !server.sshHost`
 * so that a server with an sshHost but no credentials also falls back to
 * demo behavior (instead of throwing inside getServerCredentials) — UNLESS
 * it's a localhost server, which is always real.
 */
export function isServerInDemoMode(server: {
  sshHost?: string | null
  sshPrivateKey?: string | null
  sshPassword?: string | null
}): boolean {
  if (isVpsDemoMode()) return true
  if (!server.sshHost) return true
  // Localhost servers are real — LocalClient needs no SSH credentials.
  if (isLocalHost(server.sshHost)) return false
  if (!server.sshPrivateKey && !server.sshPassword) return true
  return false
}

// Re-export local-exec helpers so callers can import them from ssh.ts.
export { execLocal, execStreamLocal, isLocalHost } from './local-exec'
