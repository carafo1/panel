'use client'

/** Billing → Refer a friend: personal link, how rewards work, and progress. */
import { useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Gift, Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'

interface Summary {
  enabled: boolean
  link: string
  referrerReward: number
  refereeReward: number
  minPayment: number
  totals: { signedUp: number; rewarded: number; earned: number }
  referrals: Array<{ id: string; who: string; status: string; reward: number | null; createdAt: string }>
}

const STATUS: Record<string, string> = { signed_up: 'Signed up', rewarded: 'Rewarded', not_rewarded: 'Not rewarded' }

export function ReferralCard() {
  const [data, setData] = useState<Summary | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    apiFetch<Summary>('/user/referrals').then(setData).catch(() => setFailed(true))
  }, [])

  if (failed || (data && !data.enabled)) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gift className="size-5 text-indigo-600" /> Refer a friend
        </CardTitle>
        {data && (
          <CardDescription>
            Share your link. When someone signs up with it and makes their first payment
            {data.minPayment > 0 ? ` of $${data.minPayment.toFixed(2)} or more` : ''}, you get ${data.referrerReward.toFixed(2)} credit
            {data.refereeReward > 0 ? ` and they get $${data.refereeReward.toFixed(2)}` : ''}.
          </CardDescription>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {!data ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <Input readOnly value={data.link} aria-label="Your referral link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button variant="outline" onClick={() => navigator.clipboard.writeText(data.link).then(() => toast.success('Link copied'))}>
                <Copy className="me-1.5 size-4" /> Copy
              </Button>
            </div>
            <dl className="grid grid-cols-3 gap-3 text-center">
              {(
                [
                  ['Signed up', String(data.totals.signedUp)],
                  ['Rewarded', String(data.totals.rewarded)],
                  ['Credit earned', `$${data.totals.earned.toFixed(2)}`],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="rounded-lg border p-3">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            {data.referrals.length > 0 && (
              <ul className="divide-y rounded-md border text-sm">
                {data.referrals.slice(0, 10).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <span className="font-mono text-xs">{r.who}</span>
                    <span className="flex items-center gap-2 text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}
                      <Badge variant={r.status === 'rewarded' ? 'default' : 'secondary'}>
                        {STATUS[r.status] || r.status}
                        {r.status === 'rewarded' && r.reward ? ` · $${r.reward.toFixed(2)}` : ''}
                      </Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
