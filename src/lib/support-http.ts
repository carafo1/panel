/** Shared request plumbing for the /api/support routes. */
import { NextResponse } from 'next/server'
import { extractTokenFromHeader, verifyTokenFresh } from '@/lib/auth'
import { SupportError, type Viewer } from '@/lib/support'

export async function supportViewer(request: Request): Promise<Viewer | null> {
  const token = extractTokenFromHeader(request.headers.get('Authorization'))
  const auth = token ? await verifyTokenFresh(token) : null
  return auth ? { userId: auth.userId, role: auth.role, email: auth.email } : null
}

export const unauthorized = () => NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })

export function supportFailure(error: unknown, label: string) {
  if (error instanceof SupportError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error(label, error)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}
