/**
 * Panel-side upload store for migration payloads.
 * ==============================================
 *
 * Backup archives are big — a modest WordPress site with a media library is
 * several gigabytes — so uploads land on the panel host first and are streamed
 * to the target VPS by the migration runner. This module owns that staging
 * area: where files live, how they are named, and how partial (chunked)
 * uploads are assembled.
 *
 * The path layout is deliberately compatible with the existing deployer, which
 * reads plain ZIP uploads from `/tmp/apsamo-uploads/<uploadId>.zip`. Anything
 * that is not a ZIP keeps its real extension, because the extractor dispatches
 * on it.
 *
 * Uploads are anonymous blobs owned by a user, not by a project — the customer
 * uploads first and picks a destination afterwards. Every read therefore
 * re-checks ownership against the sidecar metadata.
 */
import crypto from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, readFile, writeFile, stat, unlink, readdir } from 'fs/promises'
import path from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'

// ─── Storage layout ───────────────────────────────────────────────────────

export const UPLOAD_ROOT =
  process.env.MIGRATION_UPLOAD_ROOT || '/tmp/apsamo-uploads'

/** Hard ceiling on a single upload. Overridable for customers on big plans. */
export const MAX_UPLOAD_BYTES = Number(
  process.env.MIGRATION_MAX_UPLOAD_BYTES || 10 * 1024 * 1024 * 1024
) // 10 GB

/**
 * Extensions we accept. Anything else is rejected at the door rather than
 * discovered halfway through an import — an unknown archive cannot be
 * extracted, so accepting it only wastes the customer's bandwidth.
 */
export const ALLOWED_EXTENSIONS = [
  '.zip',
  // Duplicator's archive extension. It is a ZIP underneath, but Duplicator
  // hands customers a `.daf` and the import wizard advertises it, so the
  // upload endpoint has to accept it or the source is unusable.
  '.daf',
  '.wpress',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.tar.bz2',
  '.tbz2',
  '.tar.xz',
  '.txz',
  '.gz',
  '.bz2',
  '.xz',
  '.sql',
  '.sql.gz',
  '.sql.bz2',
] as const

export interface UploadMetadata {
  uploadId: string
  userId: string
  filename: string
  /** Normalized extension including the leading dot, e.g. '.tar.gz'. */
  extension: string
  sizeBytes: number
  /** Absolute path of the assembled payload on the panel host. */
  storedPath: string
  createdAt: string
  /** Set once a migration consumes it, so cleanup knows it is still needed. */
  consumedByMigrationId?: string
  /** Chunked uploads only — how many chunks are expected and received. */
  totalChunks?: number
  receivedChunks?: number
  complete: boolean
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract the meaningful extension from a filename, treating the compound
 * archive suffixes (.tar.gz, .sql.gz, …) as single units — `path.extname`
 * would return '.gz' for `backup.sql.gz` and we would try to gunzip it into
 * nothing useful.
 */
export function normalizeExtension(filename: string): string {
  const lower = filename.toLowerCase()
  const compound = ['.tar.gz', '.tar.bz2', '.tar.xz', '.sql.gz', '.sql.bz2']
  for (const ext of compound) {
    if (lower.endsWith(ext)) return ext
  }
  const idx = lower.lastIndexOf('.')
  return idx === -1 ? '' : lower.slice(idx)
}

export function isAllowedExtension(filename: string): boolean {
  const ext = normalizeExtension(filename)
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * Strip directory components and anything that could escape the staging dir.
 * The filename is only ever used for display and for choosing an extension,
 * but it arrives from the browser, so it gets sanitized regardless.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.replace(/\\/g, '/').split('/').pop() || 'upload'
  return base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200) || 'upload'
}

function newUploadId(): string {
  return crypto.randomBytes(16).toString('hex')
}

function metaPath(uploadId: string): string {
  return path.join(UPLOAD_ROOT, `${uploadId}.meta.json`)
}

function chunkDir(uploadId: string): string {
  return path.join(UPLOAD_ROOT, `${uploadId}.parts`)
}

/**
 * ZIPs keep the historical `<id>.zip` name the deployer already reads;
 * everything else keeps its own extension so the extractor can dispatch.
 */
function payloadPath(uploadId: string, extension: string): string {
  return path.join(UPLOAD_ROOT, `${uploadId}${extension || '.bin'}`)
}

