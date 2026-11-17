'use client'

/** Admin → Servers: Dynadot API keys (domain search, registration, renewals). */
import { useCallback, useEffect, useState } from 'react'
import { Globe, Loader2, CheckCircle2, AlertTriangle, PlugZap, Unplug, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Status {
  source: 'settings' | 'env' | null
  keyHint: string | null
  hasSecret: boolean
  envHasKey: boolean
}
interface TestResult {
  ok: boolean
  message: string
  blockedIp: string | null
}

export function DynadotAdminCard() {
  const [status, setStatus] = useState<Status | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [secretKey, setSecretKey] = useState('')
  const [busy, setBusy] = useState<null | 'save' | 'test' | 'clear'>(null)
  const [test, setTest] = useState<TestResult | null>(null)

  const load = useCallback(async () => {
    try {
      setStatus(await apiFetch<Status>('/admin/dynadot'))
    } catch {
      setStatus(null)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy('save')
    try {
      const r = await apiFetch<Status & { test: TestResult }>('/admin/dynadot', { method: 'PUT', body: JSON.stringify({ apiKey, secretKey }) })
      setStatus(r)
      setTest(r.test)
      setApiKey('')
      setSecretKey('')
      if (r.test.ok) toast.success('Dynadot keys saved and working')
      else toast.warning('Keys saved, but Dynadot did not accept this server yet')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the keys')
    } finally {
      setBusy(null)
    }
  }

  const runTest = async () => {
    setBusy('test')
    try {
      setTest(await apiFetch<TestResult>('/admin/dynadot', { method: 'POST', body: JSON.stringify({ action: 'test' }) }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed')
    } finally {
      setBusy(null)
    }
  }

  const clear = async () => {
    if (!confirm(status?.envHasKey ? 'Remove the saved keys? The panel goes back to the keys in the server’s .env file.' : 'Remove the saved keys? Domain search and registration stop working until new keys are added.')) return
    setBusy('clear')
    try {
      setStatus(await apiFetch<Status>('/admin/dynadot', { method: 'DELETE' }))
      setTest(null)
      toast.success('Saved Dynadot keys removed')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the keys')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Globe className="size-4" /> Dynadot (domain registration)
          {status?.source === 'settings' && <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-950 dark:text-emerald-300">Saved in panel {status.keyHint}</Badge>}
          {status?.source === 'env' && <Badge variant="secondary">From .env {status.keyHint}</Badge>}
          {status && !status.source && <Badge variant="outline">Not connected</Badge>}
        </CardTitle>
        <CardDescription>
          Keys saved here are stored encrypted in the database and take priority over the server’s .env file, so they never need to be in a file or the repository.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={save} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="dyn-key">{status?.source === 'settings' ? 'Replace API key' : 'API key'}</Label>
            <Input id="dyn-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dyn-secret">Secret key (optional)</Label>
            <Input id="dyn-secret" type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} />
          </div>
          <Button type="submit" disabled={!!busy || apiKey.trim().length < 20}>
            {busy === 'save' && <Loader2 className="me-1.5 size-4 animate-spin" />} Save & test
          </Button>
        </form>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={runTest} disabled={!!busy || !status?.source}>
            {busy === 'test' ? <Loader2 className="me-1.5 size-3.5 animate-spin" /> : <PlugZap className="me-1.5 size-3.5" />} Test connection
          </Button>
          {status?.source === 'settings' && (
            <Button variant="ghost" size="sm" onClick={clear} disabled={!!busy}>
              <Unplug className="me-1.5 size-3.5" /> Remove saved keys
            </Button>
          )}
        </div>

        {test && (
          <div
            role="status"
            className={`flex items-start gap-2 rounded-md p-3 text-sm ${test.ok ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200' : 'bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100'}`}
          >
            {test.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
            <div className="space-y-1">
              <p>{test.message}</p>
              {test.blockedIp && (
                <p className="flex items-center gap-2">
                  <span>Dynadot → Settings → API → allowed IPs:</span>
                  <code className="rounded bg-background px-1.5 py-0.5 font-mono text-xs">{test.blockedIp}</code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    aria-label="Copy IP address"
                    onClick={() => navigator.clipboard.writeText(test.blockedIp!).then(() => toast.success('Copied'))}
                  >
                    <Copy className="size-3" />
                  </Button>
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
