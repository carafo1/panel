'use client'

/** A website's Cloudflare protection: CDN, WAF and DDoS for its custom domains. */
import { useCallback, useEffect, useState } from 'react'
import { Cloud, Loader2, Lock, RefreshCw, Trash2, Copy, Zap, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface Zone {
  id: string
  domain: string
  status: 'pending' | 'active' | 'error'
  nameservers: string[]
  securityLevel: string
  developmentMode: boolean
  lastError: string | null
}
interface Info {
  mode: 'live' | 'demo' | 'off'
  planAllows: boolean
  underAttackAllowed: boolean
  planName: string | null
  candidates: string[]
  zones: Zone[]
}

const LEVELS: Array<[string, string]> = [
  ['essentially_off', 'Essentially off'],
  ['low', 'Low'],
  ['medium', 'Medium (recommended)'],
  ['high', 'High'],
  ['under_attack', "I'm under attack"],
]

export function CdnTab({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setInfo(await apiFetch<Info>(`/hosting/${projectId}/cdn`))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load CDN settings')
    }
  }, [projectId])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key)
    try {
      await fn()
      if (done) toast.success(done)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Cloudflare request failed')
    } finally {
      setBusy(null)
    }
  }
  const zoneUrl = (z: Zone) => `/hosting/${projectId}/cdn/${z.id}`

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Cloud className="size-4" /> CDN & protection
        </CardTitle>
        <CardDescription>
          Serve your domain through Cloudflare: faster pages worldwide, a web application firewall and DDoS protection.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : !info ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : info.mode === 'off' ? (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">Cloudflare protection isn’t available on this platform yet.</p>
        ) : !info.planAllows ? (
          <div className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              CDN & protection is not included in your <strong>{info.planName}</strong> plan. Upgrade from <strong>Billing</strong> to use it.
            </p>
          </div>
        ) : (
          <>
            {info.mode === 'demo' && (
              <p className="rounded-md border border-dashed p-2 text-xs text-muted-foreground">Development mode: Cloudflare calls are simulated (no API token configured).</p>
            )}

            {info.zones.map((z) => (
              <div key={z.id} className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{z.domain}</span>
                  {z.status === 'active' ? (
                    <Badge className="gap-1 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300">
                      <CheckCircle2 className="size-3" /> Protected
                    </Badge>
                  ) : z.status === 'error' ? (
                    <Badge variant="destructive">Needs attention</Badge>
                  ) : (
                    <Badge variant="secondary">Waiting for nameservers</Badge>
                  )}
                  <div className="ms-auto flex gap-1">
                    <Button variant="ghost" size="sm" disabled={!!busy} onClick={() => run(`r-${z.id}`, () => apiFetch(zoneUrl(z), { method: 'POST', body: JSON.stringify({ action: 'refresh' }) }))}>
                      {busy === `r-${z.id}` ? <Loader2 className="me-1.5 size-3.5 animate-spin" /> : <RefreshCw className="me-1.5 size-3.5" />} Check
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={!!busy}
                      onClick={() => {
                        if (confirm(`Take ${z.domain} off Cloudflare? Change its nameservers back first, or the domain will stop resolving.`)) {
                          void run(`d-${z.id}`, () => apiFetch(zoneUrl(z), { method: 'DELETE' }), 'Removed from Cloudflare')
                        }
                      }}
                    >
                      <Trash2 className="me-1.5 size-3.5" /> Remove
                    </Button>
                  </div>
                </div>

                {z.lastError && (
                  <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {z.lastError}
                  </p>
                )}

                {z.status !== 'active' && (
                  <div className="space-y-2 rounded-md bg-muted/60 p-3 text-sm">
                    <p>
                      At the company where <strong>{z.domain}</strong> is registered, replace its nameservers with these two. Your email and other records were copied
                      to Cloudflare.
                    </p>
                    <ul className="space-y-1">
                      {z.nameservers.map((ns) => (
                        <li key={ns} className="flex items-center gap-2">
                          <code className="rounded bg-background px-2 py-0.5 font-mono text-xs">{ns}</code>
                          <Button variant="ghost" size="icon" className="size-6" aria-label={`Copy ${ns}`} onClick={() => navigator.clipboard.writeText(ns).then(() => toast.success('Copied'))}>
                            <Copy className="size-3" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-muted-foreground">It usually takes a few minutes to a few hours. Press Check to see if it’s done.</p>
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <p className="text-xs font-medium">Security level</p>
                    <Select
                      value={z.securityLevel}
                      onValueChange={(v) => run(`s-${z.id}`, () => apiFetch(zoneUrl(z), { method: 'PATCH', body: JSON.stringify({ securityLevel: v }) }), 'Security level updated')}
                    >
                      <SelectTrigger aria-label="Security level" className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {LEVELS.map(([v, l]) => (
                          <SelectItem key={v} value={v} disabled={v === 'under_attack' && !info.underAttackAllowed}>
                            {l}
                            {v === 'under_attack' && !info.underAttackAllowed ? ' (higher plans)' : ''}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-[11px] text-muted-foreground">“I’m under attack” shows visitors a short check page while you’re being flooded.</p>
                  </div>
                  <div className="space-y-2">
                    <label className="flex items-center justify-between gap-3 text-sm">
                      <span>
                        Development mode
                        <span className="block text-[11px] text-muted-foreground">Bypass the cache for 3 hours while you edit.</span>
                      </span>
                      <Switch
                        checked={z.developmentMode}
                        onCheckedChange={(c) => run(`m-${z.id}`, () => apiFetch(zoneUrl(z), { method: 'PATCH', body: JSON.stringify({ developmentMode: c }) }))}
                      />
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!!busy}
                      onClick={() => run(`p-${z.id}`, () => apiFetch(zoneUrl(z), { method: 'POST', body: JSON.stringify({ action: 'purge' }) }), 'Cache cleared')}
                    >
                      {busy === `p-${z.id}` ? <Loader2 className="me-1.5 size-3.5 animate-spin" /> : <Zap className="me-1.5 size-3.5" />} Clear cache
                    </Button>
                  </div>
                </div>
              </div>
            ))}

            {info.candidates.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {info.candidates.map((d) => (
                  <Button
                    key={d}
                    variant={info.zones.length ? 'outline' : 'default'}
                    disabled={!!busy}
                    onClick={() => run(`e-${d}`, () => apiFetch(`/hosting/${projectId}/cdn`, { method: 'POST', body: JSON.stringify({ domain: d }) }), `${d} added to Cloudflare`)}
                  >
                    {busy === `e-${d}` ? <Loader2 className="me-1.5 size-4 animate-spin" /> : <Cloud className="me-1.5 size-4" />} Protect {d}
                  </Button>
                ))}
              </div>
            ) : (
              info.zones.length === 0 && <p className="text-sm text-muted-foreground">Connect a domain to this website first (Domains &amp; SSL). The CDN protects your own domain.</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
