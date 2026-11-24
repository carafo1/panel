/**
 * docker-exec SQL transport
 * =========================
 *
 * The panel host cannot reach a tenant DB container over TCP (the `deployhub`
 * network is not host-routable), so we run the engine's own CLI client INSIDE
 * the container via `docker exec` and talk to it over stdio.
 *
 * Two deliberate safety choices:
 *   1. The password is passed via the `MYSQL_PWD` / `PGPASSWORD` environment
 *      variable (`docker exec -e ...`), NEVER on the argv — so it can't leak
 *      into the container's process list.
 *   2. The SQL text is fed on STDIN, never interpolated into a shell command —
 *      so there is no shell-injection surface, regardless of what SQL the user
 *      types in the editor.
 *
 * This module is intentionally local-only (spawns `docker` on this host). Remote
 * project servers (project.server.sshHost != local) are a later enhancement that
 * will route the same stdio through the existing SSH exec helper.
 */
import { spawn } from 'child_process'
import type { DbEngine } from './types'

export interface ExecInput {
  engine: DbEngine
  container: string
  user: string
  password: string
  database?: string
  /** SQL text piped to the client on stdin */
  sql: string
  timeoutMs?: number
  /** extra client flags appended before the database name */
  clientArgs?: string[]
}

export interface ExecResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
  /** true when we killed the process for exceeding timeoutMs */
  timedOut: boolean
}

/**
 * Run the MySQL-family client that exists in the container. MariaDB images
 * ship `mariadb` / `mariadb-dump`; MySQL images (mysql:8) only ship
 * `mysql` / `mysqldump`. Always calling `mariadb` made every query on a
 * MySQL database fail ("executable file not found", reported as a bare
 * "Query failed"). Arguments are passed positionally to sh ("$@"), never
 * interpolated into the script.
 */
export function mysqlFamilyClient(preferred: string, fallback: string): string[] {
  return [
    'sh',
    '-c',
    `if command -v ${preferred} >/dev/null 2>&1; then exec ${preferred} "$@"; else exec ${fallback} "$@"; fi`,
    'sh',
  ]
}

/** Hard ceiling on output we buffer, to protect the panel from a runaway query. */
const MAX_OUTPUT_BYTES = 25 * 1024 * 1024 // 25 MB

/**
 * Build the argv for `docker exec`. The mysql/mariadb client runs in `--batch`
 * mode (tab-separated, escaped output) unless the caller overrides clientArgs.
 */
