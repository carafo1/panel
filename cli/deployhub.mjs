#!/usr/bin/env node
/**
 * DeployHub CLI
 * =============
 * A standalone Node.js command-line interface for the DeployHub platform.
 *
 * Requires Node.js 18+ (uses built-in fetch, fs/promises, readline).
 * No external dependencies. Config is stored at ~/.deployhub/config.json.
 *
 * Authentication:
 *   - All API calls use the API key created from the DeployHub dashboard
 *     (Settings → API Keys) sent as `Authorization: Bearer <key>`.
 *   - The API key is persisted locally after `deployhub login`.
 *
 * Run `deployhub help` for the list of commands.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONFIG_DIR = path.join(os.homedir(), '.deployhub')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const DEFAULT_BASE_URL =
  process.env.DEPLOYHUB_BASE_URL || 'http://127.0.0.1:3000'

/**
 * Default config used when no file exists yet.
 * `baseUrl` is where the DeployHub API is reachable. The CLI never writes
 * absolute URLs into the request paths — everything is relative to baseUrl.
 */
function defaultConfig() {
  return {
    apiKey: null,
    baseUrl: DEFAULT_BASE_URL,
  }
}

async function loadConfig() {
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return { ...defaultConfig(), ...parsed }
  } catch {
    return defaultConfig()
  }
}

async function saveConfig(cfg) {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), {
    mode: 0o600,
  })
}

// ---------------------------------------------------------------------------
// Colors (ANSI escape codes — no external library)
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY
const NO_COLOR = process.env.NO_COLOR !== undefined

function paint(code, str) {
  if (!isTTY || NO_COLOR) return str
  return `\x1b[${code}m${str}\x1b[0m`
}

const c = {
  reset: (s) => s,
  green: (s) => paint('32', s),
  red: (s) => paint('31', s),
  yellow: (s) => paint('33', s),
  cyan: (s) => paint('36', s),
  gray: (s) => paint('90', s),
  bold: (s) => paint('1', s),
  dim: (s) => paint('2', s),
  magenta: (s) => paint('35', s),
}

// Status badge colors
const STATUS_COLORS = {
  live: 'green',
  building: 'yellow',
  deploying: 'yellow',
  queued: 'cyan',
  failed: 'red',
  rolled_back: 'gray',
  running: 'green',
  stopped: 'gray',
  error: 'red',
  creating: 'yellow',
  active: 'green',
  pending: 'yellow',
  expired: 'red',
  transferring: 'yellow',
}

