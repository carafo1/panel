import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyToken, extractTokenFromHeader } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ keyId: string }> }
) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = verifyToken(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const { keyId } = await params

    // Find the API key and verify ownership
    const apiKey = await db.apiKey.findUnique({
      where: { id: keyId },
    })

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key not found' },
        { status: 404 }
      )
    }

    if (apiKey.userId !== decoded.userId) {
      return NextResponse.json(
        { error: 'You can only delete your own API keys' },
        { status: 403 }
      )
    }

    const keyName = apiKey.name
    const keyPrefix = apiKey.prefix

    await db.apiKey.delete({
      where: { id: keyId },
    })

    // Audit API key deletion
    await logAudit({
      userId: decoded.userId,
      action: 'api_key.delete',
      resource: 'api_key',
      resourceId: keyId,
      req: request,
      metadata: {
        name: keyName,
        prefix: keyPrefix,
      },
    })

    return NextResponse.json({ message: 'API key deleted successfully' })
  } catch (error) {
    console.error('Delete API key error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
