'use client'

/**
 * Staging for one live website: create a private copy, refresh it from live,
 * push it back, or remove it. See lib/staging.ts for what is copied.
 */
import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { FlaskConical, Loader2, ExternalLink, RefreshCw, Upload, Trash2, AlertTriangle, GitBranch, Lock, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Info {
  supported: boolean
  reason: string | null
  mode: 'wordpress' | 'files' | 'git' | null
  planAllows: boolean
  planName: string | null
  liveBranch: string | null
  staging: null | {
    id: string
    name: string
    url: string
    status: string
    stagingStatus: string | null
    stagingMessage: string | null
    syncedAt: string | null
    pushedAt: string | null
    branch: string | null
  }
}

const BUSY = ['creating', 'syncing', 'pushing']

export function StagingTab({ projectId, onOpenProject }: { projectId: string; onOpenProject?: (id: string) => void }) {
  const [info, setInfo] = useState<Info | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [branch, setBranch] = useState('')
  const [working, setWorking] = useState(false)
  const [confirm, setConfirm] = useState<null | 'push' | 'sync' | 'delete'>(null)
  const [withDb, setWithDb] = useState(false)

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<Info>(`/hosting/${projectId}/staging`)
      setInfo(d)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load staging')
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  // Poll while a long operation runs.
  const busy = !!info?.staging?.stagingStatus && BUSY.includes(info.staging.stagingStatus)
  useEffect(() => {
    if (!busy) return
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [busy, load])

  const act = async (action: 'create' | 'sync' | 'push', body: Record<string, unknown> = {}) => {
    setWorking(true)
    try {
      await apiFetch(`/hosting/${projectId}/staging`, { method: 'POST', body: JSON.stringify({ action, ...body }) })
      toast.success(action === 'create' ? 'Creating the staging site…' : action === 'sync' ? 'Refreshing staging from live…' : 'Pushing staging to live…')
      setConfirm(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Staging operation failed')
    } finally {
      setWorking(false)
    }
  }

  const remove = async () => {
    setWorking(true)
    try {
      await apiFetch(`/hosting/${projectId}/staging`, { method: 'DELETE' })
      toast.success('Staging site removed')
      setConfirm(null)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not remove staging')
    } finally {
      setWorking(false)
    }
  }

  const header = (
    <CardHeader>
      <CardTitle className="flex items-center gap-2 text-base">
        <FlaskConical className="size-4" /> Staging
      </CardTitle>
      <CardDescription>A private copy of this site where you can test updates before your visitors see them.</CardDescription>
    </CardHeader>
  )

  if (error) {
    return (
      <Card>
        {header}
        <CardContent>
          <p className="text-sm text-muted-foreground">{error}</p>
        </CardContent>
      </Card>
    )
  }
  if (!info) {
    return (
      <Card>
        {header}
        <CardContent className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </CardContent>
      </Card>
    )
  }

  const s = info.staging
  const what =
    info.mode === 'wordpress'
      ? 'Copies themes, plugins, uploads and the database. Staging is hidden from search engines and has its own database, so nothing you do there touches the live site.'
      : info.mode === 'git'
        ? 'Builds a branch of your repository on its own address, with its own copy of the database. To go live, merge the branch on your Git host — this site deploys automatically.'
        : 'Copies the site’s files and its database. Secrets in .env are not copied — staging uses this site’s environment variables.'

  return (
    <Card>
      {header}
      <CardContent className="space-y-4">
        {!info.supported ? (
          <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{info.reason}</p>
        ) : !info.planAllows ? (
          <div className="flex items-start gap-3 rounded-md border p-3 text-sm">
            <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p>
              Staging is not included in your <strong>{info.planName}</strong> plan. Upgrade from <strong>Billing</strong> to a plan with staging.
            </p>
          </div>
        ) : !s ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{what}</p>
            {info.mode === 'git' && (
              <div className="max-w-xs space-y-1.5">
                <Label htmlFor="stg-branch">Branch to build</Label>
                <div className="relative">
                  <GitBranch className="absolute start-2.5 top-2.5 size-4 text-muted-foreground" />
                  <Input id="stg-branch" className="ps-8" placeholder={info.liveBranch || 'main'} value={branch} onChange={(e) => setBranch(e.target.value)} />
                </div>
              </div>
            )}
            <Button onClick={() => act('create', info.mode === 'git' && branch.trim() ? { branch: branch.trim() } : {})} disabled={working}>
              {working ? <Loader2 className="me-1.5 size-4 animate-spin" /> : <FlaskConical className="me-1.5 size-4" />}
              Create staging site
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3 rounded-lg border p-4">
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <a href={s.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                    {s.url.replace('https://', '')}
                  </a>
                  <ExternalLink className="size-3.5 text-muted-foreground" />
                  {busy ? (
                    <Badge variant="secondary" className="gap-1">
                      <Loader2 className="size-3 animate-spin" /> {s.stagingStatus}
                    </Badge>
                  ) : s.stagingStatus === 'failed' ? (
                    <Badge variant="destructive">needs attention</Badge>
                  ) : (
                    <Badge variant="secondary" className="bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                      ready
                    </Badge>
                  )}
                  {s.branch && (
                    <Badge variant="outline" className="gap-1 font-mono text-[11px]">
                      <GitBranch className="size-3" /> {s.branch}
                    </Badge>
                  )}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {s.syncedAt ? `Copied from live ${formatDistanceToNow(new Date(s.syncedAt), { addSuffix: true })}` : 'Not copied yet'}
                  {s.pushedAt ? ` · last pushed live ${formatDistanceToNow(new Date(s.pushedAt), { addSuffix: true })}` : ''}
                </p>
              </div>
              {onOpenProject && (
                <Button variant="outline" size="sm" onClick={() => onOpenProject(s.id)}>
                  Manage staging <ArrowRight className="ms-1.5 size-3.5" />
                </Button>
              )}
            </div>

            {s.stagingMessage && (
              <p
                className={`flex items-start gap-2 rounded-md p-3 text-sm ${s.stagingStatus === 'failed' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'}`}
                role="status"
              >
                {s.stagingStatus === 'failed' ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />}
                {s.stagingMessage}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => { setWithDb(true); setConfirm('sync') }} disabled={busy || working}>
                <RefreshCw className="me-1.5 size-4" /> Refresh from live
              </Button>
              {info.mode !== 'git' && (
                <Button onClick={() => { setWithDb(false); setConfirm('push') }} disabled={busy || working || s.stagingStatus !== 'ready'}>
                  <Upload className="me-1.5 size-4" /> Push to live
                </Button>
              )}
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setConfirm('delete')} disabled={busy || working}>
                <Trash2 className="me-1.5 size-4" /> Remove staging
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirm === 'push' ? 'Push staging to the live site?' : confirm === 'sync' ? 'Refresh staging from live?' : 'Remove the staging site?'}
            </DialogTitle>
            <DialogDescription>
              {confirm === 'push'
                ? 'The live site’s files are replaced with staging’s. A full backup of the live site is taken first, so you can restore it from Backups.'
                : confirm === 'sync'
                  ? 'Staging is overwritten with the live site’s current content. Changes you made on staging are lost.'
                  : 'The staging site, its files and its database are deleted. The live site is not affected.'}
            </DialogDescription>
          </DialogHeader>
          {(confirm === 'push' || confirm === 'sync') && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={withDb} onCheckedChange={(c) => setWithDb(c === true)} className="mt-0.5" />
              <span>
                {confirm === 'push' ? 'Also replace the live database' : 'Also copy the database'}
                {confirm === 'push' && (
                  <span className="block text-xs text-muted-foreground">
                    Leave off for shops or sites with new orders, sign-ups or comments since staging was made — they would be lost.
                  </span>
                )}
              </span>
            </label>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant={confirm === 'delete' ? 'destructive' : 'default'}
              disabled={working}
              onClick={() => (confirm === 'delete' ? remove() : act(confirm!, { database: withDb }))}
            >
              {working && <Loader2 className="me-1.5 size-4 animate-spin" />}
              {confirm === 'push' ? 'Back up and push' : confirm === 'sync' ? 'Refresh staging' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