function statusBadge(status) {
  const color = STATUS_COLORS[status] || 'gray'
  return c[color](status || 'unknown')
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

let _spinnerInterval = null
let _spinnerActive = false

function startSpinner(message) {
  if (!isTTY || NO_COLOR) {
    process.stdout.write(`${c.cyan('•')} ${message}\n`)
    return
  }
  _spinnerActive = true
  const chars = ['|', '/', '-', '\\']
  let i = 0
  process.stdout.write(`\r${c.cyan(chars[0])} ${message}`)
  _spinnerInterval = setInterval(() => {
    if (!_spinnerActive) return
    i = (i + 1) % chars.length
    process.stdout.write(`\r${c.cyan(chars[i])} ${message}`)
  }, 120)
}

function stopSpinner(finalMessage, kind = 'success') {
  if (_spinnerInterval) {
    clearInterval(_spinnerInterval)
    _spinnerInterval = null
  }
  _spinnerActive = false
  if (isTTY && !NO_COLOR) {
    process.stdout.write('\r\x1b[K') // clear line
  }
  if (finalMessage) {
    const icon =
      kind === 'success' ? c.green('✓') :
      kind === 'error' ? c.red('✗') :
      kind === 'warn' ? c.yellow('!') :
      c.cyan('•')
    process.stdout.write(`${icon} ${finalMessage}\n`)
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * Make an authenticated request to the DeployHub API.
 *
 * @param {string} path - relative path starting with `/api/...`
 * @param {object} opts - fetch options (method, body, headers)
 * @param {object} cfg - loaded config (for apiKey + baseUrl)
 * @param {boolean} requireAuth - if true and no apiKey, throws early
 */
async function apiRequest(path, opts = {}, cfg, requireAuth = true) {
  if (requireAuth && !cfg.apiKey) {
    throw new ApiError(
      'Not authenticated. Run `deployhub login <api-key>` first. ' +
        'You can create an API key from Settings → API Keys in the dashboard.',
      401
    )
  }
  const url = `${cfg.baseUrl.replace(/\/$/, '')}${path}`
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'deployhub-cli/1.0.0',
    ...(opts.headers || {}),
  }
  if (cfg.apiKey) {
    headers['Authorization'] = `Bearer ${cfg.apiKey}`
  }
  let res
  try {
    res = await fetch(url, { ...opts, headers })
  } catch (err) {
    throw new ApiError(
      `Network error contacting ${url}: ${err.message}. ` +
        'Check that the DeployHub server is running and DEPLOYHUB_BASE_URL is set correctly.',
      0,
      null
    )
  }
  const text = await res.text()
  let body = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === 'object' && (body.error || body.message)) ||
      `HTTP ${res.status} ${res.statusText}`
    throw new ApiError(msg, res.status, body)
  }
  return body
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Split argv into a command path, positional args and flags.
 *
 * Examples:
 *   ['env', 'set', 'proj1', 'KEY=val', '--json']
 *     => { command: ['env','set'], positional: ['proj1','KEY=val'], flags: { json: true } }
 *   ['deployments', 'proj1', '--json']
 *     => { command: ['deployments'], positional: ['proj1'], flags: { json: true } }
 */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  let i = 0
  while (i < argv.length) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      // Support --key=value or --key value
      if (key.includes('=')) {
        const [k, ...rest] = key.split('=')
        flags[k] = rest.join('=')
      } else if (
        i + 1 < argv.length &&
        !argv[i + 1].startsWith('--') &&
        // known boolean flags don't consume next arg
        !['json', 'help', 'reveal'].includes(key)
      ) {
        flags[key] = argv[i + 1]
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
    i++
  }
  return { positional, flags }
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printTable(rows, columns) {
  if (!rows || rows.length === 0) {
    process.stdout.write(c.gray('  (no records)\n'))
    return
  }
  const headers = columns.map((c0) => c0.header)
  const data = rows.map((r) => columns.map((c0) => c0.get(r) ?? ''))
  // compute widths
  const widths = headers.map((h, idx) => {
    let max = String(h).length
    for (const row of data) {
      const v = String(row[idx] ?? '')
      if (v.length > max) max = v.length
    }
    return max
  })
  // header
  const pad = (s, w) => String(s).padEnd(w)
  process.stdout.write('  ' + headers.map((h, i) => c.bold(pad(h, widths[i]))).join('  ') + '\n')
  process.stdout.write('  ' + widths.map((w) => '-'.repeat(w)).join('  ') + '\n')
  for (const row of data) {
    process.stdout.write('  ' + row.map((v, i) => pad(v, widths[i])).join('  ') + '\n')
  }
}

function timeAgo(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  const diff = Date.now() - d.getTime()
  if (diff < 0) {
    // Future date — show time-until
    const sec = Math.floor(-diff / 1000)
    if (sec < 60) return `in ${sec}s`
    const min = Math.floor(sec / 60)
    if (min < 60) return `in ${min}m`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `in ${hr}h`
    const day = Math.floor(hr / 24)
    if (day < 365) return `in ${day}d`
    return d.toISOString().slice(0, 10)
  }
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  return d.toISOString().slice(0, 10)
}

function formatDuration(sec) {
  if (sec == null) return '-'
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s > 0 ? `${s}s` : ''}`
}

function println(str = '') {
  process.stdout.write(str + '\n')
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdLogin(positional) {
  const apiKey = positional[0]
  if (!apiKey) {
    println(c.red('✗ Usage: deployhub login <api-key>'))
    println(c.gray('   Create an API key from Settings → API Keys in the dashboard.'))
    process.exit(1)
  }
  const cfg = await loadConfig()
  cfg.apiKey = apiKey
  // Test the connection by calling /api/auth/me
  startSpinner('Validating API key…')
  try {
    const body = await apiRequest('/api/auth/me', { method: 'GET' }, cfg, false)
    stopSpinner('API key valid', 'success')
    await saveConfig(cfg)
    println(c.green(`✓ Logged in as ${body.user.name} <${body.user.email}>`))
    println(c.gray(`  Role: ${body.user.role}`))
    println(c.gray(`  Config saved to ${CONFIG_FILE}`))
  } catch (err) {
    stopSpinner('Login failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }
}

async function cmdWhoami(flags) {
  const cfg = await loadConfig()
  if (!cfg.apiKey) {
    println(c.yellow('! Not authenticated. Run `deployhub login <api-key>` first.'))
    process.exit(1)
  }
  startSpinner('Fetching user…')
  try {
    const body = await apiRequest('/api/auth/me', { method: 'GET' }, cfg)
    stopSpinner('Authenticated', 'success')
    if (flags.json) {
      printJson(body.user)
      return
    }
    println(c.bold('Current user'))
    println(`  ${c.gray('Name:')}  ${body.user.name}`)
    println(`  ${c.gray('Email:')} ${body.user.email}`)
    println(`  ${c.gray('Role:')}  ${body.user.role}`)
    if (body.user.subscriptions && body.user.subscriptions.length > 0) {
      const sub = body.user.subscriptions[0]
      println(`  ${c.gray('Plan:')}  ${sub.plan?.name || '-'} (${sub.status})`)
    }
    println(`  ${c.gray('API key prefix:')} ${cfg.apiKey.slice(0, 8)}…`)
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }
}

async function cmdProjects(flags) {
  const cfg = await loadConfig()
  startSpinner('Loading projects…')
  try {
    const body = await apiRequest('/api/hosting', { method: 'GET' }, cfg)
    stopSpinner(`Loaded ${body.projects.length} project(s)`, 'success')
    if (flags.json) {
      printJson(body.projects)
      return
    }
    println()
    printTable(body.projects, [
      { header: 'NAME', get: (p) => p.name },
      { header: 'FRAMEWORK', get: (p) => p.framework },
      { header: 'STATUS', get: (p) => statusBadge(p.status) },
      { header: 'URL', get: (p) => p.customDomain || `https://${p.subdomain}` },
      { header: 'ID', get: (p) => c.gray(p.id) },
    ])
    println()
    println(c.gray(`  Tip: deploy a project with `) + c.cyan('deployhub deploy <name|id>'))
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }
}

