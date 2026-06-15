import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { encrypt, decrypt } from '@/lib/encryption'

/**
 * Mask a sensitive value for display.
 * Shows the first 2 characters followed by `****`
 * (e.g. `sk-abc123` -> `sk****`).
 *
 * For values shorter than 3 chars, we fully mask them
 * so as not to leak the entire secret.
 */
function maskValue(value: string): string {
  if (!value) return '****'
  if (value.length <= 2) return '****'
  return value.slice(0, 2) + '****'
}

/**
 * Decrypt a stored env var value if it is marked as encrypted.
 * Legacy (unencrypted) values are returned as-is.
 *
 * Failures are logged and we fall back to the raw stored value
 * so the UI can still render the row instead of erroring out.
 */
function revealValue(stored: string, encrypted: boolean): string {
  if (!encrypted) return stored
  try {
    return decrypt(stored)
  } catch (err) {
    console.error('[env] Failed to decrypt value, returning raw:', err)
    return stored
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id: projectId } = await params

    // Verify project ownership
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const envVars = await db.environmentVariable.findMany({
      where: { projectId },
      orderBy: { key: 'asc' },
    })

    // Check if the request wants unmasked (decrypted) values (via query param)
    const url = new URL(request.url)
    const reveal = url.searchParams.get('reveal') === 'true'

    return NextResponse.json({
      envVars: envVars.map((v) => {
        const plain = revealValue(v.value, v.encrypted)
        return {
          id: v.id,
          key: v.key,
          value: reveal ? plain : maskValue(plain),
          encrypted: v.encrypted,
          createdAt: v.createdAt.toISOString(),
          updatedAt: v.updatedAt.toISOString(),
        }
      }),
    })
  } catch (error) {
    console.error('Get env vars error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id: projectId } = await params
    const body = await request.json()
    const { key, value } = body

    if (!key || typeof key !== 'string' || !key.trim()) {
      return NextResponse.json(
        { error: 'Key is required' },
        { status: 400 }
      )
    }

    if (value === undefined || value === null || typeof value !== 'string') {
      return NextResponse.json(
        { error: 'Value is required' },
        { status: 400 }
      )
    }

    // Verify project ownership
    const project = await db.project.findFirst({
      where: { id: projectId, userId: decoded.userId },
    })

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    // Check for duplicate key
    const existing = await db.environmentVariable.findFirst({
      where: { projectId, key: key.trim() },
    })

    if (existing) {
      return NextResponse.json(
        { error: `Environment variable "${key.trim()}" already exists` },
        { status: 409 }
      )
    }

    // Always encrypt the value at rest with AES-256-GCM.
    // The `encrypted` flag is set to true so future reads know
    // to call decrypt() on the stored payload.
    const envVar = await db.environmentVariable.create({
      data: {
        projectId,
        key: key.trim(),
        value: encrypt(value),
        encrypted: true,
      },
    })

    return NextResponse.json({
      envVar: {
        id: envVar.id,
        key: envVar.key,
        value: maskValue(value),
        encrypted: envVar.encrypted,
        createdAt: envVar.createdAt.toISOString(),
        updatedAt: envVar.updatedAt.toISOString(),
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Create env var error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
