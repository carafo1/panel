/**
 * tests/unit/wpress-extractor.test.ts
 *
 * The .wpress container is All-in-One WP Migration's own format — no standard
 * archiver reads it, so we ship a Python unpacker. That makes it the one piece
 * of the import pipeline where a byte-layout mistake is invisible until a
 * customer's backup silently unpacks to garbage.
 *
 * This test builds a real .wpress archive from known bytes, runs the exact
 * script the migration ships to the server, and checks the tree that comes
 * back out — including the archive-slip guard.
 *
 * Skipped when Python 3 is unavailable, since the script is the artifact under
 * test and reimplementing it here would test nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile, readdir } from 'fs/promises'
import { spawnSync } from 'child_process'
import { tmpdir } from 'os'
import path from 'path'

// ─── Locate a Python 3 ───────────────────────────────────────────────────

function findPython(): string | null {
  for (const cmd of ['python3', 'python', 'py']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
    })
    if (r.status === 0 && r.stdout.trim() === '3') return cmd
  }
  return null
}

const PYTHON = findPython()

// ─── Build a .wpress archive ─────────────────────────────────────────────

const HEADER = 4377
const NAME = 255
const SIZE = 14
const MTIME = 12

/**
 * One record: a 4377-byte header of null-padded fields, then the raw content.
 *   0..254    filename
 * 255..268    size, ASCII decimal
 * 269..280    mtime, ASCII decimal
 * 281..4376   directory prefix
 */
function record(prefix: string, name: string, content: Buffer): Buffer {
  const header = Buffer.alloc(HEADER, 0)
  header.write(name, 0, 'utf8')
  header.write(String(content.length), NAME, 'utf8')
  header.write('1700000000', NAME + SIZE, 'utf8')
  header.write(prefix, NAME + SIZE + MTIME, 'utf8')
  return Buffer.concat([header, content])
}

/** The archive terminator: a header-sized run of nulls. */
function eofBlock(): Buffer {
  return Buffer.alloc(HEADER, 0)
}

// ─── Extract the shipped script out of the source ────────────────────────

/**
 * Pull WPRESS_EXTRACTOR out of extract.ts rather than keeping a copy here.
 * A duplicated script would drift, and the test would then pass against code
 * we do not actually deploy.
 */
async function loadShippedScript(): Promise<string> {
  const source = await readFile(
    path.join(process.cwd(), 'src', 'lib', 'migration', 'extract.ts'),
    'utf8'
  )
  const start = source.indexOf('const WPRESS_EXTRACTOR = `')
  if (start === -1) throw new Error('WPRESS_EXTRACTOR not found in extract.ts')
  const bodyStart = source.indexOf('`', start) + 1
  const bodyEnd = source.indexOf('\n`', bodyStart)
  if (bodyEnd === -1) throw new Error('Could not find the end of WPRESS_EXTRACTOR')
  // Undo the TypeScript template-literal escaping so the Python is verbatim.
  return source
    .slice(bodyStart, bodyEnd)
    .replace(/\\\\/g, '\\')
    .replace(/\\`/g, '`')
    .replace(/\\\$/g, '$')
}

// ─── Fixtures ────────────────────────────────────────────────────────────

let workDir = ''
let scriptPath = ''
let archivePath = ''

const FILES: Array<{ prefix: string; name: string; body: string }> = [
  { prefix: '.', name: 'index.php', body: '<?php // wp root\n' },
  { prefix: '.', name: 'wp-config.php', body: "<?php define('DB_NAME','x');\n" },
  { prefix: 'wp-content/themes/mytheme', name: 'style.css', body: 'body{color:red}\n' },
  {
    prefix: 'wp-content/plugins/hello',
    name: 'hello.php',
    body: '<?php /* Plugin Name: Hello */\n',
  },
  // A binary-ish payload, to prove content is copied byte-for-byte rather than
  // decoded as text somewhere along the way.
  {
    prefix: 'wp-content/uploads/2024',
    name: 'photo.jpg',
    body: '\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01',
  },
  { prefix: '.', name: 'database.sql', body: 'CREATE TABLE wp_options (id INT);\n' },
]

beforeAll(async () => {
  if (!PYTHON) return
  workDir = await mkdtemp(path.join(tmpdir(), 'wpress-test-'))
  scriptPath = path.join(workDir, 'wpress.py')
  archivePath = path.join(workDir, 'export.wpress')

  await writeFile(scriptPath, await loadShippedScript(), 'utf8')

  const parts: Buffer[] = []
  for (const f of FILES) {
    parts.push(record(f.prefix, f.name, Buffer.from(f.body, 'binary')))
  }
  // A record whose prefix tries to climb out of the extraction root.
  parts.push(
    record('../../../../etc', 'evil.conf', Buffer.from('pwned\n', 'utf8'))
  )
  parts.push(eofBlock())
  // Trailing junk after the EOF block: real archives sometimes carry padding,
  // and the unpacker must stop rather than treat it as another record.
  parts.push(Buffer.from('TRAILING GARBAGE'))

  await writeFile(archivePath, Buffer.concat(parts))
})

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true })
})

