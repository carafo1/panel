'use client'

/**
 * A website's SFTP access: keys-only, chrooted to the site's files.
 *
 * Laid out as three steps for people who have never used SSH keys:
 *   1. get a key onto the account (made in the browser, or pasted),
 *   2. choose keys and turn SFTP on,
 *   3. connect, with per-app instructions.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { AlertTriangle, Check, FolderLock, KeyRound, Loader2, Lock, Plus, Power, RefreshCw, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { useAppStore } from '@/store/app-store'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { SftpKeySetup } from '@/components/hosting/sftp-key-setup'
import { SftpConnectGuide, type SftpConnection } from '@/components/hosting/sftp-connect-guide'

interface Info {
  planAllows: boolean
  planName: string | null
  enabled: boolean
  status: string | null
  lastError: string | null
  connection: SftpConnection | null
  keys: Array<{ id: string; name: string; fingerprint: string; mine: boolean }>
  myKeys: Array<{ id: string; name: string; fingerprint: string }>
}

function Step({ n, title, done, headingRef, children }: { n: number; title: string; done: boolean; headingRef?: RefObject<HTMLHeadingElement | null>; children: ReactNode }) {
  return (
    <li className="relative grid grid-cols-[1.75rem_minmax(0,1fr)] gap-x-3 pb-6 before:absolute before:top-9 before:bottom-2 before:left-[0.8125rem] before:w-px before:bg-border last:pb-0 last:before:hidden">
      <span
        aria-hidden
        className={`flex size-7 items-center justify-center rounded-full border text-xs font-semibold ${done ? 'border-primary bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 space-y-3">
        <h3 ref={headingRef} tabIndex={-1} className="text-sm leading-7 font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">
          <span className="sr-only">Step {n}: </span>
          {title}
          {done && <span className="sr-only"> (done)</span>}
        </h3>
        {children}
      </div>
    </li>
  )
}

export function SftpTab({ projectId }: { projectId: string }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addingKey, setAddingKey] = useState(false)
  const [keyFile, setKeyFile] = useState<string | null>(null)
  const step2Ref = useRef<HTMLHeadingElement>(null)
  const setDashboardTab = useAppStore((s) => s.setDashboardTab)

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<Info>(`/hosting/${projectId}/sftp`)
      setInfo(d)
      setSelected(d.keys.map((k) => k.id))
      setError(null)
      return d
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load SFTP access')
      return null
    }
  }, [projectId])
  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    setBusy(true)
    try {
      const d = await apiFetch<Info>(`/hosting/${projectId}/sftp`, { method: 'PUT', body: JSON.stringify({ keyIds: selected }) })
      toast.success(info?.enabled ? 'SFTP keys updated' : 'SFTP access is on')
      setInfo(d)
      setSelected(d.keys.map((k) => k.id))
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

  const conn = info?.connection ?? null
  const fileBase = conn?.username ?? 'website'

  const keyAdded = async (keyId: string, privateFile: string | null) => {
    if (privateFile) setKeyFile(privateFile)
    // Keep what the customer already ticked; pre-tick the new key.
    const ticked = selected
    const d = await load()
    if (d) setSelected([...new Set([...ticked, ...d.keys.map((k) => k.id), keyId])])
    setAddingKey(false)
    requestAnimationFrame(() => step2Ref.current?.focus())
  }

  // Keys the viewer can choose: their own, plus ones a teammate already granted.
  const choices = info ? [...info.myKeys.map((k) => ({ ...k, mine: true })), ...info.keys.filter((k) => !k.mine)] : []
  const changed = info ? selected.slice().sort().join() !== info.keys.map((k) => k.id).sort().join() : false
  const live = !!info?.enabled && info.status !== 'failed'
  const showKeySetup = choices.length === 0 || addingKey

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4" /> SFTP file access
        </CardTitle>
        <CardDescription>
          SFTP lets you upload, download and edit this website&rsquo;s files from an app on your computer, over an encrypted connection. You sign in with an SSH
          key instead of a password. Plain FTP is not available: always choose <strong className="font-medium text-foreground">SFTP</strong> in your app.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error ? (
          <div className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm" role="alert">
            <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
            <span className="flex-1">{error}</span>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              <RefreshCw className="me-1.5 size-3.5" /> Try again
            </Button>
          </div>
        ) : !info ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : !info.planAllows ? (
          <div className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              SFTP access is not included in your <strong>{info.planName}</strong> plan. Upgrade from <strong>Billing</strong> to use it.
            </p>
          </div>
        ) : (
          <>
            {info.status === 'failed' && info.lastError && (
              <p className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive" role="alert">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {info.lastError}
              </p>
            )}

            <ol className="list-none">
              <Step n={1} title="Add an SSH key to your account" done={choices.length > 0 && !addingKey}>
                <p className="text-sm text-muted-foreground">
                  An SSH key comes in two parts. The <strong className="font-medium text-foreground">private key</strong> is a file that stays on your computer and
                  proves it&rsquo;s you. The <strong className="font-medium text-foreground">public key</strong> is saved here so the server recognises it.
                </p>
                {showKeySetup ? (
                  <>
                    <SftpKeySetup fileBase={fileBase} onAdded={keyAdded} />
                    {choices.length > 0 && (
                      <Button variant="ghost" size="sm" onClick={() => setAddingKey(false)}>
                        Cancel
                      </Button>
                    )}
                  </>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="text-muted-foreground">
                      {choices.length === 1 ? '1 key is' : `${choices.length} keys are`} available.
                    </span>
                    <Button variant="outline" size="sm" onClick={() => setAddingKey(true)}>
                      <Plus className="me-1 size-3.5" /> Add another key
                    </Button>
                    <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setDashboardTab('settings')}>
                      Manage keys in Settings → Security
                    </button>
                  </div>
                )}
              </Step>

              <Step n={2} title={info.enabled ? 'Choose which keys can sign in' : 'Choose keys and turn on SFTP'} done={live && !changed} headingRef={step2Ref}>
                {choices.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Add a key in step 1 first.</p>
                ) : (
                  <>
                    <fieldset className="min-w-0 space-y-2">
                      <legend className="sr-only">Keys allowed to sign in</legend>
                      <ul className="divide-y rounded-md border">
                        {choices.map((k) => (
                          <li key={k.id}>
                            <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm">
                              <Checkbox
                                checked={selected.includes(k.id)}
                                onCheckedChange={(c) => setSelected((cur) => (c ? [...new Set([...cur, k.id])] : cur.filter((x) => x !== k.id)))}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block font-medium">
                                  {k.name}
                                  {!k.mine && <span className="ms-1.5 text-xs font-normal text-muted-foreground">(a teammate&rsquo;s)</span>}
                                </span>
                                <span className="block truncate font-mono text-[11px] text-muted-foreground">{k.fingerprint}</span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
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
                    {selected.length === 0 && <p className="text-xs text-muted-foreground">Tick at least one key.</p>}
                  </>
                )}
              </Step>

              <Step n={3} title="Connect with your SFTP app" done={false}>
                {conn ? (
                  <SftpConnectGuide conn={conn} keyFile={keyFile ?? `${fileBase}-sftp-ed25519.key`} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Your host and username appear here once SFTP is on, with step-by-step instructions for FileZilla, WinSCP, Cyberduck and the command line.
                  </p>
                )}
              </Step>
            </ol>

            <div className="space-y-2 border-t pt-4 text-xs text-muted-foreground">
              <p className="flex items-start gap-2">
                <FolderLock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {conn ? (
                    <>
                      You start in <code className="font-mono">{conn.directory}</code>, this website&rsquo;s files.
                    </>
                  ) : (
                    <>You start in this website&rsquo;s folder.</>
                  )}{' '}
                  Nothing outside it is visible, and
                  creating symbolic or hard links is blocked.
                </span>
              </p>
              <p className="flex items-start gap-2">
                <TerminalSquare className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                SFTP gives file access only. For commands (composer, npm, wp-cli), use the Terminal section, which runs inside your website&rsquo;s container.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
