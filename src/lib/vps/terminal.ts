/**
 * Terminal Module
 * ===============
 *
 * Provides an HTTP-polling-based "web terminal" that runs commands inside a
 * project's own container.
 *
 * Execution modes:
 *
 *   - REAL (any server with a usable connection, INCLUDING localhost):
 *       Every command runs inside the project's container via
 *       `docker exec <container> sh -c '…'`. The docker CLI itself is started
 *       with a minimal environment (`env -i`, see COMPOSE_ENV) so nothing of
 *       the panel's own environment is visible. If the project has no
 *       container, or it is not running, the command is refused — a customer
 *       command never runs on the host.
 *
 *       Before this, a localhost server ran the customer's command straight
 *       on the panel host with `bash -lc` — as root, with the panel's
 *       JWT_SECRET / ENCRYPTION_KEY / DATABASE_URL in its environment and
 *       every other tenant's files on disk.
 *
 *   - DEMO (no server, or a remote server in demo mode):
 *       Synthetic responses for common commands so the panel's terminal UI
 *       is functional in pure-demo mode.
 *
 * Because the panel doesn't run a websocket specifically for terminals, the
 * UI sends commands one at a time via POST `/api/hosting/[id]/terminal` and
 * receives `{ stdout, stderr, exitCode, cwd, durationMs }` synchronously.
 *
 * Session state (cwd + history) is held in-memory keyed by sessionId. There's
 * no persistence — terminals are ephemeral and tied to the process.
 *
 * Security:
 *   - Every command must include a sessionId that belongs to the projectId
 *     in the URL (validated against the in-memory map).
 *   - The container name comes from the database (set by the deployer) and
 *     is validated and shell-quoted; the customer command and the working
 *     directory reach the container as positional arguments of a fixed
 *     script, never spliced into the host-side command line unquoted.
 *   - The API route writes an audit entry for every command.
 */
import crypto from 'crypto'
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  isServerInDemoMode,
  isLocalHost,
  type SshCredentials,
} from './ssh'
import { getServerCredentials } from './provisioner'
import { COMPOSE_ENV, shellQuoteArg } from './deploy-safety'

// ─── Types ───────────────────────────────────────────────────────────────

export interface TerminalSession {
  id: string
  projectId: string
  createdAt: number
  lastActivity: number
  cwd: string
  /** The container's starting directory (its WORKDIR); `cd ~` in demo mode. */
  homeDir: string
  history: string[]
}

export interface TerminalCommandResult {
  stdout: string
  stderr: string
  exitCode: number
  cwd: string
  durationMs: number
}

/** An error whose message is safe to show to the customer, with an HTTP status. */
export class TerminalError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'TerminalError'
    this.status = status
  }
}

export const TERMINAL_NO_CONTAINER_MESSAGE =
  'This website has no container yet. Deploy and start the website to use the terminal.'
export const TERMINAL_NOT_RUNNING_MESSAGE =
  "The website's container is not running. Start the website to use the terminal."

// ─── In-memory session store ─────────────────────────────────────────────

const MAX_HISTORY = 100
const SESSION_TTL_MS = 30 * 60 * 1000 // 30 min idle → eligible for GC
const COMMAND_TIMEOUT_MS = 60000

const sessions = new Map<string, TerminalSession>()

// Periodic GC of stale sessions (runs once per session creation).
function gcSessions(): void {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > SESSION_TTL_MS) {
      sessions.delete(id)
    }
  }
}

// ─── Container exec (pure, unit-tested) ──────────────────────────────────

/** Printed on stderr by the host-side wrapper when the container is not running. */
export const CONTAINER_NOT_RUNNING_MARKER = '__APSAMO_CONTAINER_NOT_RUNNING__'

/** Docker container names the panel creates (and nothing option-like). */
export function isSafeContainerName(name: string | null | undefined): name is string {
  return !!name && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(name)
}

/**
 * Host-side shell command that runs `script` with `sh -c` INSIDE the
 * container, passing `args` as $1, $2, … . Refuses (exit 125 + marker on
 * stderr) unless the container exists and is running. The docker CLI gets a
 * minimal environment, so the panel's secrets are never in reach.
 *
 * Shared by the terminal and by cron jobs.
 */
export function buildContainerExecCommand(
  containerName: string,
  script: string,
  args: string[] = []
): string {
  if (!isSafeContainerName(containerName)) {
    throw new TerminalError(TERMINAL_NO_CONTAINER_MESSAGE, 409)
  }
  const c = shellQuoteArg(containerName)
  const argv = args.map((a) => ' ' + shellQuoteArg(a)).join('')
  return (
    `if [ "$(${COMPOSE_ENV}docker container inspect -f '{{.State.Running}}' ${c} 2>/dev/null)" != "true" ]; then ` +
    `echo ${CONTAINER_NOT_RUNNING_MARKER} >&2; exit 125; fi; ` +
    `${COMPOSE_ENV}docker exec ${c} sh -c ${shellQuoteArg(script)} sh${argv}`
  )
}

