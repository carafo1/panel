'use client'

/**
 * Server backups, for the super-admin.
 *
 * The API behind this has existed for a while and nothing rendered it — so the
 * warnings it produces ("Backups exist only on this VPS", "the nightly job may
 * have stopped") were computed and thrown away. A backup system nobody can see
 * is one you find out about during an outage.
 *
 * Three questions, answered separately, because "we have backups" is only true
 * if all three hold:
 *   1. Do archives exist?
 *   2. Is the newest one RECENT? (a stopped cron looks fine from the file list)
 *   3. Does a copy live somewhere other than this machine?
 */
import { useCallback, useEffect, useState } from 'react'
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import {
  Loader2,
  RefreshCw,
  Archive,
  ShieldCheck,
  ShieldAlert,
  AlertTriangle,
  CloudOff,
  Cloud,
  Play,
  Download,
  Trash2,
} from 'lucide-react'

interface ArchiveRow {
  name: string
  bytes: number
  modified: string
}

interface OffsiteStatus {
  state: string
  detail: string
  archive?: string
  remoteBytes?: number
  at?: string
}

interface BackupsResponse {
  configured: boolean
  message?: string
  directory?: string
  archives: ArchiveRow[]
  count?: number
  totalBytes?: number
  newest?: string | null
  newestAgeHours?: number | null
  stale?: boolean
  offsite?: OffsiteStatus
  offsiteProtected?: boolean
  warnings?: string[]
}

function bytes(n?: number): string {
  if (!n) return '—'
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}


interface DriveState {
  configured: boolean
  reason?: string
  connected: boolean
  destination: {
    accountEmail: string | null
    folderName: string
    lastStatus: string | null
    lastError: string | null
    lastSyncAt: string | null
  } | null
}

/**
 * Drive connection for the OPERATOR.
 *
 * This is the account the platform's own backups go to. Whoever connects here
 * is choosing where the panel database, every tenant dump and .env end up, so
 * the copy says so plainly rather than calling it "offsite storage".
 */
