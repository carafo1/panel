import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import {
  listFiles,
  uploadFile,
  createDirectory,
  exportArchive,
  importArchive,
  type FileEntry,
} from '@/lib/vps'

// Cap import archive size to avoid buffering an unbounded upload into memory.
const MAX_IMPORT_BYTES = 512 * 1024 * 1024 // 512 MB

/**
 * Project Files Endpoint (collection)
 * ===================================
 *
 *   GET   /api/hosting/[id]/files?path=<subdir>   — list files under <subdir>
 *   GET   /api/hosting/[id]/files?action=export&path=<subdir>
 *            — download <subdir> (or the whole project) as a .zip / .tar.gz
 *   POST  /api/hosting/[id]/files                 — upload a file OR create a dir
 *            multipart form: file=<binary>, path=<relative-path>
 *            multipart form: file=<archive>, path=<subdir>, action=import
 *              — extract an uploaded .zip / .tar.gz into <subdir>
 *            OR JSON: { path, content }   — inline text upload
 *            OR JSON: { action: 'mkdir', path }
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const subdir = url.searchParams.get('path') || '.'

    // Export: bundle the current folder (or whole project) into a downloadable
    // archive (zip, or tar.gz fallback).
    if (url.searchParams.get('action') === 'export') {
      try {
        const { content, filename } = await exportArchive(projectId, subdir)
        const type = filename.endsWith('.zip') ? 'application/zip' : 'application/gzip'
        return new NextResponse(content, {
          status: 200,
          headers: {
            'Content-Type': type,
            'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '_')}"`,
            'Content-Length': String(content.length),
            'Cache-Control': 'no-store',
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Export failed'
        return NextResponse.json({ error: msg }, { status: 400 })
      }
    }

    let files: FileEntry[]
    try {
      files = await listFiles(projectId, subdir)
    } catch (err) {
      const msg = 'Invalid request'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
    const currentPath = subdir === '.' ? '' : subdir
    const parentPath =
      currentPath === '' || currentPath === '.'
        ? null
        : currentPath.includes('/')
          ? currentPath.replace(/\/[^/]+$/, '') || '.'
          : '.'
    // Normalize the directory type to what the UI expects ('directory'), and
    // never let the browser cache a listing (it would show a stale/empty view
    // after files change).
    const normalized = files.map((f) => ({
      ...f,
      type: f.type === 'dir' ? 'directory' : f.type,
    }))
    return NextResponse.json(
      { files: normalized, currentPath, parentPath },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    )
  } catch (error) {
    console.error('List files error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const contentType = (request.headers.get('content-type') || '').toLowerCase()
    if (contentType.startsWith('multipart/form-data')) {
      // File upload.
      const formData = await request.formData().catch(() => null)
      if (!formData) {
        return NextResponse.json({ error: 'Could not parse multipart form' }, { status: 400 })
      }
      const file = formData.get('file')
      const pathField = formData.get('path')
      const action = formData.get('action')
      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: 'No "file" field in form data' }, { status: 400 })
      }
      if (typeof pathField !== 'string') {
        return NextResponse.json({ error: 'path is required' }, { status: 400 })
      }
      if (file.size > MAX_IMPORT_BYTES) {
        return NextResponse.json(
          { error: `File too large (max ${Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB)` },
          { status: 413 }
        )
      }
      const buf = Buffer.from(await file.arrayBuffer())

      // Import: extract an uploaded archive into the target folder.
      if (action === 'import') {
        try {
          const result = await importArchive(projectId, pathField || '.', buf, file.name)
          return NextResponse.json(result, { status: 201 })
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Import failed'
          return NextResponse.json({ error: msg }, { status: 400 })
        }
      }

      const uploadPath = pathField ? `${pathField}/${file.name}` : file.name
      const result = await uploadFile(projectId, uploadPath, buf)
      return NextResponse.json(result, { status: 201 })
    }

    // JSON body — either inline text content or mkdir.
    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    if (body.action === 'mkdir' && typeof body.path === 'string') {
      const result = await createDirectory(projectId, body.path)
      return NextResponse.json(result, { status: 201 })
    }
    if (typeof body.path === 'string' && typeof body.content === 'string') {
      const result = await uploadFile(projectId, body.path, body.content)
      return NextResponse.json(result, { status: 201 })
    }
    return NextResponse.json(
      { error: 'Expected { path, content } or { action: "mkdir", path }' },
      { status: 400 }
    )
  } catch (error) {
    const msg = 'Internal server error'
    console.error('Upload file error:', error)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
