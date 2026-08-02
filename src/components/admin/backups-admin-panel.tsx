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

export function BackupsAdminPanel() {
  const [data, setData] = useState<BackupsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

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
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.archives.map((a) => (
                    <TableRow key={a.name}>
                      <TableCell className="font-mono text-xs break-all">{a.name}</TableCell>
                      <TableCell>{bytes(a.bytes)}</TableCell>
                      <TableCell>{new Date(a.modified).toLocaleString()}</TableCell>
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