function AdminDriveConnect({ onChange }: { onChange: () => void }) {
  const [state, setState] = useState<DriveState | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setState(await apiFetch<DriveState>('/backups/google'))
    } catch {
      // Show nothing rather than assert a state we did not read.
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const connect = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<{ url: string }>('/backups/google', { method: 'POST' })
      window.location.href = r.url
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the Google connection')
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (
      !window.confirm(
        'Disconnect Google Drive? Platform backups will stop being copied offsite. ' +
          'Archives already uploaded stay in the Drive.'
      )
    ) {
      return
    }
    setBusy(true)
    try {
      await apiFetch('/backups/google', { method: 'DELETE' })
      toast.success('Disconnected.')
      await load()
      onChange()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect')
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  if (!state.configured) {
    return (
      <div className="rounded-lg border p-3 text-sm text-muted-foreground">
        {state.reason ||
          'Google Drive is not set up on this platform. Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.'}
      </div>
    )
  }

  const d = state.destination
  const broken = Boolean(d && d.lastStatus === 'failed')

  if (!d) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 flex items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-sm min-w-0">
          <CloudOff className="size-4 text-amber-600 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="font-medium">No Google Drive connected</p>
            <p className="text-muted-foreground mt-0.5">
              Platform backups — panel database, tenant databases, volumes, mailcow config —
              stay on this server until one is.
            </p>
          </div>
        </div>
        <Button size="sm" onClick={connect} disabled={busy} className="shrink-0">
          {busy ? <Loader2 className="size-3.5 mr-1 animate-spin" /> : null}
          Connect Google Drive
        </Button>
      </div>
    )
  }

  return (
    <div
      className={`rounded-lg border p-3 flex items-center justify-between gap-3 ${
        broken ? 'border-destructive/40 bg-destructive/5' : ''
      }`}
    >
      <div className="flex items-start gap-2 text-sm min-w-0">
        {broken ? (
          <AlertTriangle className="size-4 text-destructive mt-0.5 shrink-0" />
        ) : (
          <Cloud className="size-4 text-emerald-600 mt-0.5 shrink-0" />
        )}
        <div className="min-w-0">
          <p className="font-medium">
            {broken ? 'Google Drive is not accepting uploads' : 'Platform backups go to Google Drive'}
          </p>
          <p className="text-muted-foreground mt-0.5 truncate">
            {broken ? d.lastError : `${d.accountEmail || 'Connected'} · ${d.folderName}`}
          </p>
          {!broken && d.lastSyncAt && (
            <p className="text-xs text-muted-foreground">
              Last upload {new Date(d.lastSyncAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {broken && (
          <Button size="sm" onClick={connect} disabled={busy}>
            Reconnect
          </Button>
        )}
        <Button variant="ghost" size="sm" onClick={disconnect} disabled={busy}>
          Disconnect
        </Button>
      </div>
    </div>
  )
}

export function BackupsAdminPanel() {
  const [data, setData] = useState<BackupsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)
  const [shipping, setShipping] = useState(false)
  const [acting, setActing] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await apiFetch<BackupsResponse>('/admin/backups'))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load backups')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const runBackup = async () => {
    setRunning(true)
    try {
      const res = await apiFetch<{ message?: string }>('/admin/backups', { method: 'POST' })
      toast.success(res.message || 'Server backup started.')
      // The job runs detached, so poll rather than pretending it is done.
      setTimeout(load, 20_000)
      setTimeout(load, 60_000)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not start the backup')
    } finally {
      setRunning(false)
    }
  }

  const sendOffsite = async () => {
    setShipping(true)
    try {
      const res = await apiFetch<{ message?: string }>('/admin/backups/offsite', {
        method: 'POST',
      })
      toast.success(res.message || 'Uploaded to Google Drive.')
      load()
    } catch (err) {
      // The route answers with specifics — no Drive connected, no passphrase,
      // Drive full — so show them rather than a generic failure.
      toast.error(err instanceof Error ? err.message : 'Offsite upload failed')
    } finally {
      setShipping(false)
    }
  }

  const download = async (name: string) => {
    setActing(name)
    try {
      const token = localStorage.getItem('apsamo_token')
      const res = await fetch(`/api/admin/backups/archive/${encodeURIComponent(name)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: 'Download failed' }))
        toast.error(e.error || 'Download failed')
        return
      }
      // Stream to a blob so the browser saves it with the right filename
      // instead of navigating away from the panel.
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('Network error downloading the archive')
    } finally {
      setActing(null)
    }
  }

  const remove = async (name: string) => {
    if (!window.confirm(`Delete ${name}? This cannot be undone.`)) return
    setActing(name)
    try {
      const res = await apiFetch<{ deleted?: string }>(
        `/admin/backups/archive/${encodeURIComponent(name)}`,
        { method: 'DELETE' }
      )
      toast.success(`Deleted ${res.deleted || name}`)
      load()
    } catch (err) {
      // The route explains itself — "this is the only backup archive" — so
      // show that rather than a generic failure.
      toast.error(err instanceof Error ? err.message : 'Could not delete the archive')
    } finally {
      setActing(null)
    }
  }

  if (loading) return <Skeleton className="h-64 w-full" />
  if (!data) return null

  const offsiteOk = data.offsiteProtected === true
  const stale = data.stale === true

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Archive className="size-5" />
                Server Backups
              </CardTitle>
              <CardDescription className="mt-1">
                {data.directory || 'Panel, database, tenant databases, volumes and mailcow config.'}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={load}>
                <RefreshCw className="size-3.5 mr-1" />
                Refresh
              </Button>
              <Button size="sm" onClick={runBackup} disabled={running}>
                {running ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Play className="size-3.5 mr-1" />
                )}
                Back up now
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={sendOffsite}
                disabled={shipping}
                title="Encrypt the newest archive and upload it to the connected Google Drive"
              >
                {shipping ? (
                  <Loader2 className="size-3.5 mr-1 animate-spin" />
                ) : (
                  <Cloud className="size-3.5 mr-1" />
                )}
                Send offsite
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Warnings first — they are the reason to look at this page. */}
          {data.warnings && data.warnings.length > 0 && (
            <div className="space-y-2">
              {data.warnings.map((w) => (
                <div
                  key={w}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 flex items-start gap-2 text-sm"
                >
                  <AlertTriangle className="size-4 text-amber-600 mt-0.5 shrink-0" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {!data.configured && (
            <div className="rounded-lg border p-3 text-sm text-muted-foreground">
              {data.message || 'The backup directory is not readable from the panel.'}
            </div>
          )}

          <AdminDriveConnect onChange={load} />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Archives</div>
              <div className="text-2xl font-semibold mt-1">{data.count ?? 0}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Total size</div>
              <div className="text-2xl font-semibold mt-1">{bytes(data.totalBytes)}</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Newest</div>
              <div className="text-lg font-semibold mt-1 flex items-center gap-1">
                {data.newestAgeHours == null ? (
                  '—'
                ) : (
                  <>
                    {data.newestAgeHours}h
                    {stale && <ShieldAlert className="size-4 text-amber-600" />}
                  </>
                )}
              </div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-xs text-muted-foreground">Offsite copy</div>
              <div className="mt-1">
                {offsiteOk ? (
                  <Badge variant="outline" className="border-emerald-500/50 text-emerald-600">
                    <Cloud className="size-3 mr-1" />
                    Protected
                  </Badge>
                ) : (
                  <Badge variant="outline" className="border-amber-500/50 text-amber-600">
                    <CloudOff className="size-3 mr-1" />
                    Local only
                  </Badge>
                )}
              </div>
            </div>
          </div>

          {data.offsite && (
            <div className="rounded-lg border p-3 text-sm">
              <div className="flex items-start gap-2">
                {offsiteOk ? (
                  <ShieldCheck className="size-4 text-emerald-600 mt-0.5 shrink-0" />
                ) : (
                  <ShieldAlert className="size-4 text-amber-600 mt-0.5 shrink-0" />
                )}
                <div>
                  <p className="font-medium">Offsite replication — {data.offsite.state}</p>
                  <p className="text-muted-foreground mt-0.5">{data.offsite.detail}</p>
                  {data.offsite.at && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Last reported {new Date(data.offsite.at).toLocaleString()}
                      {data.offsite.remoteBytes
                        ? ` · ${bytes(data.offsite.remoteBytes)} uploaded`
                        : ''}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {data.archives.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent archives</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Archive</TableHead>
                    <TableHead>Size</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.archives.map((a) => (
                    <TableRow key={a.name}>
                      <TableCell className="font-mono text-xs break-all">{a.name}</TableCell>
                      <TableCell>{bytes(a.bytes)}</TableCell>
                      <TableCell>{new Date(a.modified).toLocaleString()}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => download(a.name)}
                            disabled={acting === a.name}
                          >
                            {acting === a.name ? (
                              <Loader2 className="size-3 mr-1 animate-spin" />
                            ) : (
                              <Download className="size-3 mr-1" />
                            )}
                            Download
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-destructive hover:text-destructive"
                            onClick={() => remove(a.name)}
                            disabled={acting === a.name}
                          >
                            <Trash2 className="size-3 mr-1" />
                            Delete
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
