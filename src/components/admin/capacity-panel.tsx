'use client'

/**
 * Admin capacity view: how much each server has left, what each customer site
 * costs it, and what is left over that no site owns (orphans).
 *
 * Measurements come from GET /api/admin/capacity (read-only commands on each
 * server, cached 60 s). Anything not measured shows "—", never 0. Orphan
 * containers can be removed one at a time, after confirmation, through
 * POST /api/admin/infrastructure/orphans/remove, which re-checks on the server
 * that nothing refers to the container.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import {
  AlertTriangle,
  Boxes,
  Cpu,
  HardDrive,
  Loader2,
  MemoryStick,
  RefreshCw,
  Trash2,
  Ghost,
} from 'lucide-react'

// ── Types (mirror src/app/api/admin/capacity/capacity.ts) ────────────────

type Level = 'amber' | 'red'

interface Site {
  projectId: string
  name: string
  slug: string
  status: string
  deployPath: string | null
  containers: string[]
  containerMemoryBytes: number | null
  diskBytes: number | null
  databaseContainers: string[]
  databaseMemoryBytes: number | null
}

interface OrphanContainer {
  serverId: string
  id: string
  name: string
  state: string
  createdAt: string | null
  memoryBytes: number | null
  volumes: string[]
}

interface CapacityServer {
  id: string
  name: string
  ip: string
  demo: boolean
  error: string | null
  ram: { totalMB: number; usedMB: number; availableMB: number; availablePct: number } | null
  disk: { totalBytes: number; usedBytes: number; availableBytes: number; usedPct: number } | null
  cpuCount: number | null
  runningContainers: number | null
  warnings: Array<{ level: Level; kind: 'ram' | 'disk'; message: string }>
  sites: Site[]
  orphans: {
    containers: OrphanContainer[]
    volumes: Array<{ name: string; sizeBytes: number | null }>
    folders: Array<{ path: string; sizeBytes: number | null }>
    memoryBytes: number
  } | null
}

interface CapacityResponse {
  generatedAt: string
  cached: boolean
  thresholds: {
    ramAvailableWarnPct: number
    ramAvailableRedPct: number
    diskUsedWarnPct: number
    diskUsedRedPct: number
  }
  servers: CapacityServer[]
}

// ── Formatting ────────────────────────────────────────────────────────────

function bytes(n: number | null | undefined): string {
  if (n == null) return '—'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

const mb = (n: number) => bytes(n * 1024 * 1024)

const TONE: Record<Level | 'ok', { bar: string; text: string; box: string }> = {
  ok: { bar: 'bg-emerald-500', text: 'text-foreground', box: '' },
  amber: {
    bar: 'bg-amber-500',
    text: 'text-amber-700 dark:text-amber-400',
    box: 'border-amber-500/50 bg-amber-500/5',
  },
  red: {
    bar: 'bg-red-500',
    text: 'text-red-700 dark:text-red-400',
    box: 'border-red-500/50 bg-red-500/5',
  },
}

function levelOf(s: CapacityServer, kind: 'ram' | 'disk'): Level | 'ok' {
  return s.warnings.find((w) => w.kind === kind)?.level ?? 'ok'
}

// ── Pieces ────────────────────────────────────────────────────────────────

function Gauge({
  icon: Icon,
  label,
  value,
  sub,
  percent,
  level = 'ok',
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  percent?: number | null
  level?: Level | 'ok'
}) {
  const tone = TONE[level]
  return (
    <div className={`rounded-lg border p-3 ${tone.box}`}>
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
        {level !== 'ok' && (
          <AlertTriangle className={`ms-auto size-3.5 ${tone.text}`} aria-label={`${level} warning`} />
        )}
      </div>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${tone.text}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}
      {percent != null && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
          role="meter"
          aria-label={`${label} used`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <div
            className={`h-full rounded-full ${tone.bar} transition-[width] duration-700`}
            style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
          />
        </div>
      )}
    </div>
  )
}

function SitesTable({ server }: { server: CapacityServer }) {
  const sites = useMemo(
    () =>
      [...server.sites].sort(
        (a, b) =>
          (b.containerMemoryBytes ?? 0) + (b.databaseMemoryBytes ?? 0) -
          ((a.containerMemoryBytes ?? 0) + (a.databaseMemoryBytes ?? 0))
      ),
    [server.sites]
  )
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <caption className="sr-only">Customer sites on {server.name}, by memory use</caption>
        <thead className="bg-muted/50 text-xs">
          <tr>
            <th scope="col" className="p-2 text-start">Site</th>
            <th scope="col" className="p-2 text-end">App memory</th>
            <th scope="col" className="p-2 text-end">Database memory</th>
            <th scope="col" className="p-2 text-end">Disk</th>
          </tr>
        </thead>
        <tbody>
          {sites.length === 0 ? (
            <tr>
              <td colSpan={4} className="p-6 text-center text-muted-foreground">
                No customer sites on this server.
              </td>
            </tr>
          ) : (
            sites.map((s) => (
              <tr key={s.projectId} className="border-t">
                <td className="p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{s.name}</span>
                    {s.status !== 'running' && (
                      <Badge variant="outline" className="text-[10px]">{s.status}</Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground break-all">
                    {s.containers.length ? s.containers.join(', ') : 'no container found'}
                  </p>
                </td>
                <td className="p-2 text-end tabular-nums">{bytes(s.containerMemoryBytes)}</td>
                <td className="p-2 text-end tabular-nums">
                  {s.databaseContainers.length ? bytes(s.databaseMemoryBytes) : '—'}
                </td>
                <td className="p-2 text-end tabular-nums">{bytes(s.diskBytes)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

function OrphansSection({
  server,
  onRemove,
}: {
  server: CapacityServer
  onRemove: (c: OrphanContainer) => void
}) {
  const o = server.orphans
  if (!o) return null
  const total = o.containers.length + o.volumes.length + o.folders.length
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <Ghost className="size-4" aria-hidden />
          Orphaned resources
        </p>
        {o.containers.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {o.containers.length} container(s) holding {bytes(o.memoryBytes)} RAM
          </p>
        )}
      </div>
      {total === 0 ? (
        <p className="rounded-md border p-4 text-center text-sm text-muted-foreground">
          Nothing orphaned: every deployhub container, volume and project folder belongs to a site.
        </p>
      ) : (
        <div className="space-y-3">
          {o.containers.length > 0 && (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <caption className="sr-only">Containers no site or database refers to</caption>
                <thead className="bg-muted/50 text-xs">
                  <tr>
                    <th scope="col" className="p-2 text-start">Container</th>
                    <th scope="col" className="p-2 text-start">State</th>
                    <th scope="col" className="p-2 text-end">Memory</th>
                    <th scope="col" className="p-2 text-start">Created</th>
                    <th scope="col" className="p-2 text-end">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {o.containers.map((c) => (
                    <tr key={c.id || c.name} className="border-t">
                      <td className="p-2">
                        <span className="font-mono text-xs break-all">{c.name}</span>
                        {c.volumes.length > 0 && (
                          <p className="text-[11px] text-muted-foreground break-all">
                            volumes: {c.volumes.join(', ')}
                          </p>
                        )}
                      </td>
                      <td className="p-2 text-xs">{c.state}</td>
                      <td className="p-2 text-end tabular-nums">{bytes(c.memoryBytes)}</td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {c.createdAt ? new Date(c.createdAt).toLocaleString() : '—'}
                      </td>
                      <td className="p-2 text-end">
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-red-600 hover:text-red-700 dark:text-red-400"
                          onClick={() => onRemove(c)}
                          aria-label={`Remove container ${c.name}`}
                        >
                          <Trash2 className="size-3.5 me-1" aria-hidden />
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(o.volumes.length > 0 || o.folders.length > 0) && (
            <div className="grid gap-3 md:grid-cols-2">
              {o.volumes.length > 0 && (
                <div className="rounded-md border p-3">
                  <p className="text-xs font-medium">Dangling volumes ({o.volumes.length})</p>
                  <ul className="mt-1.5 space-y-1 text-xs">
                    {o.volumes.map((v) => (
                      <li key={v.name} className="flex justify-between gap-2">
                        <span className="font-mono break-all">{v.name}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{bytes(v.sizeBytes)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {o.folders.length > 0 && (
                <div className="rounded-md border p-3">
                  <p className="text-xs font-medium">Project folders without a site ({o.folders.length})</p>
                  <ul className="mt-1.5 space-y-1 text-xs">
                    {o.folders.map((f) => (
                      <li key={f.path} className="flex justify-between gap-2">
                        <span className="font-mono break-all">{f.path}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">{bytes(f.sizeBytes)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground md:col-span-2">
                Volumes and folders are listed for review only; nothing here deletes them.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ServerCard({
  server,
  onRemove,
}: {
  server: CapacityServer
  onRemove: (c: OrphanContainer) => void
}) {
  const s = server
  return (
    <section aria-labelledby={`cap-${s.id}`} className="space-y-4 rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h4 id={`cap-${s.id}`} className="font-semibold">{s.name}</h4>
        <span className="text-xs text-muted-foreground">{s.ip}</span>
        {s.demo && <Badge variant="outline" className="text-[10px]">simulated</Badge>}
        {s.error && (
          <Badge variant="outline" className="border-red-500/50 text-[10px] text-red-600 dark:text-red-400">
            not measured
          </Badge>
        )}
      </div>

      {s.demo ? (
        <p className="text-sm text-muted-foreground">
          Simulated server: there is no real host to measure.
        </p>
      ) : s.error ? (
        <p role="alert" className="rounded-md border border-red-500/40 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-400">
          Could not measure this server: {s.error}
        </p>
      ) : (
        <>
          {s.warnings.length > 0 && (
            <ul role="alert" className="space-y-1.5">
              {s.warnings.map((w) => (
                <li
                  key={w.kind}
                  className={`flex items-center gap-1.5 rounded-md border p-2 text-sm font-medium ${TONE[w.level].box} ${TONE[w.level].text}`}
                >
                  <AlertTriangle className="size-4 shrink-0" aria-hidden />
                  {w.message}
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Gauge
              icon={MemoryStick}
              label="RAM"
              value={s.ram ? `${s.ram.availablePct}% free` : '—'}
              sub={s.ram ? `${mb(s.ram.usedMB)} used · ${mb(s.ram.availableMB)} available of ${mb(s.ram.totalMB)}` : undefined}
              percent={s.ram ? 100 - s.ram.availablePct : null}
              level={levelOf(s, 'ram')}
            />
            <Gauge
              icon={HardDrive}
              label="Disk"
              value={s.disk ? `${s.disk.usedPct}% used` : '—'}
              sub={s.disk ? `${bytes(s.disk.usedBytes)} of ${bytes(s.disk.totalBytes)} · ${bytes(s.disk.availableBytes)} free` : undefined}
              percent={s.disk?.usedPct ?? null}
              level={levelOf(s, 'disk')}
            />
            <Gauge icon={Cpu} label="CPU" value={s.cpuCount == null ? '—' : String(s.cpuCount)} sub="cores" />
            <Gauge
              icon={Boxes}
              label="Containers"
              value={s.runningContainers == null ? '—' : String(s.runningContainers)}
              sub="running"
            />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Customer sites ({s.sites.length})</p>
            <SitesTable server={s} />
          </div>
          <OrphansSection server={s} onRemove={onRemove} />
        </>
      )}
    </section>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────

export function CapacityPanel() {
  const [data, setData] = useState<CapacityResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<OrphanContainer | null>(null)
  const [removing, setRemoving] = useState(false)

  const load = useCallback(async (refresh = false) => {
    setLoading(true)
    setError(null)
    try {
      setData(await apiFetch<CapacityResponse>(`/admin/capacity${refresh ? '?refresh=1' : ''}`))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load capacity')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const remove = async () => {
    if (!target) return
    setRemoving(true)
    try {
      const r = await apiFetch<{ volumesRemoved: string[]; volumesKept: string[] }>(
        '/admin/infrastructure/orphans/remove',
        { method: 'POST', body: JSON.stringify({ serverId: target.serverId, name: target.name }) }
      )
      const kept = r.volumesKept.length ? `; ${r.volumesKept.length} volume(s) still in use were kept` : ''
      toast.success(`Removed ${target.name} and ${r.volumesRemoved.length} volume(s)${kept}`)
      setTarget(null)
      await load(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the container')
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-lg font-semibold">Capacity</h3>
          <p className="text-sm text-muted-foreground">
            What each server has left, what each site uses, and what no site owns.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data && (
            <span className="text-[11px] text-muted-foreground" aria-live="polite">
              measured {new Date(data.generatedAt).toLocaleTimeString()}
              {data.cached ? ' (cached)' : ''}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => load(true)}
            disabled={loading}
            aria-label="Measure again"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
          <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          <Button variant="outline" size="sm" onClick={() => load(true)} disabled={loading}>
            Try again
          </Button>
        </div>
      )}

      {!data && loading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Measuring servers">
          <Skeleton className="h-6 w-48" />
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          <Skeleton className="h-40" />
        </div>
      ) : data && data.servers.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">No servers registered.</p>
      ) : data ? (
        <div className="space-y-4">
          {data.servers.map((s) => (
            <ServerCard key={s.id} server={s} onRemove={setTarget} />
          ))}
          <p className="text-[11px] text-muted-foreground">
            Amber below {data.thresholds.ramAvailableWarnPct}% RAM available or above{' '}
            {data.thresholds.diskUsedWarnPct}% disk used; red below {data.thresholds.ramAvailableRedPct}% / above{' '}
            {data.thresholds.diskUsedRedPct}%.
          </p>
        </div>
      ) : null}

      <AlertDialog open={!!target} onOpenChange={(o) => !o && !removing && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {target?.name}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  The container is force-removed{target?.volumes.length ? ', together with its volumes' : ''}.
                  Any data only in {target?.volumes.length ? 'those volumes' : 'the container'} is lost and cannot be recovered.
                </p>
                {target?.volumes.length ? (
                  <p className="font-mono text-xs break-all">{target.volumes.join(', ')}</p>
                ) : null}
                <p>
                  The server checks again that no site or database refers to it, and refuses if one does.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={removing}
              onClick={(e) => {
                e.preventDefault()
                void remove()
              }}
            >
              {removing && <Loader2 className="size-4 me-1.5 animate-spin" aria-hidden />}
              Remove container
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