/**
 * Resolve a project identifier (id or name or slug) to a project object.
 * Fetches the project list and matches by id, name (case-insensitive), or slug.
 */
async function resolveProject(cfg, identifier) {
  const body = await apiRequest('/api/hosting', { method: 'GET' }, cfg)
  const projects = body.projects || []
  const exact = projects.find((p) => p.id === identifier)
  if (exact) return exact
  const lower = identifier.toLowerCase()
  return (
    projects.find((p) => p.name.toLowerCase() === lower) ||
    projects.find((p) => p.slug?.toLowerCase() === lower) ||
    projects.find((p) => p.name.toLowerCase().includes(lower))
  )
}

async function cmdDeploy(positional) {
  const identifier = positional[0]
  if (!identifier) {
    println(c.red('✗ Usage: deployhub deploy <project-id|project-name>'))
    process.exit(1)
  }
  const cfg = await loadConfig()
  startSpinner(`Resolving project "${identifier}"…`)
  let project
  try {
    project = await resolveProject(cfg, identifier)
    if (!project) {
      stopSpinner('Project not found', 'error')
      println(c.red(`✗ No project matched "${identifier}"`))
      process.exit(1)
    }
    stopSpinner(`Found project: ${project.name}`, 'success')
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }

  if (project.status !== 'running') {
    println(
      c.yellow(`! Project status is "${project.status}", must be "running" to deploy.`)
    )
    process.exit(1)
  }

  println(c.cyan(`→ Triggering deployment for ${project.name}…`))
  let deployment
  try {
    const body = await apiRequest(
      `/api/hosting/${project.id}/deploy`,
      { method: 'POST' },
      cfg
    )
    deployment = body.deployment
  } catch (err) {
    println(c.red(`✗ Deploy failed: ${err.message}`))
    process.exit(1)
  }

  println(c.green(`✓ Deployment created: ${deployment.id}`))
  println(c.gray(`  Status: ${statusBadge(deployment.status)}`))
  if (deployment.deployUrl) {
    println(c.gray(`  URL:    ${deployment.deployUrl}`))
  }

  // Poll for status updates until terminal
  const terminal = new Set(['live', 'failed', 'rolled_back'])
  let pollCount = 0
  const maxPolls = 30
  let lastLogLineCount = 0
  while (pollCount < maxPolls) {
    await new Promise((r) => setTimeout(r, 2000))
    pollCount++
    let info
    try {
      const body = await apiRequest(
        `/api/deployments/${deployment.id}/logs`,
        { method: 'GET' },
        cfg
      )
      info = body.deployment
    } catch {
      // ignore transient errors
      continue
    }
    process.stdout.write(`\r${c.gray('status:')} ${statusBadge(info.status)} ` +
      c.gray(`(${pollCount * 2}s)   `))
    // Stream new build log lines
    if (info.buildLog) {
      const lines = info.buildLog.split('\n')
      if (lines.length > lastLogLineCount) {
        // Move to new line before printing logs
        process.stdout.write('\n')
        for (let i = lastLogLineCount; i < lines.length; i++) {
          if (lines[i]) println(`  ${c.gray('│')} ${lines[i]}`)
        }
        lastLogLineCount = lines.length
      }
    }
    if (terminal.has(info.status)) {
      println()
      if (info.status === 'live') {
        println(c.green(`✓ Deployment is live!`))
      } else {
        println(c.red(`✗ Deployment ended with status: ${info.status}`))
      }
      if (info.deployUrl) {
        println(c.gray(`  URL:      ${info.deployUrl}`))
      }
      if (info.duration) {
        println(c.gray(`  Duration: ${formatDuration(info.duration)}`))
      }
      return
    }
  }
  println()
  println(c.yellow('! Timed out waiting for deployment to finish. Check `deployhub logs <id>` for the latest state.'))
}

