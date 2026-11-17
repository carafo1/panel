'use client'

/** A website's SFTP access: keys-only, chrooted to the site's files. */
import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Loader2, Lock, Copy, Power, AlertTriangle, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { useAppStore } from '@/store/app-store'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'

interface Info {
  planAllows: boolean
  planName: string | null
  enabled: boolean
  status: string | null
  lastError: string | null
  connection: { host: string; port: number; username: string; directory: string } | null
  keys: Array<{ id: string; name: string; fingerprint: string; mine: boolean }>
  myKeys: Array<{ id: string; name: string; fingerprint: string }>
}

export function SftpTab({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setDashboardTab = useAppStore((s) => s.setDashboardTab)

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<Info>(`/hosting/${projectId}/sftp`)
      setInfo(d)
      setSelected(d.keys.map((k) => k.id))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load SFTP access')
    }
  }, [projectId])
  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    setBusy(true)
    try {
      const d = await apiFetch<Info>(`/hosting/${projectId}/sftp`, { method: 'PUT', body: JSON.stringify({ keyIds: selected }) })
      setInfo(d)
      toast.success(info?.enabled ? 'SFTP keys updated' : 'SFTP access is on')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update SFTP access')
    } finally {
      setBusy(false)
    }
  }
  const disable = async () => {
    if (!confirm('Turn off SFTP for this website? Open SFTP sessions are closed.')) return
    setBusy(true)
    try {
      await apiFetch(`/hosting/${projectId}/sftp`, { method: 'DELETE' })
      toast.success('SFTP access turned off')
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not turn off SFTP')
    } finally {
      setBusy(false)
    }
  }

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text).then(() => toast.success('Copied'))
  }

  // Keys the viewer can choose: their own, plus ones a teammate already granted.
  const choices = info ? [...info.myKeys.map((k) => ({ ...k, mine: true })), ...info.keys.filter((k) => !k.mine)] : []
  const changed = info ? selected.slice().sort().join() !== info.keys.map((k) => k.id).sort().join() : false
  const conn = info?.connection
  const command = conn ? `sftp ${conn.port !== 22 ? `-P ${conn.port} ` : ''}${conn.username}@${conn.host}` : ''

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" /> SSH / SFTP access
        </CardTitle>
        <CardDescription>
          Upload and edit files with an SFTP app (FileZilla, Cyberduck, WinSCP, VS Code). Sign-in is by SSH key only, and only this website’s files are visible.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : !info ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : !info.planAllows ? (
          <div className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              SSH/SFTP access is not included in your <strong>{info.planName}</strong> plan. Upgrade from <strong>Billing</strong> to use it.
            </p>
          </div>
        ) : (
          <>
            {info.status === 'failed' && info.lastError && (
              <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {info.lastError}
              </p>
            )}

            {conn && (
              <dl className="grid gap-x-6 gap-y-2 rounded-lg border p-4 text-sm sm:grid-cols-[auto_1fr]">
                {(
                  [
                    ['Host', conn.host],
                    ['Port', String(conn.port)],
                    ['Username', conn.username],
                    ['Folder', `${conn.directory} (your website’s files)`],
                  ] as const
                ).map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-muted-foreground">{k}</dt>
                    <dd className="font-mono text-xs leading-5">{v}</dd>
                  </div>
                ))}
                <dt className="text-muted-foreground">Command</dt>
                <dd className="flex items-center gap-2">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-xs">{command}</code>
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => copy(command)} aria-label="Copy command">
                    <Copy className="size-3.5" />
                  </Button>
                </dd>
              </dl>
            )}

            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Keys allowed to sign in</legend>
              {choices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  You have no SSH keys yet.{' '}
                  <button type="button" className="font-medium underline underline-offset-2" onClick={() => setDashboardTab('settings')}>
                    Add one in Settings → Security
                  </button>
                  .
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {choices.map((k) => (
                    <li key={k.id}>
                      <label className="flex items-center gap-2 text-sm">
                        <Checkbox
                          checked={selected.includes(k.id)}
                          onCheckedChange={(c) => setSelected((cur) => (c ? [...cur, k.id] : cur.filter((x) => x !== k.id)))}
                        />
                        <span>{k.name}</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">{k.fingerprint}</span>
                        {!k.mine && <span className="text-[11px] text-muted-foreground">(a teammate’s)</span>}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>

            <div className="flex flex-wrap gap-2">
              <Button onClick={save} disabled={busy || selected.length === 0 || (info.enabled && !changed && info.status !== 'failed')}>
                {busy && <Loader2 className="me-1.5 size-4 animate-spin" />}
                {info.enabled ? (info.status === 'failed' ? 'Retry' : 'Save keys') : 'Turn on SFTP'}
              </Button>
              {info.enabled && (
                <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={disable} disabled={busy}>
                  <Power className="me-1.5 size-4" /> Turn off
                </Button>
              )}
            </div>

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <TerminalSquare className="mt-0.5 size-3.5 shrink-0" />
              SFTP gives file access only. For commands (composer, npm, wp-cli), use the Terminal section, which runs inside your website’s container.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
