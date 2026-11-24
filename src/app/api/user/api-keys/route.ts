import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { verifyTokenFresh, extractTokenFromHeader, hashApiKey } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import crypto from 'crypto'

export async function GET(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const apiKeys = await db.apiKey.findMany({
      where: { userId: decoded.userId },
      select: {
        id: true,
        name: true,
        prefix: true,
        lastUsed: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    })

    return NextResponse.json({
      apiKeys: apiKeys.map((key) => ({
        ...key,
        lastUsed: key.lastUsed?.toISOString() ?? null,
        createdAt: key.createdAt.toISOString(),
      })),
    })
  } catch (error) {
    console.error('Get API keys error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  try {
    const authHeader = request.headers.get('Authorization')
    const token = extractTokenFromHeader(authHeader)

    if (!token) {
      return NextResponse.json(
        { error: 'Authorization token required' },
        { status: 401 }
      )
    }

    const decoded = await verifyTokenFresh(token)
    if (!decoded) {
      return NextResponse.json(
        { error: 'Invalid or expired token' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'A JSON body is required' },
        { status: 400 }
      )
    }
    const { name } = body

    if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) {
      return NextResponse.json(
        { error: 'API key name is required (up to 100 characters)' },
        { status: 400 }
      )
    }

    // Generate a random API key with "dh_" prefix
    const rawKey = `dh_${crypto.randomBytes(32).toString('hex')}`
    const prefix = rawKey.substring(0, 8)

    // Only the SHA-256 digest is stored (lib/auth hashApiKey); the raw key is
    // returned in this response and can never be retrieved again.
    const apiKey = await db.apiKey.create({
      data: {
        userId: decoded.userId,
        name: name.trim(),
        key: hashApiKey(rawKey),
        prefix,
      },
      select: { id: true, name: true, prefix: true, createdAt: true },
    })

    // Audit API key creation
    await logAudit({
      userId: decoded.userId,
      action: 'api_key.create',
      resource: 'api_key',
      resourceId: apiKey.id,
      req: request,
      metadata: {
        name: apiKey.name,
        prefix: apiKey.prefix,
      },
    })

    // Return the full key only once
    return NextResponse.json({
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        prefix: apiKey.prefix,
        key: rawKey, // Full key - shown only once
        createdAt: apiKey.createdAt.toISOString(),
      },
    })
  } catch (error) {
    console.error('Create API key error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