// ─── Tests ───────────────────────────────────────────────────────────────

describe.skipIf(!PYTHON)('.wpress extractor', () => {
  let dest = ''
  let stdout = ''

  beforeAll(() => {
    dest = path.join(workDir, 'extracted')
    const r = spawnSync(PYTHON!, [scriptPath, archivePath, dest], {
      encoding: 'utf8',
    })
    stdout = `${r.stdout}${r.stderr}`
    expect(r.status).toBe(0)
  })

  it('reports how many files it wrote', () => {
    expect(stdout).toContain(`extracted=${FILES.length}`)
  })

  it('recreates every file at its original path', async () => {
    for (const f of FILES) {
      const rel = f.prefix === '.' ? f.name : path.join(f.prefix, f.name)
      const written = await readFile(path.join(dest, rel), 'binary')
      expect(written).toBe(f.body)
    }
  })

  it('preserves binary content byte-for-byte', async () => {
    const jpeg = await readFile(
      path.join(dest, 'wp-content', 'uploads', '2024', 'photo.jpg')
    )
    expect(jpeg[0]).toBe(0xff)
    expect(jpeg[1]).toBe(0xd8)
    expect(jpeg.subarray(6, 10).toString('ascii')).toBe('JFIF')
  })

  it('creates the nested directory structure', async () => {
    const themes = await readdir(path.join(dest, 'wp-content', 'themes'))
    expect(themes).toContain('mytheme')
    const plugins = await readdir(path.join(dest, 'wp-content', 'plugins'))
    expect(plugins).toContain('hello')
  })

  it('refuses to write outside the extraction root', async () => {
    // The archive contains a record prefixed '../../../../etc'. If the guard
    // is wrong, this test writes to the filesystem root — hence checking both
    // that it was counted as skipped and that no such file exists anywhere
    // under the workspace.
    expect(stdout).toContain('skipped=1')
    const escaped = path.resolve(workDir, '..', '..', '..', '..', 'etc', 'evil.conf')
    let exists = true
    try {
      await readFile(escaped)
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it('stops at the EOF block instead of parsing trailing bytes', async () => {
    // 'TRAILING GARBAGE' follows the terminator. Reading past the EOF block
    // would either add a junk file or crash.
    const entries = await readdir(dest)
    expect(entries.sort()).toEqual(
      ['database.sql', 'index.php', 'wp-config.php', 'wp-content'].sort()
    )
  })

  it('is idempotent — re-extracting over itself succeeds', () => {
    const again = spawnSync(PYTHON!, [scriptPath, archivePath, dest], {
      encoding: 'utf8',
    })
    expect(again.status).toBe(0)
    expect(`${again.stdout}`).toContain(`extracted=${FILES.length}`)
  })

  it('handles an empty archive without error', async () => {
    const emptyArchive = path.join(workDir, 'empty.wpress')
    const emptyDest = path.join(workDir, 'empty-out')
    await writeFile(emptyArchive, eofBlock())
    const r = spawnSync(PYTHON!, [scriptPath, emptyArchive, emptyDest], {
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('extracted=0')
    expect(await readdir(emptyDest)).toEqual([])
  })
})

describe.skipIf(!!PYTHON)('.wpress extractor (skipped)', () => {
  it('needs python3 on PATH to run', () => {
    expect(PYTHON).toBeNull()
  })
})
