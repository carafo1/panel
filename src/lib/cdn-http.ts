import { NextResponse } from 'next/server'
import { CdnError } from '@/lib/cdn'
import { CloudflareError } from '@/lib/cloudflare'

export function cdnFailure(error: unknown) {
  if (error instanceof CdnError || error instanceof CloudflareError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error('[cdn] failed:', error)
  return NextResponse.json({ error: 'CDN operation failed' }, { status: 500 })
}
