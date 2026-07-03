/**
 * Terminal Module
 * ===============
 *
 * Provides an HTTP-polling-based "web terminal" that runs commands in a
 * project's execution context.
 *
 * Two execution modes:
 *
 *   - LOCAL (server.sshHost === 'localhost' / 127.0.0.1 / ::1):
 *       Commands run directly on the panel host via `bash -lc` (no `docker
 *       exec` wrap). The default working directory is the project's storage
 *       root (`<STORAGE_ROOT>/projects/<projectId>/`). `cd ~` resolves to the
 *       project root. No Docker required — works in the sandbox.
 *
 *   - REMOTE (real VPS over SSH):
 *       Commands run inside the project's deploy container via
 *       `docker exec -i <container> sh -c '…'`. Default cwd is `/app`.
 *
 *   - DEMO (no sshHost + no creds):
 *       Synthetic responses for common commands so the panel's terminal UI
 *       is functional in pure-demo mode.
 *
 * Because the panel doesn't run a websocket specifically for terminals, the
 * UI sends commands one at a time via POST `/api/hosting/[id]/terminal` and
 * receives `{ stdout, stderr, exitCode, cwd, durationMs }` synchronously.
 *
 * Session state (cwd + history) is held in-memory keyed by sessionId. There's
 * no persistence — terminals are ephemeral and tied to the Node.js process.
 * If the dev server restarts, all sessions are lost (the UI just creates a
 * new one).
 *
 * Security:
 *   - Every command must include a sessionId that belongs to the projectId
 *     in the URL (validated against the in-memory map).
 *   - In REMOTE mode we never let the command escape the container — even
 *     `docker` itself runs inside the container's PID namespace, not the
 *     host's.
 *   - In LOCAL mode commands run as the panel process user. Sensitive
 *     commands (`docker`, `sudo`, etc.) are flagged in the audit log by the
 *     API route.
 */
import crypto from 'crypto'
import path from 'path'
import { db } from '@/lib/db'
import {
  withConnection,
  exec,
  isServerInDemoMode,
  isLocalHost,
  type SshCredentials,
} from './ssh'
import { ensureDir } from './local-exec'
import { getServerCredentials } from './provisioner'

// ─── Per-project storage root (LOCAL mode) ──────────────────────────────

const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join(process.cwd(), 'storage')

function PROJECT_ROOT(projectId: string): string {
  return path.join(STORAGE_ROOT, 'projects', projectId)
}

// ─── Types ───────────────────────────────────────────────────────────────

export interface TerminalSession {
  id: string
  projectId: string
  createdAt: number
  lastActivity: number
  cwd: string
  /** In LOCAL mode, the project root used as the "home" directory. */
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

// ─── In-memory session store ─────────────────────────────────────────────

const MAX_HISTORY = 100
const SESSION_TTL_MS = 30 * 60 * 1000 // 30 min idle → eligible for GC

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

// ─── Helpers ─────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_\-=/.,:@+]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Commands that touch the host Docker daemon or escalate privileges. We
 * still run them (the container can't actually escape) but log them so
 * audits show what happened. Returns the matched category for logging.
 */
function flagSensitiveCommand(cmd: string): string | null {
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

// ─── Public API ──────────────────────────────────────────────────────────

export async function createTerminalSession(
  projectId: string
): Promise<TerminalSession> {
  gcSessions()

  // Determine the home directory + default cwd based on the project's server.
  // LOCAL → project storage root; REMOTE → /app (inside container); DEMO → /app.
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  const localMode = isLocalHost(project?.server?.sshHost)
  const homeDir = localMode && project ? PROJECT_ROOT(projectId) : '/app'
  if (localMode && project) {
    // Best-effort: create the project root so `cd ~` works immediately.
    await ensureDir(homeDir).catch(() => {})
  }

  const session: TerminalSession = {
    id: crypto.randomBytes(12).toString('hex'),
    projectId,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    cwd: homeDir,
    homeDir,
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
  if (!session) throw new Error('Terminal session not found')
  if (session.projectId !== projectId) {
    throw new Error('Terminal session does not belong to this project')
  }
  session.lastActivity = Date.now()
  session.history.push(command)
  if (session.history.length > MAX_HISTORY) {
    session.history = session.history.slice(-MAX_HISTORY)
  }

  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { server: true },
  })
  if (!project) throw new Error('Project not found')

  const localMode = isLocalHost(project.server?.sshHost)

  // LOCAL mode: no container required — we run bash directly on the host.
  // REMOTE mode: container is required for `docker exec` wrapping.
  if (!localMode && !project.containerName) {
    throw new Error('Project has no running container')
  }

  // Flag sensitive commands (we don't block — but the API route can audit).
  const flag = flagSensitiveCommand(command)
  if (flag) {
    console.warn(
      `[vps-terminal] Project ${projectId} session ${sessionId} running sensitive command (${flag}): ${command}`
    )
  }

  // Demo mode: synthetic responses for common commands.
  if (!localMode && (project.server ? isServerInDemoMode(project.server) : true)) {
    const result = demoRun(session, command)
    return { ...result, durationMs: Date.now() - start }
  }

  const creds: SshCredentials = await getServerCredentials(project.serverId!)
  try {
    return await withConnection(creds, async (client) => {
      // Wrap the command so we can extract the exit code from the trailing
      // EXIT:N marker. We capture combined output (2>&1) for the marker.
      const wrapped = `cd ${shellQuote(session.cwd)} && (${command}) 2>&1; echo "EXIT:$?"`
      const fullCmd = localMode
        ? wrapped
        : `docker exec -i ${shellQuote(project.containerName!)} sh -c ${shellQuote(wrapped)}`
      const r = await exec(client, fullCmd, { timeoutMs: 60000 })
      const combined = r.stdout || ''
      // Find the trailing EXIT:N marker.
      const m = combined.match(/EXIT:(-?\d+)\s*$/)
      let exitCode = r.exitCode ?? 0
      let body = combined
      if (m) {
        exitCode = parseInt(m[1], 10)
        body = combined.slice(0, m.index).replace(/\n$/, '')
      }
      // Update cwd if the command was a cd.
      const newCwd = applyCd(session, command)
      if (newCwd) session.cwd = newCwd

      return {
        stdout: body,
        stderr: '',
        exitCode,
        cwd: session.cwd,
        durationMs: Date.now() - start,
      }
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      stdout: '',
      stderr: msg,
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
