import { NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/auth'
import { referralSummary } from '@/lib/referrals'

/** GET /api/user/referrals — your referral link, rewards and who signed up (emails masked). */
export async function GET(request: Request) {
  const auth = await authenticateRequest(request)
  if (!auth) return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  return NextResponse.json(await referralSummary(auth.userId), { headers: { 'Cache-Control': 'no-store' } })
}