/**
 * Runs inside the container. $1 = working directory (may be empty → the
 * container's WORKDIR), $2 = the customer's command. `eval` keeps `cd`
 * effective, and the trailer reports the exit code and the new directory.
 */
export const TERMINAL_SCRIPT =
  '[ -n "$1" ] && cd "$1" 2>/dev/null; ' +
  'eval "$2" 2>&1; ' +
  '__apsamo_rc=$?; ' +
  'printf \'\\n__APSAMO_EXIT:%s:%s\\n\' "$__apsamo_rc" "$(pwd)"'

/** Split the terminal script's output into the command's output, exit code and cwd. */
export function parseTerminalOutput(
  stdout: string
): { body: string; exitCode: number | null; cwd: string | null } {
  const m = stdout.match(/\n__APSAMO_EXIT:(-?\d+):([^\n]*)\n?$/)
  if (!m || m.index === undefined) return { body: stdout, exitCode: null, cwd: null }
  return {
    body: stdout.slice(0, m.index).replace(/\n$/, ''),
    exitCode: parseInt(m[1], 10),
    cwd: m[2] || null,
  }
}

/**
 * Commands that touch Docker or escalate privileges. They run inside the
 * container like everything else; the category goes into the audit entry.
 */
export function flagSensitiveCommand(cmd: string): string | null {
  const lower = cmd.toLowerCase().trim()
  if (lower.startsWith('docker ')) return 'docker'
  if (lower.startsWith('sudo ')) return 'sudo'
  if (lower.includes('sudo su')) return 'sudo-su'
  if (lower.startsWith('su ')) return 'su'
  if (lower.startsWith('chmod ')) return 'chmod'
  if (lower.startsWith('chown ')) return 'chown'
  return null
}

/**
 * If the command is a `cd <dir>` invocation, return the new working
 * directory (relative to the current cwd). Returns null otherwise.
 * Used by demo mode only — real sessions read the directory back.
 */
function applyCd(session: TerminalSession, cmd: string): string | null {
  const trimmed = cmd.trim()
  const m = trimmed.match(/^cd\s+(.+)$/)
  if (!m) return null
  let target = m[1].trim().replace(/^['"]|['"]$/g, '')
  if (target === '-') return null // cd - swaps to OLDPWD — we don't track that.
  if (target === '~' || target === '') target = session.homeDir
  if (target.startsWith('/')) {
    return target
  }
  // Relative — join with cwd.
  const base = session.cwd.replace(/\/$/, '')
  const next = base + '/' + target
  // Normalize `..` segments.
  const parts = next.split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '' || p === '.') continue
    if (p === '..') {
      out.pop()
      continue
    }
    out.push(p)
  }
  return '/' + out.join('/')
}

// ─── Project lookup ──────────────────────────────────────────────────────

type ProjectWithServer = NonNullable<
  Awaited<ReturnType<typeof loadProject>>
>

function loadProject(projectId: string) {
  return db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
}

/** No server, or a remote server in demo mode → synthetic terminal. */
function isDemoProject(project: ProjectWithServer): boolean {
  if (!project.server) return true
  if (isLocalHost(project.server.sshHost)) return false
  return isServerInDemoMode(project.server)
}

/** Run the terminal script in the project's container. Throws TerminalError when it cannot. */
async function runInContainer(
  project: ProjectWithServer,
  cwd: string,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  if (!project.serverId || !isSafeContainerName(project.containerName)) {
    throw new TerminalError(TERMINAL_NO_CONTAINER_MESSAGE, 409)
  }
  const fullCmd = buildContainerExecCommand(project.containerName, TERMINAL_SCRIPT, [cwd, command])
  const creds: SshCredentials = await getServerCredentials(project.serverId)
  const r = await withConnection(creds, (client) =>
    exec(client, fullCmd, { timeoutMs: COMMAND_TIMEOUT_MS })
  )
  if ((r.stderr || '').includes(CONTAINER_NOT_RUNNING_MARKER)) {
    throw new TerminalError(TERMINAL_NOT_RUNNING_MESSAGE, 409)
  }
  return { stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.exitCode }
}

// ─── Public API ──────────────────────────────────────────────────────────

