import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { authenticateRequest } from '@/lib/auth'
import { requireProjectAccess } from '@/lib/project-access'
import { isValidEnvKey, ENV_KEY_ERROR } from '@/lib/safe-values'
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

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; varId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id: projectId, varId } = await params
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { key, value } = body

    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response

    // Find the env var
    const envVar = await db.environmentVariable.findFirst({
      where: { id: varId, projectId },
    })

    if (!envVar) {
      return NextResponse.json(
        { error: 'Environment variable not found' },
        { status: 404 }
      )
    }

    // Renaming is a write path too: same compose interpolation, same risk.
    if (typeof key === 'string' && key.trim() && !isValidEnvKey(key.trim())) {
      return NextResponse.json({ error: ENV_KEY_ERROR }, { status: 400 })
    }

    // If key is being changed, check for duplicates
    if (key && key.trim() !== envVar.key) {
      const duplicate = await db.environmentVariable.findFirst({
        where: { projectId, key: key.trim() },
      })
      if (duplicate) {
        return NextResponse.json(
          { error: `Environment variable "${key.trim()}" already exists` },
          { status: 409 }
        )
      }
    }

    const updateData: Record<string, unknown> = {}
    if (typeof key === 'string' && key.trim()) updateData.key = key.trim()
    if (typeof value === 'string' && value.length > 0) {
      // Re-encrypt the new plaintext value at rest and mark as encrypted.
      updateData.value = encrypt(value)
      updateData.encrypted = true
    }

    const updated = await db.environmentVariable.update({
      where: { id: varId },
      data: updateData,
    })

    // For the response, decrypt the stored value (if encrypted) and mask it
    // so we never leak the plaintext over the wire on a PATCH response.
    const plain = revealValue(updated.value, updated.encrypted)

    return NextResponse.json({
      envVar: {
        id: updated.id,
        key: updated.key,
        value: maskValue(plain),
        encrypted: updated.encrypted,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Update env var error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; varId: string }> }
) {
  try {
    const decoded = await authenticateRequest(request)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { id: projectId, varId } = await params

    const access = await requireProjectAccess(decoded, projectId, 'configure')
    if (!access.ok) return access.response

    // Find the env var
    const envVar = await db.environmentVariable.findFirst({
      where: { id: varId, projectId },
    })

    if (!envVar) {
      return NextResponse.json(
        { error: 'Environment variable not found' },
        { status: 404 }
      )
    }

    await db.environmentVariable.delete({
      where: { id: varId },
    })

    return NextResponse.json({
      message: 'Environment variable deleted successfully',
    })
  } catch (error) {
    console.error('Delete env var error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
