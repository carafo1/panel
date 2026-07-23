import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  storeUpload,
  beginChunkedUpload,
  storeChunk,
  finishChunkedUpload,
  getUpload,
  deleteUpload,
  isAllowedExtension,
  sanitizeFilename,
  formatBytes,
  ALLOWED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
} from '@/lib/migration'

/**
 * Backup upload endpoint.
 * ======================
 *
 *   POST /api/hosting/upload                 — single-shot upload (multipart)
 *   POST /api/hosting/upload?action=begin    — start a chunked upload
 *   POST /api/hosting/upload?action=chunk    — send one chunk
 *   POST /api/hosting/upload?action=finish   — assemble the chunks
 *   GET  /api/hosting/upload?uploadId=…      — status of an upload
 *   DELETE /api/hosting/upload?uploadId=…    — discard an upload
 *
 * Two paths exist because the sizes involved differ by three orders of
 * magnitude. A 20 MB theme archive is fine as one request; a 6 GB WordPress
 * backup is not — proxies impose body limits, a dropped connection restarts
 * the whole transfer, and the browser gives no usable progress. The chunked
 * path splits the file so a failure costs one chunk, not the upload.
 *
 * The single-shot path streams the request body straight to disk rather than
 * buffering it: `await request.formData()` on a multi-gigabyte body would read
 * the entire archive into the Node heap and take the panel process down.
 */

export const runtime = 'nodejs'
// Streaming a large body must not be cut short by a route timeout.
export const maxDuration = 3600

// ─── POST ────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }

    const url = new URL(request.url)
    const action = url.searchParams.get('action') || 'upload'

    switch (action) {
      case 'begin':
        return await handleBegin(request, decoded.userId)
      case 'chunk':
        return await handleChunk(request, decoded.userId)
      case 'finish':
        return await handleFinish(request, decoded.userId)
      case 'upload':
        return await handleSingleUpload(request, decoded.userId)
      default:
        return NextResponse.json({ error: `Unknown action "${action}"` }, { status: 400 })
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Upload failed'
    console.error('[hosting/upload]', error)
    // Size-limit and format rejections are the customer's to fix, so they get
    // the real message and a 400 rather than an opaque 500.
    const isClientError =
      /exceeds|not supported|missing|out of range|already complete|Upload not found/i.test(
        message
      )
    return NextResponse.json(
      { error: isClientError ? message : 'Upload failed' },
      { status: isClientError ? 400 : 500 }
    )
  }
}

// ─── Single-shot ─────────────────────────────────────────────────────────