async function ensureRoot(): Promise<void> {
  await mkdir(UPLOAD_ROOT, { recursive: true })
}

// ─── Single-shot upload ───────────────────────────────────────────────────

/**
 * Stream a whole upload to disk. `body` is the request's ReadableStream, so
 * nothing larger than a chunk is ever held in memory — a 4 GB backup would
 * otherwise blow the Node heap long before it reached the VPS.
 */
export async function storeUpload(
  userId: string,
  filename: string,
  body: ReadableStream<Uint8Array> | Buffer,
  opts: { maxBytes?: number } = {}
): Promise<UploadMetadata> {
  await ensureRoot()
  const safeName = sanitizeFilename(filename)
  const extension = normalizeExtension(safeName)
  const uploadId = newUploadId()
  const stored = payloadPath(uploadId, extension)
  const limit = opts.maxBytes ?? MAX_UPLOAD_BYTES

  let written = 0
  if (Buffer.isBuffer(body)) {
    if (body.length > limit) {
      throw new Error(`Upload exceeds the ${formatBytes(limit)} limit`)
    }
    await writeFile(stored, body)
    written = body.length
  } else {
    const out = createWriteStream(stored)
    // Count bytes as they pass so an oversized upload is aborted mid-flight
    // instead of after we've already committed it to disk.
    const counter = new TransformCounter(limit)
    try {
      await pipeline(Readable.fromWeb(body as never), counter.stream, out)
    } catch (err) {
      await unlink(stored).catch(() => {})
      throw err
    }
    written = counter.bytes
  }

  const meta: UploadMetadata = {
    uploadId,
    userId,
    filename: safeName,
    extension,
    sizeBytes: written,
    storedPath: stored,
    createdAt: new Date().toISOString(),
    complete: true,
  }
  await writeFile(metaPath(uploadId), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

/**
 * A pass-through that counts bytes and aborts once the limit is exceeded.
 * Implemented over the Node stream API so it composes with `pipeline`.
 */
class TransformCounter {
  bytes = 0
  stream: Transform

  constructor(limit: number) {
    this.stream = new Transform({
      transform: (chunk: Buffer, _enc: string, cb: (e?: Error | null, d?: Buffer) => void) => {
        this.bytes += chunk.length
        if (this.bytes > limit) {
          cb(new Error(`Upload exceeds the ${formatBytes(limit)} limit`))
          return
        }
        cb(null, chunk)
      },
    })
  }
}

// ─── Chunked upload ───────────────────────────────────────────────────────

/**
 * Begin a chunked upload. Browsers and proxies both dislike multi-gigabyte
 * single requests, so the wizard slices large files and posts them in order;
 * this reserves the id and records how many parts to expect.
 */
export async function beginChunkedUpload(
  userId: string,
  filename: string,
  totalChunks: number,
  declaredSize: number
): Promise<UploadMetadata> {
  await ensureRoot()
  if (declaredSize > MAX_UPLOAD_BYTES) {
    throw new Error(`Upload exceeds the ${formatBytes(MAX_UPLOAD_BYTES)} limit`)
  }
  const safeName = sanitizeFilename(filename)
  const extension = normalizeExtension(safeName)
  const uploadId = newUploadId()
  await mkdir(chunkDir(uploadId), { recursive: true })
  const meta: UploadMetadata = {
    uploadId,
    userId,
    filename: safeName,
    extension,
    sizeBytes: declaredSize,
    storedPath: payloadPath(uploadId, extension),
    createdAt: new Date().toISOString(),
    totalChunks,
    receivedChunks: 0,
    complete: false,
  }
  await writeFile(metaPath(uploadId), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

/** Persist one chunk. Chunks may arrive out of order; assembly sorts them. */
export async function storeChunk(
  uploadId: string,
  userId: string,
  index: number,
  data: Buffer
): Promise<UploadMetadata> {
  const meta = await getUpload(uploadId, userId)
  if (!meta) throw new Error('Upload not found')
  if (meta.complete) throw new Error('Upload is already complete')
  if (!Number.isInteger(index) || index < 0 || index >= (meta.totalChunks ?? 0)) {
    throw new Error(`Chunk index ${index} is out of range`)
  }
  await writeFile(path.join(chunkDir(uploadId), `${index}.part`), data)
  const parts = await readdir(chunkDir(uploadId)).catch(() => [])
  meta.receivedChunks = parts.filter((p) => p.endsWith('.part')).length
  await writeFile(metaPath(uploadId), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

/**
 * Concatenate the chunks into the final payload and drop the parts directory.
 * Fails loudly when a chunk is missing rather than producing a truncated
 * archive that would only explode during extraction.
 */
export async function finishChunkedUpload(
  uploadId: string,
  userId: string
): Promise<UploadMetadata> {
  const meta = await getUpload(uploadId, userId)
  if (!meta) throw new Error('Upload not found')
  if (meta.complete) return meta
  const total = meta.totalChunks ?? 0
  const dir = chunkDir(uploadId)

  for (let i = 0; i < total; i++) {
    const p = path.join(dir, `${i}.part`)
    try {
      await stat(p)
    } catch {
      throw new Error(`Chunk ${i} of ${total} is missing — re-upload it`)
    }
  }

  const out = createWriteStream(meta.storedPath)
  let written = 0
  try {
    for (let i = 0; i < total; i++) {
      const p = path.join(dir, `${i}.part`)
      const buf = await readFile(p)
      written += buf.length
      await new Promise<void>((resolve, reject) => {
        out.write(buf, (err) => (err ? reject(err) : resolve()))
      })
    }
  } finally {
    await new Promise<void>((resolve) => out.end(() => resolve()))
  }

  // Best-effort cleanup of the parts; a leftover directory costs disk, not
  // correctness, and the sweeper will get it.
  for (let i = 0; i < total; i++) {
    await unlink(path.join(dir, `${i}.part`)).catch(() => {})
  }

  meta.sizeBytes = written
  meta.complete = true
  meta.receivedChunks = total
  await writeFile(metaPath(uploadId), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

// ─── Read / delete ────────────────────────────────────────────────────────

/**
 * Load upload metadata, enforcing ownership. Returns null when the upload does
 * not exist OR belongs to somebody else — callers must not be able to
 * distinguish the two, or the id space becomes an enumeration oracle.
 */
export async function getUpload(
  uploadId: string,
  userId: string,
  opts: { allowAnyOwner?: boolean } = {}
): Promise<UploadMetadata | null> {
  // The id goes into a filesystem path, so anything but hex is rejected before
  // it can reach `path.join`.
  if (!/^[a-f0-9]{32}$/.test(uploadId)) return null
  try {
    const raw = await readFile(metaPath(uploadId), 'utf8')
    const meta = JSON.parse(raw) as UploadMetadata
    if (!opts.allowAnyOwner && meta.userId !== userId) return null
    return meta
  } catch {
    return null
  }
}

/** Mark an upload as consumed so the sweeper leaves it alone while in use. */
export async function markConsumed(
  uploadId: string,
  migrationId: string
): Promise<void> {
  const meta = await getUpload(uploadId, '', { allowAnyOwner: true })
  if (!meta) return
  meta.consumedByMigrationId = migrationId
  await writeFile(metaPath(uploadId), JSON.stringify(meta, null, 2), 'utf8').catch(
    () => {}
  )
}

/** Delete an upload's payload, chunks, and metadata. Safe to call twice. */
export async function deleteUpload(uploadId: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(uploadId)) return
  const meta = await getUpload(uploadId, '', { allowAnyOwner: true })
  if (meta) await unlink(meta.storedPath).catch(() => {})
  await unlink(metaPath(uploadId)).catch(() => {})
  const dir = chunkDir(uploadId)
  const parts = await readdir(dir).catch(() => [] as string[])
  for (const p of parts) await unlink(path.join(dir, p)).catch(() => {})
}

/**
 * Remove staged uploads older than `maxAgeHours` that no migration claimed.
 * Called from the cron sweeper — the staging area is on the panel's disk and
 * abandoned multi-gigabyte archives fill it fast.
 */
export async function sweepStaleUploads(maxAgeHours = 48): Promise<number> {
  await ensureRoot()
  const cutoff = Date.now() - maxAgeHours * 3600_000
  const entries = await readdir(UPLOAD_ROOT).catch(() => [] as string[])
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.meta.json')) continue
    const uploadId = entry.replace(/\.meta\.json$/, '')
    const meta = await getUpload(uploadId, '', { allowAnyOwner: true })
    if (!meta) continue
    if (meta.consumedByMigrationId) continue
    if (new Date(meta.createdAt).getTime() > cutoff) continue
    await deleteUpload(uploadId)
    removed++
  }
  return removed
}

// ─── Formatting ───────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