async function cmdDeployments(positional, flags) {
  const cfg = await loadConfig()
  const projectIdFilter = positional[0]
  startSpinner('Loading deployments…')
  let body
  try {
    body = await apiRequest('/api/deployments', { method: 'GET' }, cfg)
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }

  let deployments = body.deployments || []
  if (projectIdFilter) {
    // Resolve filter to a project ID (allow name/slug too)
    let filterId = projectIdFilter
    if (!deployments.some((d) => d.projectId === projectIdFilter)) {
      try {
        const project = await resolveProject(cfg, projectIdFilter)
        if (project) filterId = project.id
      } catch {
        /* ignore */
      }
    }
    deployments = deployments.filter((d) => d.projectId === filterId)
  }
  stopSpinner(`Loaded ${deployments.length} deployment(s)`, 'success')

  if (flags.json) {
    printJson(deployments)
    return
  }

  println()
  printTable(deployments, [
    { header: 'PROJECT', get: (d) => d.project?.name || d.projectId },
    { header: 'STATUS', get: (d) => statusBadge(d.status) },
    { header: 'DURATION', get: (d) => formatDuration(d.duration) },
    { header: 'WHEN', get: (d) => timeAgo(d.createdAt) },
    { header: 'ID', get: (d) => c.gray(d.id) },
  ])
  println()
  println(c.gray(`  Tip: view build logs with `) + c.cyan('deployhub logs <deployment-id>'))
}

async function cmdLogs(positional) {
  const id = positional[0]
  if (!id) {
    println(c.red('✗ Usage: deployhub logs <deployment-id>'))
    process.exit(1)
  }
  const cfg = await loadConfig()
  startSpinner('Fetching logs…')
  try {
    const body = await apiRequest(
      `/api/deployments/${id}/logs`,
      { method: 'GET' },
      cfg
    )
    stopSpinner('Loaded', 'success')
    const d = body.deployment
    println()
    println(c.bold('Deployment ' + d.id))
    println(`  ${c.gray('Project:')}  ${d.project?.name || d.projectId}`)
    println(`  ${c.gray('Status:')}   ${statusBadge(d.status)}`)
    if (d.branch) println(`  ${c.gray('Branch:')}   ${d.branch}`)
    if (d.commit) println(`  ${c.gray('Commit:')}   ${d.commit}`)
    if (d.deployUrl) println(`  ${c.gray('URL:')}      ${d.deployUrl}`)
    if (d.duration) println(`  ${c.gray('Duration:')} ${formatDuration(d.duration)}`)
    println(`  ${c.gray('Created:')}  ${timeAgo(d.createdAt)}`)
    println()
    println(c.bold('Build logs'))
    println(c.gray('─'.repeat(60)))
    if (body.logs && body.logs.trim()) {
      println(body.logs)
    } else {
      println(c.gray('  (no logs available)'))
    }
    println(c.gray('─'.repeat(60)))
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }
}

