/**
 * Local Execution Shim
 * ====================
 *
 * Provides a `LocalClient` that implements the subset of ssh2's `Client` API
 * used by `ssh.ts` (`exec`, `sftp`, `end`, `destroy`), plus a set of helper
 * functions (`execLocal`, `execStreamLocal`, `ensureDir`, `isLocalHost`,
 * `isDockerAvailable`) that the other VPS modules import directly.
 *
 * Why this exists
 * ---------------
 * Every VPS feature (databases, deploys, cron, ftp, files, terminal, backups,
 * proxy) is written against the ssh2 `Client` interface so they work unchanged
 * against a real remote VPS. When a Server row's `sshHost` is `localhost` /
 * `127.0.0.1` / `::1`, however, there is no SSH server to talk to — the panel
 * host itself IS the deploy target. `LocalClient` lets the exact same call
 * sites (`withConnection`, `exec`, `putFile`, `getFile`, `execStream`) run real
 * commands on the panel host via `child_process`, with zero changes to the
 * callers.
 *
 * This is what makes the platform "real" in the sandbox / single-node panel
 * deployment: a Server row with `sshHost='localhost'` and no SSH credentials
 * is treated as a real (non-demo) server, and every operation actually
 * executes against the local filesystem and local Docker daemon.
 *
 * API surface (imported by sibling modules)
 * -----------------------------------------
 *   - isLocalHost(host?)            → boolean
 *   - ensureDir(dir)                → Promise<void>          (mkdir -p)
 *   - isDockerAvailable()           → Promise<boolean>       (docker info)
 *   - execLocal(cmd, opts)          → Promise<ExecResult>
 *   - execStreamLocal(cmd, opts)    → AsyncGenerator<StreamChunk, ExecResult>
 *   - class LocalClient             → ssh2-compatible shim
 *
 * The `ExecResult` / `StreamChunk` shapes are structurally identical to the
 * ones exported from `ssh.ts` (so TypeScript's structural typing is happy
 * without a circular import).
 */
import { spawn, type ChildProcess } from 'child_process'
import { mkdir, copyFile, chmod, stat } from 'fs/promises'
import { EventEmitter } from 'events'

// ─── Shared types (structurally compatible with ssh.ts) ──────────────────

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

export interface ExecOpts {
  cwd?: string
  env?: Record<string, string>
  timeoutMs?: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * True when the given host refers to the panel host itself. Used to decide
 * whether to use `LocalClient` (child_process) instead of an SSH connection.
 */
export function isLocalHost(host?: string | null): boolean {
  if (!host) return false
  const h = host.toLowerCase().trim()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
}

/**
 * Recursively create a directory (like `mkdir -p`). Resolves even if the
 * directory already exists.
 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/**
 * Check whether the local Docker daemon is installed AND responding. Used by
 * `database.ts` to decide whether to provision a real MySQL/Postgres container
 * or fall back to a SQLite file for localhost servers without Docker.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    const version = await execLocal('docker --version', { timeoutMs: 5000 })
    if (version.exitCode !== 0) return false
    // `docker --version` only checks the CLI exists. Ping the daemon too.
    const ping = await execLocal('docker info >/dev/null 2>&1', { timeoutMs: 8000 })
    return ping.exitCode === 0
  } catch {
    return false
  }
}

// ─── execLocal: run a command on the panel host ──────────────────────────

/**
 * Run a shell command on the panel host via `bash -lc` (so $PATH includes
 * /usr/local/bin etc., matching the remote SSH path). Returns the buffered
 * stdout/stderr + exit code. Never throws — errors are reported as
 * `exitCode: -1` with the message in `stderr`.
 */
export async function execLocal(command: string, opts: ExecOpts = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now()
    const timeoutMs = opts.timeoutMs ?? 60000
    let child: ChildProcess
    try {
      child = spawn('bash', ['-lc', command], {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: -1,
        durationMs: Date.now() - start,
      })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* noop */
      }
    }, timeoutMs)

    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + err.message,
        exitCode: -1,
        durationMs: Date.now() - start,
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const finalStderr = timedOut
        ? stderr + (stderr ? '\n' : '') + `Command timed out after ${timeoutMs}ms`
        : stderr
      resolve({
        stdout,
        stderr: finalStderr,
        exitCode: code ?? (timedOut ? -1 : null),
        signal: signal ?? undefined,
        durationMs: Date.now() - start,
      })
    })
  })
}

