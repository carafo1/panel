import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { listFiles, uploadFile, createDirectory, type FileEntry } from '@/lib/vps'

/**
 * Project Files Endpoint (collection)
 * ===================================
 *
 *   GET   /api/hosting/[id]/files?path=<subdir>   — list files under <subdir>
 *   POST  /api/hosting/[id]/files                 — upload a file OR create a dir
 *            multipart form: file=<binary>, path=<relative-path>
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
    const project = await db.project.findFirst({ where: { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }

    const url = new URL(request.url)
    const subdir = url.searchParams.get('path') || '.'
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
    return NextResponse.json({ files, currentPath, parentPath })
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
    const project = await db.project.findFirst({ where: { id: projectId, userId: decoded.userId } })
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
      if (!file || !(file instanceof File)) {
        return NextResponse.json({ error: 'No "file" field in form data' }, { status: 400 })
      }
      if (!pathField || typeof pathField !== 'string') {
        return NextResponse.json({ error: 'path is required' }, { status: 400 })
      }
      const buf = Buffer.from(await file.arrayBuffer())
      const result = await uploadFile(projectId, `${pathField}/${file.name}`, buf)
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