async function cmdEnvList(positional, flags) {
  const projectId = positional[0]
  if (!projectId) {
    println(c.red('✗ Usage: deployhub env list <project-id>'))
    process.exit(1)
  }
  const cfg = await loadConfig()
  // Resolve name → id
  let resolvedId = projectId
  const reveal = flags.reveal === true ? '?reveal=true' : ''
  startSpinner('Loading env vars…')
  try {
    // Try direct fetch first; if 404, attempt resolution
    try {
      const body = await apiRequest(
        `/api/hosting/${projectId}/env${reveal}`,
        { method: 'GET' },
        cfg
      )
      stopSpinner(`Loaded ${body.envVars.length} var(s)`, 'success')
      _printEnvTable(body.envVars, flags)
      return
    } catch (err) {
      if (err.status !== 404) throw err
      // Fall through to resolve
    }
    const project = await resolveProject(cfg, projectId)
    if (!project) {
      stopSpinner('Project not found', 'error')
      println(c.red(`✗ No project matched "${projectId}"`))
      process.exit(1)
    }
    resolvedId = project.id
    const body = await apiRequest(
      `/api/hosting/${resolvedId}/env${reveal}`,
      { method: 'GET' },
      cfg
    )
    stopSpinner(`Loaded ${body.envVars.length} var(s)`, 'success')
    _printEnvTable(body.envVars, flags)
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }
}

function _printEnvTable(envVars, flags) {
  if (flags.json) {
    printJson(envVars)
    return
  }
  println()
  if (envVars.length === 0) {
    println(c.gray('  (no environment variables set)'))
    println()
    return
  }
  printTable(envVars, [
    { header: 'KEY', get: (v) => v.key },
    { header: 'VALUE', get: (v) => c.gray(v.value) },
    { header: 'ENCRYPTED', get: (v) => (v.encrypted ? c.green('yes') : c.gray('no')) },
    { header: 'UPDATED', get: (v) => timeAgo(v.updatedAt) },
  ])
  println()
  if (flags.reveal) {
    println(c.yellow('  ⚠ Showing decrypted values — handle with care.'))
  } else {
    println(c.gray(`  Values are masked. Use `) + c.cyan('--reveal') + c.gray(' to fetch decrypted values.'))
  }
}

