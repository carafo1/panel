import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { isAdmin } from '@/lib/security'
import {
  downloadFile,
  getFileContent,
  saveFileContent,
  deleteFile,
  renameFile,
} from '@/lib/vps'

/**
 * Project File Endpoint (single, catch-all path)
 * ==============================================
 *
 *   GET    /api/hosting/[id]/files/<path>?action=download    — stream the file
 *   GET    /api/hosting/[id]/files/<path>?action=content     — text content (for editor)
 *   PUT    /api/hosting/[id]/files/<path>                    — save text content (body: { content })
 *   DELETE /api/hosting/[id]/files/<path>                    — delete the file/dir
 *   POST   /api/hosting/[id]/files/<path>                    — action
 *              body: { action: 'rename', newPath }
 *              body: { action: 'mkdir', newPath }
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, path: pathSegments } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const filePath = pathSegments.join('/')
    const url = new URL(request.url)
    const action = url.searchParams.get('action') || 'download'

    if (action === 'content') {
      try {
        const result = await getFileContent(projectId, filePath)
        return NextResponse.json(result)
      } catch (err) {
        const msg = 'Invalid request'
        return NextResponse.json({ error: msg }, { status: 400 })
      }
    }

    // Default: download.
    try {
      const { content, filename, size } = await downloadFile(projectId, filePath)
      return new NextResponse(new Uint8Array(content), {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename.replace(/"/g, '_')}"`,
          'Content-Length': size.toString(),
        },
      })
    } catch (err) {
      const msg = 'Invalid request'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
  } catch (error) {
    console.error('Get file error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, path: pathSegments } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const filePath = pathSegments.join('/')
    const body = await request.json().catch(() => null)
    if (!body || typeof body.content !== 'string') {
      return NextResponse.json({ error: 'Expected { content }' }, { status: 400 })
    }
    try {
      const result = await saveFileContent(projectId, filePath, body.content)
      return NextResponse.json(result)
    } catch (err) {
      const msg = 'Invalid request'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
  } catch (error) {
    console.error('Save file error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, path: pathSegments } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const filePath = pathSegments.join('/')
    try {
      const result = await deleteFile(projectId, filePath)
      return NextResponse.json(result)
    } catch (err) {
      const msg = 'Invalid request'
      return NextResponse.json({ error: msg }, { status: 400 })
    }
  } catch (error) {
    console.error('Delete file error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; path: string[] }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
    }
    const { id: projectId, path: pathSegments } = await params
    const project = await db.project.findFirst({ where: isAdmin(decoded.role) ? { id: projectId } : { id: projectId, userId: decoded.userId } })
    if (!project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 })
    }
    const filePath = pathSegments.join('/')
    const body = await request.json().catch(() => ({}))
    if (body.action === 'rename' && typeof body.newPath === 'string') {
      try {
        const result = await renameFile(projectId, filePath, body.newPath)
        return NextResponse.json(result)
      } catch (err) {
        const msg = 'Invalid request'
        return NextResponse.json({ error: msg }, { status: 400 })
      }
    }
    if (body.action === 'mkdir' && typeof body.newPath === 'string') {
      const { createDirectory } = await import('@/lib/vps')
      try {
        const result = await createDirectory(projectId, body.newPath)
        return NextResponse.json(result, { status: 201 })
      } catch (err) {
        const msg = 'Invalid request'
        return NextResponse.json({ error: msg }, { status: 400 })
      }
    }
    return NextResponse.json(
      { error: 'Expected { action: "rename"|"mkdir", newPath }' },
      { status: 400 }
    )
  } catch (error) {
    console.error('File action error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
