'use client'

/** Admin → Discounts: referral programme settings and recent referrals. */
import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { Gift, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

interface Settings {
  enabled: boolean
  referrerReward: number
  refereeReward: number
  minPayment: number
  monthlyCap: number
}
interface Row {
  id: string
  referrer: string
  referred: string
  status: string
  reward: number | null
  note: string | null
  createdAt: string
}

export function ReferralsAdminCard() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<{ settings: Settings; referrals: Row[] }>('/admin/referrals')
      setSettings(d.settings)
      setRows(d.referrals)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load referrals')
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!settings) return
    setBusy(true)
    try {
      const d = await apiFetch<{ settings: Settings }>('/admin/referrals', { method: 'PUT', body: JSON.stringify(settings) })
      setSettings(d.settings)
      toast.success('Referral settings saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  const field = (k: 'referrerReward' | 'refereeReward' | 'minPayment' | 'monthlyCap', label: string, hint: string) => (
    <div className="space-y-1.5">
      <Label htmlFor={`ref-${k}`}>{label}</Label>
      <Input id={`ref-${k}`} type="number" min={0} step={k === 'monthlyCap' ? 1 : 0.01} value={settings?.[k] ?? 0} onChange={(e) => setSettings((s) => (s ? { ...s, [k]: Number(e.target.value) } : s))} />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Gift className="size-4" /> Referral programme
        </CardTitle>
        <CardDescription>Customers earn account credit when someone they refer makes a first payment. Rewards are paid automatically.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!settings ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <form onSubmit={save} className="space-y-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={settings.enabled} onCheckedChange={(v) => setSettings({ ...settings, enabled: v })} /> Programme active
            </label>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {field('referrerReward', 'Referrer reward ($)', 'Credit for the person who shared the link.')}
              {field('refereeReward', 'New customer reward ($)', '0 = none.')}
              {field('minPayment', 'Minimum first payment ($)', 'Smaller payments do not qualify.')}
              {field('monthlyCap', 'Rewards per referrer / 30 days', 'Stops abuse at scale.')}
            </div>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="me-1.5 size-4 animate-spin" />} Save
            </Button>
          </form>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-start text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Referrer</th>
                  <th className="px-3 py-2 font-medium">New customer</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">When</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-mono text-xs">{r.referrer}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.referred}</td>
                    <td className="px-3 py-2">
                      <Badge variant={r.status === 'rewarded' ? 'default' : 'secondary'} title={r.note || undefined}>
                        {r.status.replace('_', ' ')}
                        {r.reward ? ` · $${r.reward.toFixed(2)}` : ''}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{formatDistanceToNow(new Date(r.createdAt), { addSuffix: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