async function cmdEnvSet(positional, flags) {
  const projectId = positional[0]
  const kv = positional[1]
  if (!projectId || !kv) {
    println(c.red('✗ Usage: deployhub env set <project-id> <KEY=value>'))
    println(c.gray('   Example: deployhub env set proj123 DATABASE_URL=postgres://...'))
    process.exit(1)
  }
  const eq = kv.indexOf('=')
  if (eq <= 0) {
    println(c.red(`✗ Invalid format "${kv}". Expected KEY=value.`))
    process.exit(1)
  }
  const key = kv.slice(0, eq).trim()
  const value = kv.slice(eq + 1)
  const cfg = await loadConfig()

  // Resolve project name → id
  let resolvedId = projectId
  startSpinner(`Setting ${key}…`)
  try {
    let res
    try {
      res = await apiRequest(
        `/api/hosting/${projectId}/env`,
        {
          method: 'POST',
          body: JSON.stringify({ key, value }),
        },
        cfg
      )
    } catch (err) {
      if (err.status !== 404) {
        // Conflict (var already exists) → PATCH instead
        if (err.status === 409) {
          // Find varId by listing env
          const list = await apiRequest(
            `/api/hosting/${projectId}/env`,
            { method: 'GET' },
            cfg
          )
          const existing = (list.envVars || []).find((v) => v.key === key)
          if (!existing) throw err
          res = await apiRequest(
            `/api/hosting/${projectId}/env/${existing.id}`,
            {
              method: 'PATCH',
              body: JSON.stringify({ value }),
            },
            cfg
          )
        } else {
          throw err
        }
      } else {
        // try resolving name → id
        const project = await resolveProject(cfg, projectId)
        if (!project) throw err
        resolvedId = project.id
        try {
          res = await apiRequest(
            `/api/hosting/${resolvedId}/env`,
            {
              method: 'POST',
              body: JSON.stringify({ key, value }),
            },
            cfg
          )
        } catch (err2) {
          if (err2.status === 409) {
            const list = await apiRequest(
              `/api/hosting/${resolvedId}/env`,
              { method: 'GET' },
              cfg
            )
            const existing = (list.envVars || []).find((v) => v.key === key)
            if (!existing) throw err2
            res = await apiRequest(
              `/api/hosting/${resolvedId}/env/${existing.id}`,
              {
                method: 'PATCH',
                body: JSON.stringify({ value }),
              },
              cfg
            )
          } else {
            throw err2
          }
        }
      }
    }
    stopSpinner(`Set ${key}`, 'success')
    if (flags.json) {
      printJson(res.envVar)
      return
    }
    println(c.green(`✓ ${key} = ${res.envVar.value}  ${c.gray('(encrypted: ' + (res.envVar.encrypted ? 'yes' : 'no') + ')')}`))
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }
}

async function cmdEnvDelete(positional) {
  const projectId = positional[0]
  const key = positional[1]
  if (!projectId || !key) {
    println(c.red('✗ Usage: deployhub env delete <project-id> <KEY>'))
    process.exit(1)
  }
  const cfg = await loadConfig()
  startSpinner(`Deleting ${key}…`)
  try {
    // Resolve project name → id and look up varId
    let resolvedId = projectId
    let list
    try {
      list = await apiRequest(
        `/api/hosting/${projectId}/env`,
        { method: 'GET' },
        cfg
      )
    } catch (err) {
      if (err.status !== 404) throw err
      const project = await resolveProject(cfg, projectId)
      if (!project) throw err
      resolvedId = project.id
      list = await apiRequest(
        `/api/hosting/${resolvedId}/env`,
        { method: 'GET' },
        cfg
      )
    }
    const existing = (list.envVars || []).find((v) => v.key === key)
    if (!existing) {
      stopSpinner('Not found', 'warn')
      println(c.yellow(`! Environment variable "${key}" does not exist on this project.`))
      process.exit(1)
    }
    await apiRequest(
      `/api/hosting/${resolvedId}/env/${existing.id}`,
      { method: 'DELETE' },
      cfg
    )
    stopSpinner(`Deleted ${key}`, 'success')
    println(c.green(`✓ Deleted ${key}`))
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }
}

async function cmdDomains(flags) {
  const cfg = await loadConfig()
  startSpinner('Loading domains…')
  try {
    const body = await apiRequest('/api/domains', { method: 'GET' }, cfg)
    stopSpinner(`Loaded ${body.domains.length} domain(s)`, 'success')
    if (flags.json) {
      printJson(body.domains)
      return
    }
    println()
    printTable(body.domains, [
      { header: 'DOMAIN', get: (d) => d.name },
      { header: 'STATUS', get: (d) => statusBadge(d.status) },
      { header: 'REGISTRAR', get: (d) => d.registrar || '-' },
      { header: 'PROJECT', get: (d) => d.project?.name || c.gray('-') },
      { header: 'EXPIRES', get: (d) => (d.expiresAt ? timeAgo(d.expiresAt) : '-') },
      { header: 'ID', get: (d) => c.gray(d.id) },
    ])
  } catch (err) {
    stopSpinner('Failed', 'error')
    println(c.red(`✗ ${err.message}`))
    process.exit(1)
  }
}