async function handleSingleUpload(request: Request, userId: string) {
  const contentType = request.headers.get('content-type') || ''

  // Browsers post multipart/form-data. Parsing it without buffering needs the
  // filename up front, which the client sends as a header so the body can go
  // straight to disk.
  const headerName = request.headers.get('x-upload-filename')

  if (headerName) {
    const filename = sanitizeFilename(decodeURIComponent(headerName))
    const rejection = rejectBadFile(filename)
    if (rejection) return rejection
    if (!request.body) {
      return NextResponse.json({ error: 'Request has no body' }, { status: 400 })
    }
    const meta = await storeUpload(userId, filename, request.body)
    return uploadResponse(request, userId, meta)
  }

  if (contentType.includes('multipart/form-data')) {
    // Fallback for clients that cannot set the header. Next buffers this, so
    // it is only appropriate for smaller archives — the wizard uses the
    // streaming path above for anything large.
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file field in the request' }, { status: 400 })
    }
    const filename = sanitizeFilename(file.name)
    const rejection = rejectBadFile(filename)
    if (rejection) return rejection
    if (file.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File is too large. The maximum is ${formatBytes(MAX_UPLOAD_BYTES)}.` },
        { status: 413 }
      )
    }
    const buf = Buffer.from(await file.arrayBuffer())
    const meta = await storeUpload(userId, filename, buf)
    return uploadResponse(request, userId, meta)
  }

  return NextResponse.json(
    {
      error:
        'Send the file as multipart/form-data, or stream it with an X-Upload-Filename header.',
    },
    { status: 400 }
  )
}

// ─── Chunked ─────────────────────────────────────────────────────────────

async function handleBegin(request: Request, userId: string) {
  const body = await request.json().catch(() => null)
  if (!body || typeof body.filename !== 'string') {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 })
  }
  const filename = sanitizeFilename(body.filename)
  const rejection = rejectBadFile(filename)
  if (rejection) return rejection

  const totalChunks = Number(body.totalChunks)
  const size = Number(body.sizeBytes)
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > 20000) {
    return NextResponse.json(
      { error: 'totalChunks must be between 1 and 20000' },
      { status: 400 }
    )
  }
  if (!Number.isFinite(size) || size <= 0) {
    return NextResponse.json({ error: 'sizeBytes is required' }, { status: 400 })
  }
  if (size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: `File is too large. The maximum is ${formatBytes(MAX_UPLOAD_BYTES)}.` },
      { status: 413 }
    )
  }

  const meta = await beginChunkedUpload(userId, filename, totalChunks, size)
  return NextResponse.json({
    uploadId: meta.uploadId,
    filename: meta.filename,
    totalChunks,
    receivedChunks: 0,
  })
}

async function handleChunk(request: Request, userId: string) {
  const url = new URL(request.url)
  const uploadId = url.searchParams.get('uploadId') || ''
  const index = Number(url.searchParams.get('index'))
  if (!uploadId || !Number.isInteger(index)) {
    return NextResponse.json(
      { error: 'uploadId and index are required' },
      { status: 400 }
    )
  }
  const buf = Buffer.from(await request.arrayBuffer())
  if (buf.length === 0) {
    return NextResponse.json({ error: 'Chunk is empty' }, { status: 400 })
  }
  const meta = await storeChunk(uploadId, userId, index, buf)
  return NextResponse.json({
    uploadId,
    receivedChunks: meta.receivedChunks,
    totalChunks: meta.totalChunks,
  })
}

async function handleFinish(request: Request, userId: string) {
  const url = new URL(request.url)
  const uploadId = url.searchParams.get('uploadId') || ''
  if (!uploadId) {
    return NextResponse.json({ error: 'uploadId is required' }, { status: 400 })
  }
  const meta = await finishChunkedUpload(uploadId, userId)
  return uploadResponse(request, userId, meta)
}

// ─── GET / DELETE ────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const decoded = await authenticateRequest(request)
  if (!decoded) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }
  const uploadId = new URL(request.url).searchParams.get('uploadId') || ''
  const meta = await getUpload(uploadId, decoded.userId)
  if (!meta) {
    return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
  }
  return NextResponse.json({
    uploadId: meta.uploadId,
    filename: meta.filename,
    sizeBytes: meta.sizeBytes,
    sizeLabel: formatBytes(meta.sizeBytes),
    complete: meta.complete,
    receivedChunks: meta.receivedChunks,
    totalChunks: meta.totalChunks,
    createdAt: meta.createdAt,
  })
}

export async function DELETE(request: Request) {
  const decoded = await authenticateRequest(request)
  if (!decoded) {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }
  const uploadId = new URL(request.url).searchParams.get('uploadId') || ''
  // Ownership is checked before deletion so one customer cannot discard
  // another's staged backup by guessing an id.
  const meta = await getUpload(uploadId, decoded.userId)
  if (!meta) {
    return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
  }
  if (meta.consumedByMigrationId) {
    return NextResponse.json(
      { error: 'This upload is in use by a running import.' },
      { status: 409 }
    )
  }
  await deleteUpload(uploadId)
  return NextResponse.json({ ok: true })
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function rejectBadFile(filename: string): NextResponse | null {
  if (!isAllowedExtension(filename)) {
    return NextResponse.json(
      {
        error: `"${filename}" is not a supported backup format. Accepted: ${ALLOWED_EXTENSIONS.join(', ')}`,
      },
      { status: 400 }
    )
  }
  return null
}

async function uploadResponse(
  request: Request,
  userId: string,
  meta: { uploadId: string; filename: string; sizeBytes: number }
) {
  await logAudit({
    userId,
    action: 'migration.upload',
    resource: 'upload',
    resourceId: meta.uploadId,
    req: request,
    metadata: { filename: meta.filename, sizeBytes: meta.sizeBytes },
  })
  return NextResponse.json(
    {
      uploadId: meta.uploadId,
      filename: meta.filename,
      sizeBytes: meta.sizeBytes,
      sizeLabel: formatBytes(meta.sizeBytes),
    },
    { status: 201 }
  )
}