export async function createTerminalSession(
  projectId: string
): Promise<TerminalSession> {
  gcSessions()

  const project = await loadProject(projectId)
  if (!project) throw new TerminalError('Project not found', 404)

  // Demo → /app. Real → whatever the container's WORKDIR is; the probe also
  // refuses the session when there is no running container.
  let cwd = '/app'
  if (!isDemoProject(project)) {
    const probe = await runInContainer(project, '', 'pwd')
    const parsed = parseTerminalOutput(probe.stdout)
    cwd = parsed.cwd || parsed.body.trim().split('\n').pop() || '/'
  }

  const session: TerminalSession = {
    id: crypto.randomBytes(12).toString('hex'),
    projectId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    cwd,
    homeDir: cwd,
    history: [],
  }
  sessions.set(session.id, session)
  return session
}

export async function listTerminalSessions(
  projectId: string
): Promise<TerminalSession[]> {
  const out: TerminalSession[] = []
  for (const s of sessions.values()) {
    if (s.projectId === projectId) out.push(s)
  }
  return out.sort((a, b) => b.lastActivity - a.lastActivity)
}

export async function closeTerminalSession(
  projectId: string,
  sessionId: string
): Promise<void> {
  const s = sessions.get(sessionId)
  if (!s || s.projectId !== projectId) return
  sessions.delete(sessionId)
}

export async function runTerminalCommand(
  projectId: string,
  sessionId: string,
  command: string
): Promise<TerminalCommandResult> {
  const start = Date.now()
  const session = sessions.get(sessionId)
  if (!session || session.projectId !== projectId) {
    throw new TerminalError('Terminal session not found — start a new session', 404)
  }
  session.lastActivity = Date.now()
  session.history.push(command)
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY)
  }

  const project = await loadProject(projectId)
  if (!project) throw new TerminalError('Project not found', 404)

  // Demo mode: synthetic responses for common commands.
  if (isDemoProject(project)) {
    const result = demoRun(session, command)
    return { ...result, durationMs: Date.now() - start }
  }

  // Throws TerminalError (409) when there is no running container — never
  // falls back to the host.
  if (!project.serverId || !isSafeContainerName(project.containerName)) {
    throw new TerminalError(TERMINAL_NO_CONTAINER_MESSAGE, 409)
  }

  try {
    const r = await runInContainer(project, session.cwd, command)
    const parsed = parseTerminalOutput(r.stdout)
    if (parsed.cwd) session.cwd = parsed.cwd
    return {
      stdout: parsed.body,
      stderr: r.stderr,
      exitCode: parsed.exitCode ?? r.exitCode ?? -1,
      cwd: session.cwd,
      durationMs: Date.now() - start,
    }
  } catch (err) {
    if (err instanceof TerminalError) throw err
    const msg = err instanceof Error ? err.message : String(err)
    return {
      stdout: '',
      stderr: /timeout/i.test(msg) ? `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s` : 'Command failed to run',
      exitCode: -1,
      cwd: session.cwd,
      durationMs: Date.now() - start,
    }
  }
}

// ─── Demo-mode command runner ────────────────────────────────────────────

function demoRun(session: TerminalSession, command: string): TerminalCommandResult {
  const trimmed = command.trim()
  const args = trimmed.split(/\s+/)
  const prog = args[0] || ''

  // cd
  const newCwd = applyCd(session, command)
  if (newCwd !== null) {
    session.cwd = newCwd
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      cwd: session.cwd,
      durationMs: 0,
    }
  }

  // pwd
  if (prog === 'pwd') {
    return {
      stdout: session.cwd + '\n',
      stderr: '',
      exitCode: 0,
      cwd: session.cwd,
      durationMs: 0,
    }
  }

  // whoami
  if (prog === 'whoami' || prog === 'id') {
    return {
      stdout: 'root\n',
      stderr: '',
      exitCode: 0,
      cwd: session.cwd,
      durationMs: 0,
    }
  }

  // echo
  if (prog === 'echo') {
    const val = args.slice(1).join(' ').replace(/^["']|["']$/g, '')
    return {
      stdout: val + '\n',
      stderr: '',
      exitCode: 0,
      cwd: session.cwd,
      durationMs: 0,
    }
  }

  // ls
  if (prog === 'ls') {
    const entries =
      session.cwd === '/app'
        ? ['Dockerfile', 'README.md', 'index.html', 'package.json', 'public', 'src']
        : []
    return {
      stdout: entries.join('  ') + '\n',
      stderr: '',
      exitCode: 0,
      cwd: session.cwd,
      durationMs: 0,
    }
  }

  // clear
  if (prog === 'clear') {
    return { stdout: '\x1bc', stderr: '', exitCode: 0, cwd: session.cwd, durationMs: 0 }
  }

  // exit
  if (prog === 'exit') {
    return {
      stdout: 'session closed\n',
      stderr: '',
      exitCode: 0,
      cwd: session.cwd,
      durationMs: 0,
    }
  }

  // Generic — command not found.
  return {
    stdout: '',
    stderr: `sh: ${prog}: command not found (demo mode)\n`,
    exitCode: 127,
    cwd: session.cwd,
    durationMs: 0,
  }
}