function cmdHelp() {
  println()
  println(c.bold(c.cyan('DeployHub CLI') + c.gray(' v1.0.0')))
  println(c.gray('  Manage your DeployHub projects, deployments, env vars and domains from the terminal.'))
  println()
  println(c.bold('USAGE'))
  println(`  ${c.cyan('deployhub')} <command> [args] [options]`)
  println()
  println(c.bold('COMMANDS'))
  const rows = [
    ['login <api-key>', 'Save an API key and test the connection'],
    ['whoami', 'Show the currently authenticated user'],
    ['projects', 'List all your projects'],
    ['deploy <id|name>', 'Trigger a deployment and stream build logs'],
    ['deployments [id|name]', 'List recent deployments (optionally filtered by project)'],
    ['logs <deployment-id>', 'Show build logs for a specific deployment'],
    ['env list <project-id>', 'List environment variables (values masked)'],
    ['env set <project-id> <KEY=value>', 'Set (or update) an environment variable'],
    ['env delete <project-id> <KEY>', 'Delete an environment variable'],
    ['domains', 'List all your domains'],
    ['help', 'Show this help message'],
  ]
  for (const [cmd, desc] of rows) {
    println(`  ${c.green(cmd.padEnd(40))} ${desc}`)
  }
  println()
  println(c.bold('OPTIONS'))
  println(`  ${c.yellow('--json')}              Output list commands as JSON (for scripting)`)
  println(`  ${c.yellow('--reveal')}            Show decrypted env var values (env list)`)
  println(`  ${c.yellow('DEPLOYHUB_BASE_URL')}  Env var to override the API base URL`)
  println()
  println(c.bold('CONFIG'))
  println(`  ${c.gray('Config file:')} ${CONFIG_FILE}`)
  println(`  ${c.gray('Format:')}      { "apiKey": "dh_...", "baseUrl": "http://..." }`)
  println()
  println(c.bold('GETTING AN API KEY'))
  println(`  1. Log in to your DeployHub dashboard.`)
  println(`  2. Go to ${c.cyan('Settings → API Keys')}.`)
  println(`  3. Click ${c.cyan('"Create API Key"')} and give it a name.`)
  println(`  4. Copy the key (starts with ${c.cyan('dh_')}) — it's shown only once.`)
  println(`  5. Run ${c.cyan('deployhub login <your-key>')}.`)
  println()
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0) {
    cmdHelp()
    process.exit(0)
  }

  // Help flags
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    cmdHelp()
    process.exit(0)
  }

  // Detect multi-word commands (env list/set/delete).
  let command
  let rest
  if (argv[0] === 'env' && argv.length > 1) {
    command = `${argv[0]} ${argv[1]}`
    rest = argv.slice(2)
  } else {
    command = argv[0]
    rest = argv.slice(1)
  }

  const { positional, flags } = parseArgs(rest)

  try {
    switch (command) {
      case 'login':
        await cmdLogin(positional)
        break
      case 'whoami':
        await cmdWhoami(flags)
        break
      case 'projects':
        await cmdProjects(flags)
        break
      case 'deploy':
        await cmdDeploy(positional)
        break
      case 'deployments':
        await cmdDeployments(positional, flags)
        break
      case 'logs':
        await cmdLogs(positional)
        break
      case 'env list':
        await cmdEnvList(positional, flags)
        break
      case 'env set':
        await cmdEnvSet(positional, flags)
        break
      case 'env delete':
        await cmdEnvDelete(positional)
        break
      case 'domains':
        await cmdDomains(flags)
        break
      default:
        println(c.red(`✗ Unknown command: ${command}`))
        println(c.gray('   Run `deployhub help` to see available commands.'))
        process.exit(1)
    }
  } catch (err) {
    if (err instanceof ApiError) {
      if (err.status === 401) {
        println(c.red(`✗ Authentication failed: ${err.message}`))
        println(c.gray('   Run `deployhub login <api-key>` to authenticate.'))
      } else if (err.status === 404) {
        println(c.red(`✗ Not found: ${err.message}`))
      } else {
        println(c.red(`✗ ${err.message}`))
      }
    } else {
      println(c.red(`✗ Unexpected error: ${err.message || err}`))
      if (process.env.DEBUG) console.error(err)
    }
    process.exit(1)
  }
}

main().catch((err) => {
  println(c.red(`✗ Fatal: ${err.message || err}`))
  process.exit(1)
})
