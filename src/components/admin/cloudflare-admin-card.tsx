'use client'

/** Admin → Servers: connect the Cloudflare account used for customer CDN/WAF/DDoS. */
import { useCallback, useEffect, useState } from 'react'
import { Cloud, Loader2, CheckCircle2, Unplug } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Status {
  mode: 'live' | 'demo' | 'off'
  source: 'settings' | 'env' | null
  accountId: string | null
  zones: number
}

export function CloudflareAdminCard() {
  const [status, setStatus] = useState<Status | null>(null)
  const [token, setToken] = useState('')
  const [accountId, setAccountId] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<Status>('/admin/cloudflare'))
    } catch {
      setStatus(null)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await apiFetch<{ accountName: string }>('/admin/cloudflare', { method: 'PUT', body: JSON.stringify({ token, accountId: accountId || undefined }) })
      toast.success(`Connected to Cloudflare account “${r.accountName}”`)
      setToken('')
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not connect')
    } finally {
      setBusy(false)
    }
  }
  const disconnect = async () => {
    if (!confirm('Forget the saved Cloudflare token? Existing zones keep working on Cloudflare, but customers can no longer change them from the panel.')) return
    await apiFetch('/admin/cloudflare', { method: 'DELETE' }).catch(() => {})
    void load()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Cloud className="size-4" /> Cloudflare (CDN, WAF, DDoS)
          {status?.mode === 'live' && (
            <Badge className="gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300">
              <CheckCircle2 className="size-3" /> Connected
            </Badge>
          )}
          {status?.mode === 'demo' && <Badge variant="secondary">Simulated (development)</Badge>}
          {status?.mode === 'off' && <Badge variant="outline">Not connected</Badge>}
        </CardTitle>
        <CardDescription>
          Customer domains are added to this Cloudflare account. Until it is connected, plans don’t advertise CDN, WAF or DDoS protection.
          {status && ` ${status.zones} domain${status.zones === 1 ? '' : 's'} on Cloudflare.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status?.source === 'env' && <p className="text-sm text-muted-foreground">Using CLOUDFLARE_API_TOKEN from the server environment.</p>}
        {status?.source === 'settings' && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-muted-foreground">Account {status.accountId}</span>
            <Button variant="ghost" size="sm" onClick={disconnect}>
              <Unplug className="me-1.5 size-3.5" /> Disconnect
            </Button>
          </div>
        )}
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_220px_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="cf-token">{status?.source ? 'Replace API token' : 'API token'}</Label>
            <Input id="cf-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Zone, DNS, Zone Settings, Cache Purge edit + Account read" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cf-acct">Account ID (optional)</Label>
            <Input id="cf-acct" value={accountId} onChange={(e) => setAccountId(e.target.value)} />
          </div>
          <Button type="submit" disabled={busy || token.trim().length < 20}>
            {busy && <Loader2 className="me-1.5 size-4 animate-spin" />} Verify & save
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