function buildArgs(input: ExecInput): { cmd: string; args: string[]; env: string } {
  const isPg = input.engine === 'postgres'
  if (isPg) {
    // psql: -A unaligned, -F '\t' field sep, -t tuples-only handled by caller.
    const args = [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${input.password}`,
      input.container,
      'psql',
      '-U',
      input.user,
      '-h',
      '127.0.0.1',
      '-w',
      ...(input.database ? ['-d', input.database] : []),
      ...(input.clientArgs ?? ['-A', '-F', '\t']),
    ]
    return { cmd: 'docker', args, env: 'PGPASSWORD' }
  }
  // mysql / mariadb
  const args = [
    'exec',
    '-i',
    '-e',
    `MYSQL_PWD=${input.password}`,
    input.container,
    ...mysqlFamilyClient('mariadb', 'mysql'),
    `-u${input.user}`,
    ...(input.clientArgs ?? ['--batch']),
    ...(input.database ? [input.database] : []),
  ]
  return { cmd: 'docker', args, env: 'MYSQL_PWD' }
}

/**
 * Execute SQL inside a tenant DB container and return the raw client output.
 * Never throws for SQL errors — those come back as `ok:false` + stderr so the
 * caller can surface them to the user. Only rejects on a spawn failure.
 */
export function execSql(input: ExecInput): Promise<ExecResult> {
  const timeoutMs = input.timeoutMs ?? 30_000
  const { cmd, args } = buildArgs(input)
  const started = Date.now()

  return new Promise<ExecResult>((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''
    let outBytes = 0
    let settled = false
    let timedOut = false

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        durationMs: Date.now() - started,
        timedOut,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      stderr += `\n[query cancelled: exceeded ${timeoutMs}ms time limit]`
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, timeoutMs)

    child.stdout.on('data', (d: Buffer) => {
      outBytes += d.length
      if (outBytes > MAX_OUTPUT_BYTES) {
        stderr += `\n[result truncated: exceeded ${MAX_OUTPUT_BYTES} bytes]`
        try {
          child.kill('SIGKILL')
        } catch {
          /* noop */
        }
        return
      }
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (e: Error) => {
      stderr += (stderr ? '\n' : '') + (e?.message || String(e))
      finish(null)
    })
    child.on('close', (code) => finish(code))

    // Feed the SQL on stdin, then close it so the client executes and exits.
    try {
      child.stdin.write(input.sql)
      if (!/;\s*$/.test(input.sql)) child.stdin.write(';')
      child.stdin.write('\n')
      child.stdin.end()
    } catch {
      /* stdin may already be closed if spawn failed; close handler resolves */
    }
  })
}

// ─── Output parsing (mysql/mariadb --batch = escaped TSV) ────────────────────

/**
 * mysql/mariadb `--batch` output: first line is a tab-separated header, then one
 * tab-separated row per record. Real tabs, newlines and backslashes inside a
 * value are backslash-escaped by the client; a genuine SQL NULL is printed as
 * the token `NULL`. We reverse the escaping. (NULL vs the literal string "NULL"
 * is inherently ambiguous in --batch mode — grid reads use the JSON path in the
 * driver to avoid that; the ad-hoc SQL editor accepts the ambiguity.)
 */
export function parseBatchTsv(stdout: string): {
  columns: string[]
  rows: string[][]
} {
  const text = stdout.replace(/\r\n/g, '\n')
  if (text === '') return { columns: [], rows: [] }
  const lines = text.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (lines.length === 0) return { columns: [], rows: [] }

  const unescape = (s: string): string =>
    s.replace(/\\(.)/g, (_, c: string) =>
      c === 'n' ? '\n' : c === 't' ? '\t' : c === '0' ? '\0' : c === 'r' ? '\r' : c
    )
  const splitLine = (line: string): string[] => line.split('\t').map(unescape)

  const columns = splitLine(lines[0])
  const rows = lines.slice(1).map(splitLine)
  return { columns, rows }
}

// ─── Failure messages ──────────────────────────────────────────────────────

/**
 * Turn a raw `docker exec` failure into something a hosting customer can act
 * on. These paths are reached when the admin tool's container is stopped,
 * missing, or the daemon is unreachable — infrastructure problems the customer
 * can neither see nor fix, so telling them "container <sha> is not running"
 * only causes confusion. The raw text is still returned to the caller for the
 * audit log; only the customer-facing sentence is rewritten.
 */
export function friendlyContainerError(raw: string, tool: string): string {
  const t = (raw || '').toLowerCase()
  if (t.includes('is not running') || t.includes('is not up')) {
    return `${tool} is temporarily unavailable — the service is not running. Please try again in a moment, or contact support if this persists.`
  }
  if (t.includes('no such container') || t.includes('not found')) {
    return `${tool} is not available on this server yet. Please contact support.`
  }
  if (t.includes('cannot connect to the docker daemon') || t.includes('permission denied')) {
    return `${tool} could not be reached because of a server configuration problem. Please contact support.`
  }
  if (t.includes('timed out') || t.includes('timeout')) {
    return `${tool} took too long to respond. Please try again.`
  }
  return `${tool} could not be opened right now. Please try again, or contact support if this persists.`
}

// ─── mysqldump transport (Export) ──────────────────────────────────────────

export interface DumpInput {
  container: string
  user: string
  password: string
  database: string
  /** extra dump flags, e.g. ['--no-data'] for structure-only */
  extraArgs?: string[]
  timeoutMs?: number
  /** defaults to mariadb/mysql; 'postgres' switches to pg_dump */
  engine?: DbEngine
}

/**
 * Run `mariadb-dump` inside the tenant container and capture the SQL dump on
 * stdout. Password via MYSQL_PWD env (never argv). mariadb:11 ships
 * `mariadb-dump`; all tenant DBs use that image.
 */
export function execDump(input: DumpInput): Promise<ExecResult> {
  const timeoutMs = input.timeoutMs ?? 120_000
  const isPg = input.engine === 'postgres'
  const args = isPg
    ? [
        'exec',
        '-e',
        `PGPASSWORD=${input.password}`,
        input.container,
        'pg_dump',
        '-U',
        input.user,
        '-h',
        '127.0.0.1',
        '--no-owner',
        '--no-privileges',
        ...(input.extraArgs ?? []),
        input.database,
      ]
    : [
        'exec',
        '-e',
        `MYSQL_PWD=${input.password}`,
        input.container,
        ...mysqlFamilyClient('mariadb-dump', 'mysqldump'),
        `-u${input.user}`,
        '--single-transaction',
        '--skip-lock-tables',
        ...(input.extraArgs ?? []),
        input.database,
      ]
  const started = Date.now()
  return new Promise<ExecResult>((resolve) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let outBytes = 0
    let settled = false
    let timedOut = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, durationMs: Date.now() - started, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      stderr += `\n[export cancelled: exceeded ${timeoutMs}ms]`
      try {
        child.kill('SIGKILL')
      } catch {
        /* gone */
      }
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      outBytes += d.length
      if (outBytes > MAX_OUTPUT_BYTES) {
        stderr += `\n[export truncated: exceeded ${MAX_OUTPUT_BYTES} bytes]`
        try {
          child.kill('SIGKILL')
        } catch {
          /* noop */
        }
        return
      }
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (e: Error) => {
      stderr += (stderr ? '\n' : '') + (e?.message || String(e))
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}
