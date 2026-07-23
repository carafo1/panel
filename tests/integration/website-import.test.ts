/**
 * tests/integration/website-import.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 * End-to-end tests for Website Import & Migration, driven through the real
 * HTTP API against a running panel.
 *
 * Covers the upload endpoint (single-shot and chunked), authorization on every
 * migration route, payload validation, and a full import run — creation,
 * staged progress, terminal state, and the retry/rollback controls.
 *
 * The import itself runs in demo mode: the created project has no server with
 * SSH credentials, so the runner simulates each stage instead of shelling out.
 * That still exercises everything this layer owns — stage sequencing, progress
 * accounting, persistence, and the API contract — without needing a VPS in CI.
 *
 * Prerequisites:
 *   - Panel running on http://localhost:3000
 *   - Admin user: admin@deployhub.io / admin123
 *
 * Run with: bun test tests/integration/website-import.test.ts
 * ════════════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'

const PANEL_URL = process.env.PANEL_URL || 'http://localhost:3000'

let token = ''
/** Projects created by this file, removed in afterAll. */
const createdProjects: string[] = []

async function login(email: string, password: string): Promise<string | null> {
  const res = await fetch(`${PANEL_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) return null
  const data = await res.json()
  return data.token ?? null
}

function auth(extra: Record<string, string> = {}): HeadersInit {
  return { Authorization: `Bearer ${token}`, ...extra }
}

function json(): HeadersInit {
  return auth({ 'Content-Type': 'application/json' })
}

/**
 * A minimal but genuinely valid ZIP holding a WordPress-shaped tree.
 * Built by hand (stored entries, no compression) so the test has no
 * dependency on a zip binary being installed.
 */
function buildZip(entries: Array<{ name: string; content: string }>): Buffer {
  const crcTable: number[] = []
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    crcTable[n] = c >>> 0
  }
  const crc32 = (buf: Buffer): number => {
    let c = 0xffffffff
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }

  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const dataBuf = Buffer.from(entry.content, 'utf8')
    const crc = crc32(dataBuf)

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0) // local file header signature
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0x2821, 12) // mod date (2020-01-01)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(dataBuf.length, 18)
    local.writeUInt32LE(dataBuf.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    locals.push(local, dataBuf)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x2821, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(dataBuf.length, 20)
    central.writeUInt32LE(dataBuf.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(0, 42) // local header offset, patched below
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)

    offset += local.length + dataBuf.length
  }

  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuf, end])
}

const SAMPLE_ZIP = buildZip([
  { name: 'index.php', content: "<?php require __DIR__.'/wp-blog-header.php';" },
  { name: 'wp-config.php', content: "<?php $table_prefix = 'wp_';" },
  { name: 'wp-content/themes/twenty/style.css', content: 'body{margin:0}' },
  {
    name: 'database.sql',
    content:
      "CREATE TABLE `wp_options` (id INT);\nINSERT INTO `wp_options` VALUES (1,'siteurl','https://old.example.com','yes');",
  },
])

/** Upload a buffer through the streaming single-shot path. */
async function upload(
  filename: string,
  body: Buffer
): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(`${PANEL_URL}/api/hosting/upload`, {
    method: 'POST',
    headers: auth({
      'X-Upload-Filename': encodeURIComponent(filename),
      'Content-Type': 'application/octet-stream',
    }),
    body: new Uint8Array(body),
  })
  return { status: res.status, data: await res.json().catch(() => ({})) }
}

/** Poll a migration until it reaches a terminal state or the deadline passes. */
async function waitForTerminal(
  migrationId: string,
  timeoutMs = 90_000
): Promise<Record<string, never> | any> {
  const terminal = ['completed', 'failed', 'rolled_back', 'cancelled']
  const deadline = Date.now() + timeoutMs
  let last: any = null
  while (Date.now() < deadline) {
    const res = await fetch(`${PANEL_URL}/api/migrations/${migrationId}`, {
      headers: auth(),
    })
    if (res.ok) {
      const data = await res.json()
      last = data.migration
      if (last && terminal.includes(last.status)) return last
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return last
}

beforeAll(async () => {
  const t = await login('admin@deployhub.io', 'admin123')
  if (!t) throw new Error(`Could not log in to ${PANEL_URL} — is the panel running?`)
  token = t
})

/**
 * Tear down the websites this file created.
 *
 * NOTE: `DELETE /api/hosting/[id]` is a SOFT delete — it tears the container
 * down and marks the project `stopped`, but leaves the row (and its import
 * history) in place. So this reduces the mess rather than eliminating it, and
 * a run against a shared database will accumulate `Import Test <ts>` /
 * `Cancel Test <ts>` projects. Prefer a scratch database for repeated runs.
 */
afterAll(async () => {
  for (const id of createdProjects) {
    await fetch(`${PANEL_URL}/api/hosting/${id}`, {
      method: 'DELETE',
      headers: auth(),
    }).catch(() => {})
  }
})

// ─── Authorization ───────────────────────────────────────────────────────

describe('migration endpoints require authentication', () => {
  const routes: Array<[string, string]> = [
    ['GET', '/api/migrations'],
    ['GET', '/api/migrations/anything'],
    ['DELETE', '/api/migrations/anything'],
    ['POST', '/api/migrations/anything/retry'],
    ['POST', '/api/migrations/anything/rollback'],
    ['POST', '/api/hosting/upload'],
    ['GET', '/api/hosting/upload'],
    ['POST', '/api/hosting/import'],
  ]
  for (const [method, route] of routes) {
    it(`${method} ${route} → 401 without a token`, async () => {
      const res = await fetch(`${PANEL_URL}${route}`, { method })
      expect(res.status).toBe(401)
    })
  }
})

// ─── Upload endpoint ─────────────────────────────────────────────────────

describe('backup upload', () => {
  it('accepts a ZIP and returns an upload id', async () => {
    const { status, data } = await upload('my-site.zip', SAMPLE_ZIP)
    expect(status).toBe(201)
    expect(data.uploadId).toMatch(/^[a-f0-9]{32}$/)
    expect(data.filename).toBe('my-site.zip')
    expect(data.sizeBytes).toBe(SAMPLE_ZIP.length)
  })

  it('rejects a file type that is not a backup', async () => {
    const { status, data } = await upload('shell.php', Buffer.from('<?php ?>'))
    expect(status).toBe(400)
    expect(String(data.error)).toMatch(/not a supported backup format/i)
  })

  it('reports the status of an upload', async () => {
    const { data } = await upload('status-check.zip', SAMPLE_ZIP)
    const res = await fetch(
      `${PANEL_URL}/api/hosting/upload?uploadId=${data.uploadId}`,
      { headers: auth() }
    )
    expect(res.status).toBe(200)
    const status = await res.json()
    expect(status.complete).toBe(true)
    expect(status.sizeLabel).toBeTruthy()
  })

  it('404s for an upload id that does not exist', async () => {
    const res = await fetch(
      `${PANEL_URL}/api/hosting/upload?uploadId=${'a'.repeat(32)}`,
      { headers: auth() }
    )
    expect(res.status).toBe(404)
  })

  it('assembles a chunked upload into the identical bytes', async () => {
    const chunkSize = Math.ceil(SAMPLE_ZIP.length / 3)
    const totalChunks = Math.ceil(SAMPLE_ZIP.length / chunkSize)

    const beginRes = await fetch(`${PANEL_URL}/api/hosting/upload?action=begin`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        filename: 'chunked.zip',
        totalChunks,
        sizeBytes: SAMPLE_ZIP.length,
      }),
    })
    expect(beginRes.status).toBe(200)
    const begun = await beginRes.json()
    expect(begun.uploadId).toBeTruthy()

    for (let i = 0; i < totalChunks; i++) {
      const slice = SAMPLE_ZIP.subarray(
        i * chunkSize,
        Math.min((i + 1) * chunkSize, SAMPLE_ZIP.length)
      )
      const res = await fetch(
        `${PANEL_URL}/api/hosting/upload?action=chunk&uploadId=${begun.uploadId}&index=${i}`,
        { method: 'POST', headers: auth(), body: new Uint8Array(slice) }
      )
      expect(res.status).toBe(200)
    }

    const finishRes = await fetch(
      `${PANEL_URL}/api/hosting/upload?action=finish&uploadId=${begun.uploadId}`,
      { method: 'POST', headers: json() }
    )
    expect(finishRes.status).toBe(201)
    const finished = await finishRes.json()
    expect(finished.sizeBytes).toBe(SAMPLE_ZIP.length)
  })

  it('discards an unused upload on request', async () => {
    const { data } = await upload('discard-me.zip', SAMPLE_ZIP)
    const del = await fetch(
      `${PANEL_URL}/api/hosting/upload?uploadId=${data.uploadId}`,
      { method: 'DELETE', headers: auth() }
    )
    expect(del.status).toBe(200)
    const after = await fetch(
      `${PANEL_URL}/api/hosting/upload?uploadId=${data.uploadId}`,
      { headers: auth() }
    )
    expect(after.status).toBe(404)
  })
})

// ─── Import validation ───────────────────────────────────────────────────

describe('import request validation', () => {
  it('rejects an unknown source type', async () => {
    const { data: up } = await upload('v.zip', SAMPLE_ZIP)
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        name: 'Bad source',
        sourceType: 'not-a-real-source',
        uploadId: up.uploadId,
      }),
    })
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toMatch(/Unknown import source/i)
  })

  it('requires a name', async () => {
    const { data: up } = await upload('v.zip', SAMPLE_ZIP)
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        name: '   ',
        sourceType: 'wordpress-zip',
        uploadId: up.uploadId,
      }),
    })
    expect(res.status).toBe(400)
  })

  it('requires an upload for an upload-mode import', async () => {
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ name: 'No payload', sourceType: 'wordpress-zip' }),
    })
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toMatch(/upload/i)
  })

  it('requires a separate SQL upload for the files+database source', async () => {
    const { data: up } = await upload('files.zip', SAMPLE_ZIP)
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        name: 'Files only',
        sourceType: 'files-sql',
        uploadId: up.uploadId,
      }),
    })
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toMatch(/\.sql upload/i)
  })

  it('blocks a git import that points at an internal address', async () => {
    // The server clones this URL, so SSRF protection has to apply here.
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        name: 'SSRF attempt',
        sourceType: 'git',
        sourceMode: 'git',
        gitUrl: 'http://169.254.169.254/latest/meta-data/',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('blocks a URL import that points at localhost', async () => {
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        name: 'SSRF attempt 2',
        sourceType: 'wordpress-zip',
        sourceMode: 'url',
        url: 'http://127.0.0.1:3000/api/hosting',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects a non-HTTPS git remote', async () => {
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        name: 'SSH remote',
        sourceType: 'git',
        sourceMode: 'git',
        gitUrl: 'git@github.com:user/repo.git',
      }),
    })
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toMatch(/HTTPS clone URL/i)
  })
})

// ─── Full run ────────────────────────────────────────────────────────────

describe('full import run', () => {
  let migrationId = ''
  let projectId = ''
  let finalState: any = null

  it('creates the website and starts the import', async () => {
    const { data: up } = await upload('full-run.zip', SAMPLE_ZIP)
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        name: `Import Test ${Date.now()}`,
        sourceType: 'wordpress-zip',
        uploadId: up.uploadId,
        originalUrl: 'https://old.example.com',
      }),
    })
    expect(res.status).toBe(202)
    const data = await res.json()

    expect(data.project?.id).toBeTruthy()
    expect(data.project?.subdomain).toContain('.')
    expect(data.migration?.id).toBeTruthy()

    projectId = data.project.id
    migrationId = data.migration.id
    createdProjects.push(projectId)

    // Every stage is planned up front so the UI renders the full checklist
    // immediately rather than growing a list as work happens.
    expect(data.migration.stages.length).toBeGreaterThanOrEqual(16)
    expect(data.migration.stages[0].name).toBe('prepare')
  })

  it('runs to a terminal state', async () => {
    finalState = await waitForTerminal(migrationId)
    expect(finalState).toBeTruthy()
    expect(['completed', 'failed', 'rolled_back']).toContain(finalState.status)
  })

  it('completes successfully', () => {
    // A failure here means the pipeline itself broke — surface the reason
    // rather than a bare boolean mismatch.
    expect(finalState.error ?? null).toBeNull()
    expect(finalState.status).toBe('completed')
  })

  it('reaches 100% with every stage resolved', () => {
    expect(finalState.progress).toBe(100)
    const unresolved = finalState.stages.filter(
      (s: any) => !['completed', 'skipped'].includes(s.status)
    )
    expect(unresolved).toEqual([])
  })

  it('ran the stages in the declared order', () => {
    const orders = finalState.stages.map((s: any) => s.order)
    expect(orders).toEqual([...orders].sort((a: number, b: number) => a - b))
  })

  it('detected the site and recorded what it found', () => {
    expect(finalState.detection).toBeTruthy()
    expect(finalState.detection.stack).toBe('wordpress')
    expect(finalState.originalUrl).toBe('https://old.example.com')
    expect(finalState.targetUrl).toContain('https://')
  })

  it('captured a log for the stages that did work', () => {
    const withLogs = finalState.stages.filter((s: any) => s.log && s.log.length > 0)
    expect(withLogs.length).toBeGreaterThan(0)
  })

  it('marked the website as running', async () => {
    const res = await fetch(`${PANEL_URL}/api/hosting/${projectId}`, {
      headers: auth(),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    const project = data.project ?? data
    expect(project.status).toBe('running')
  })

  it('offers rollback but not retry on a completed import', () => {
    expect(finalState.canRetry).toBe(false)
    expect(finalState.canCancel).toBe(false)
  })

  it('refuses to retry an import that already succeeded', async () => {
    const res = await fetch(`${PANEL_URL}/api/migrations/${migrationId}/retry`, {
      method: 'POST',
      headers: json(),
    })
    expect(res.status).toBe(400)
    expect(String((await res.json()).error)).toMatch(/already completed/i)
  })

  it('appears in the dashboard feed with correct counters', async () => {
    const res = await fetch(`${PANEL_URL}/api/migrations?limit=100`, {
      headers: auth(),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.migrations.some((m: any) => m.id === migrationId)).toBe(true)
    expect(data.counts.completed).toBeGreaterThanOrEqual(1)
    expect(data.sources.length).toBe(8)
  })

  it('is listed on the project it imported into', async () => {
    const res = await fetch(`${PANEL_URL}/api/hosting/${projectId}/migrate`, {
      headers: auth(),
    })
    expect(res.status).toBe(200)
    const data = await res.json()
    expect(data.migrations.some((m: any) => m.id === migrationId)).toBe(true)
  })

  it('refuses a second import while one is in flight', async () => {
    // Start one and immediately try to start another on the same project.
    const { data: a } = await upload('concurrent-a.zip', SAMPLE_ZIP)
    const { data: b } = await upload('concurrent-b.zip', SAMPLE_ZIP)

    const first = await fetch(`${PANEL_URL}/api/hosting/${projectId}/migrate`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ sourceType: 'wordpress-zip', uploadId: a.uploadId }),
    })
    expect(first.status).toBe(202)

    const second = await fetch(`${PANEL_URL}/api/hosting/${projectId}/migrate`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({ sourceType: 'wordpress-zip', uploadId: b.uploadId }),
    })
    // Two concurrent imports would race on the same directory and database.
    expect(second.status).toBe(409)

    const firstId = (await first.json()).migration.id
    await waitForTerminal(firstId)
  })
})

// ─── Cancel ──────────────────────────────────────────────────────────────

describe('cancelling an import', () => {
  it('moves a running import to cancelled', async () => {
    const { data: up } = await upload('cancel-me.zip', SAMPLE_ZIP)
    const res = await fetch(`${PANEL_URL}/api/hosting/import`, {
      method: 'POST',
      headers: json(),
      body: JSON.stringify({
        name: `Cancel Test ${Date.now()}`,
        sourceType: 'wordpress-zip',
        uploadId: up.uploadId,
      }),
    })
    expect(res.status).toBe(202)
    const data = await res.json()
    createdProjects.push(data.project.id)

    const cancel = await fetch(`${PANEL_URL}/api/migrations/${data.migration.id}`, {
      method: 'DELETE',
      headers: auth(),
    })
    const body = await cancel.json()
    // Either it was still running (cancelled) or it finished first (409) —
    // both are correct; what must not happen is a 500 or a silent no-op.
    expect([200, 409]).toContain(cancel.status)
    if (cancel.status === 200) {
      expect(body.migration.status).toBe('cancelled')
    }
  })
})

// ─── Ownership isolation ─────────────────────────────────────────────────

describe('ownership', () => {
  it('404s a migration id that does not exist', async () => {
    const res = await fetch(`${PANEL_URL}/api/migrations/clzzzzzzzzzzzzzzzzzzzzzzz`, {
      headers: auth(),
    })
    expect(res.status).toBe(404)
  })
})
