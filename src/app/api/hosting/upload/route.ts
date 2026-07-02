import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { writeFile, mkdir } from 'fs/promises'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

/**
 * ZIP Upload Endpoint
 * ===================
 *
 * Accepts a multipart form upload containing a single `.zip` file and stores
 * it at `/tmp/apsamo-uploads/<cuid>.zip`. Returns `{ uploadId, filename,
 * sizeBytes }` which the Create-Website-Wizard passes back to
 * `/api/hosting/create` (with `source='zip'`) so the deployer can SFTP-upload
 * + unzip it on the VPS.
 *
 * Constraints:
 *   - Auth required.
 *   - Only one file per request (field name: `file`).
 *   - Max size 500 MB (enforced by chunked read + byte counter).
 *   - Must be a `.zip` (checked by extension + content-type).
 */

const MAX_BYTES = 500 * 1024 * 1024 // 500 MB
const UPLOAD_DIR = '/tmp/apsamo-uploads'

export async function POST(request: Request) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    // Ensure the upload directory exists.
    await mkdir(UPLOAD_DIR, { recursive: true })

    const contentType = request.headers.get('content-type') || ''
    if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
      return NextResponse.json(
        { error: 'Expected multipart/form-data request' },
        { status: 400 }
      )
    }

    const formData = await request.formData().catch(() => null)
    if (!formData) {
      return NextResponse.json(
        { error: 'Could not parse multipart form data' },
        { status: 400 }
      )
    }
    const file = formData.get('file')
    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'No "file" field in form data' },
        { status: 400 }
      )
    }

    // Validate extension + content-type.
    const lowerName = file.name.toLowerCase()
    if (!lowerName.endsWith('.zip')) {
      return NextResponse.json(
        { error: 'File must be a .zip archive' },
        { status: 400 }
      )
    }
    const fileCt = (file.type || '').toLowerCase()
    if (fileCt && !['application/zip', 'application/x-zip-compressed', 'application/octet-stream', ''].includes(fileCt)) {
      return NextResponse.json(
        { error: `Unexpected content-type: ${fileCt}` },
        { status: 400 }
      )
    }

    // Enforce size limit (File.size is the full size).
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: `File too large (${file.size} bytes; max ${MAX_BYTES})` },
        { status: 413 }
      )
    }

    // Stream the file body to disk.
    const uploadId = crypto.randomBytes(8).toString('hex')
    const destPath = `${UPLOAD_DIR}/${uploadId}.zip`
    const reader = file.stream()
    const chunks: Uint8Array[] = []
    let totalBytes = 0
    for await (const chunk of reader as unknown as AsyncIterable<Uint8Array>) {
      totalBytes += chunk.byteLength
      if (totalBytes > MAX_BYTES) {
        return NextResponse.json(
          { error: 'Streamed payload exceeded size limit' },
          { status: 413 }
        )
      }
      chunks.push(new Uint8Array(chunk))
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)))
    await writeFile(destPath, buf)

    // Audit.
    await logAudit({
      userId: decoded.userId,
      action: 'project.upload',
      resource: 'project',
      resourceId: uploadId,
      req: request,
      metadata: {
        filename: file.name,
        sizeBytes: totalBytes,
        uploadId,
      },
    })

    return NextResponse.json(
      {
        uploadId,
        filename: file.name,
        sizeBytes: totalBytes,
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Upload error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