// ─── execStreamLocal: async generator version ────────────────────────────

/**
 * Run a command on the panel host and yield stdout/stderr chunks as they
 * arrive. The generator returns the final `ExecResult` when the command
 * completes. Used by `terminal.ts` / `deployer.ts` to stream live output to
 * the dashboard via socket.io.
 */
export async function* execStreamLocal(
  command: string,
  opts: ExecOpts = {}
): AsyncGenerator<StreamChunk, ExecResult, void> {
  const start = Date.now()
  const timeoutMs = opts.timeoutMs ?? 60000
  const child = spawn('bash', ['-lc', command], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const chunks: StreamChunk[] = []
  let resolved = false
  let finalResult!: ExecResult
  const waiters: Array<() => void> = []
  const notify = () => {
    while (waiters.length > 0) {
      const w = waiters.shift()!
      w()
    }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      child.kill('SIGKILL')
    } catch {
      /* noop */
    }
  }, timeoutMs)

  child.stdout?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stdout', data: c.toString('utf8') })
    notify()
  })
  child.stderr?.on('data', (c: Buffer) => {
    chunks.push({ stream: 'stderr', data: c.toString('utf8') })
    notify()
  })
  child.on('error', (err) => {
    clearTimeout(timer)
    finalResult = {
      stdout: '',
      stderr: err.message,
      exitCode: -1,
      durationMs: Date.now() - start,
    }
    resolved = true
    notify()
  })
  child.on('close', (code, signal) => {
    clearTimeout(timer)
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
      stderr: timedOut
        ? stderr + (stderr ? '\n' : '') + `Command timed out after ${timeoutMs}ms`
        : stderr,
      exitCode: code ?? (timedOut ? -1 : null),
      signal: signal ?? undefined,
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

// ─── LocalClient: ssh2-compatible Client shim ────────────────────────────

/**
 * The stream object handed back from `LocalClient.exec()`. Mirrors the
 * ssh2 ClientChannel surface used by `ssh.ts`:
 *   - `.on('data', cb)`         — stdout chunks (Buffer)
 *   - `.stderr.on('data', cb)`  — stderr chunks (Buffer)
 *   - `.on('close', cb)`        — (exitCode, signal?) when the process exits
 *   - `.on('error', cb)`        — spawn errors
 *   - `.end()`                  — kill the process (SIGKILL)
 */
class LocalStream extends EventEmitter {
  private _child: ChildProcess | null = null
  // A plain EventEmitter — NOT another LocalStream. Using LocalStream here made
  // the constructor recurse infinitely (each stderr bus built its own stderr
  // bus …), which crashed every localhost exec with "Maximum call stack size
  // exceeded". The stderr bus only ever needs .on('data')/.emit('data').
  private readonly _stderrBus: EventEmitter

  constructor() {
    super()
    this._stderrBus = new EventEmitter()
  }

  /** The stderr bus — `stream.stderr.on('data', cb)`. */
  get stderr(): EventEmitter {
    return this._stderrBus
  }

  /** Attach a spawned child process and forward its I/O to our listeners. */
  _attach(child: ChildProcess): void {
    this._child = child
    let closed = false
    const close = (code: number | null, signal?: string) => {
      if (closed) return
      closed = true
      this.emit('close', code, signal)
    }
    child.stdout?.on('data', (c: Buffer) => this.emit('data', c))
    child.stderr?.on('data', (c: Buffer) => this._stderrBus.emit('data', c))
    child.on('close', (code: number | null, signal?: string) => close(code, signal))
    child.on('error', (err: Error) => {
      // A spawn failure (e.g. no bash on this host) fires on the tick right
      // after spawn() — before the exec callback has attached its listeners.
      // Re-emitting it then hit nobody, which Node turns into an uncaught
      // exception that can take the whole panel down, and the caller waited
      // out its timeout. Defer to setImmediate (after the callback's
      // nextTick), then report it as 'error' if someone listens, otherwise
      // the way a shell would: on stderr with exit code 127.
      setImmediate(() => {
        if (this.listenerCount('error') > 0) {
          this.emit('error', err)
          return
        }
        this._stderrBus.emit('data', Buffer.from(`${err.message}\n`))
        close(127)
      })
    })
  }

  /** Kill the attached child process. Safe to call multiple times. */
  end(): void {
    try {
      this._child?.kill('SIGKILL')
    } catch {
      /* noop */
    }
  }
}

/**
 * The SFTP shim handed back from `LocalClient.sftp()`. `ssh.ts`'s `putFile`
 * and `getFile` already buffer through a local temp file, so for localhost
 * servers we just copy that temp file to/from the (local) remote path.
 */
type TransferCb = (err?: Error | null) => void
type TransferOpts = { step?: (transferred: number, chunk: number, total: number) => void }

export function localTransfer(
  src: string,
  dest: string,
  optsOrCb: TransferOpts | TransferCb,
  maybeCb?: TransferCb
): void {
  const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb
  const opts = typeof optsOrCb === 'function' ? {} : optsOrCb || {}
  if (typeof cb !== 'function') throw new TypeError('fastPut/fastGet: a callback is required')
  copyFile(src, dest)
    .then(async () => {
      if (opts.step) {
        const { size } = await stat(dest)
        opts.step(size, size, size)
      }
    })
    .then(
      () => cb(undefined),
      (err) => cb(err instanceof Error ? err : new Error(String(err)))
    )
}

class LocalSftp {
  // ssh2's signature is (src, dest, [options], callback). Accept both forms:
  // treating the options object as the callback left the caller waiting
  // forever after a successful copy (imports hung at "Transferring backup").
  fastPut(localSrc: string, remoteDest: string, optsOrCb: TransferOpts | TransferCb, cb?: TransferCb): void {
    localTransfer(localSrc, remoteDest, optsOrCb, cb)
  }
  fastGet(remoteSrc: string, localDest: string, optsOrCb: TransferOpts | TransferCb, cb?: TransferCb): void {
    localTransfer(remoteSrc, localDest, optsOrCb, cb)
  }
  chmod(remotePath: string, mode: number, cb: (err?: Error) => void): void {
    chmod(remotePath, mode)
      .then(() => cb(undefined))
      .catch(cb)
  }
}

type ExecCallback = (err: Error | null, stream: LocalStream) => void
type SftpCallback = (err: Error | null, sftp: LocalSftp) => void

/**
 * Drop-in replacement for ssh2's `Client` that runs commands on the panel
 * host via `child_process`. Only the methods used by `ssh.ts` are implemented:
 * `exec`, `sftp`, `end`, `destroy`.
 *
 * The `exec` signature mirrors ssh2: `exec(command, options, callback)`. The
 * command passed in is already wrapped as `bash -lc '...'` by `ssh.ts`, so we
 * just hand it to `bash -c`. The callback is invoked on `process.nextTick` so
 * any listeners the caller registers inside the callback are in place before
 * the first `data` event fires (child process I/O is always delivered on a
 * later tick than nextTick).
 */
export class LocalClient {
  exec(command: string, _opts: unknown, cb: ExecCallback): void {
    let child: ChildProcess
    try {
      child = spawn('bash', ['-c', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      process.nextTick(() =>
        cb(err instanceof Error ? err : new Error(String(err)), new LocalStream())
      )
      return
    }
    const stream = new LocalStream()
    stream._attach(child)
    process.nextTick(() => cb(null, stream))
  }

  sftp(cb: SftpCallback): void {
    process.nextTick(() => cb(null, new LocalSftp()))
  }

  end(): void {
    /* noop — child processes are owned by their LocalStream */
  }

  destroy(): void {
    /* noop */
  }
}
