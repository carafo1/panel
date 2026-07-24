'use client'

/**
 * Database Studio — the phpMyAdmin-replacement workspace.
 * Explorer sidebar + dashboard stats + Browse (editable data grid) /
 * Structure / SQL. All data comes from the tenant-scoped Studio API (./api.ts).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  Database,
  Table2,
  Eye,
  RefreshCw,
  Play,
  KeyRound,
  Loader2,
  Search,
  Boxes,
  HardDrive,
  Rows3,
  Terminal,
  Layers,
  Zap,
  AlertCircle,
  Trash2,
  Plus,
  Download,
  Upload,
  Check,
  X,
  ChevronDown,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  studioApi,
  exportDatabase,
  importDatabase,
  type DbStats,
  type TableRowsResult,
  type TableStructure,
} from './api'
import type { SchemaTree, QueryResult, ColumnInfo } from '@/lib/db-engine/types'

// ─── formatting helpers ────────────────────────────────────────────────────

function formatBytes(n: number | null | undefined): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`
}

function formatNumber(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString()
}

function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function downloadCsv(filename: string, columns: string[], rows: Array<Record<string, unknown>>) {
  const head = columns.map(csvEscape).join(',')
  const body = rows.map((r) => columns.map((c) => csvEscape(r[c])).join(',')).join('\n')
  const blob = new Blob([head + '\n' + body], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function CellView({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-muted-foreground/50 italic text-xs">NULL</span>
  const s = String(value)
  const truncated = s.length > 140 ? s.slice(0, 140) + '…' : s
  return (
    <span
      className="whitespace-pre-wrap break-words font-mono text-[13px]"
      title={s.length > 140 ? s : undefined}
    >
      {truncated}
    </span>
  )
}

// ─── stat card ─────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  loading,
}: {
  icon: typeof Boxes
  label: string
  value: string
  loading: boolean
}) {
  return (
    <div className="rounded-xl border bg-card/60 backdrop-blur px-4 py-3 flex items-center gap-3 shadow-sm">
      <div className="rounded-lg bg-primary/10 text-primary p-2">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        {loading ? (
          <Skeleton className="h-5 w-16 mt-0.5" />
        ) : (
          <div className="text-lg font-semibold leading-tight tabular-nums">{value}</div>
        )}
      </div>
    </div>
  )
}

// ─── main component ────────────────────────────────────────────────────────

export function DatabaseStudio({
  projectId,
  dbId,
}: {
  projectId: string
  dbId: string
}) {
  const [schema, setSchema] = useState<SchemaTree | null>(null)
  const [stats, setStats] = useState<DbStats | null>(null)
  const [loadingSchema, setLoadingSchema] = useState(true)
  const [fatal, setFatal] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [filter, setFilter] = useState('')

  const loadSchema = useCallback(async () => {
    setLoadingSchema(true)
    setFatal(null)
    try {
      const [s, st] = await Promise.all([
        studioApi.schema(projectId, dbId),
        studioApi.stats(projectId, dbId).catch(() => null),
      ])
      setSchema(s)
      if (st) setStats(st)
      setSelected((cur) => cur ?? s.tables[0]?.name ?? s.views[0]?.name ?? null)
    } catch (e) {
      setFatal(e instanceof Error ? e.message : 'Failed to load database')
    } finally {
      setLoadingSchema(false)
    }
  }, [projectId, dbId])

  const doExport = useCallback(
    async (mode: 'full' | 'structure' | 'data') => {
      const id = toast.loading('Exporting database…')
      try {
        await exportDatabase(projectId, dbId, mode)
        toast.success('Export downloaded', { id })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Export failed', { id })
      }
    },
    [projectId, dbId]
  )

  useEffect(() => {
    loadSchema()
  }, [loadSchema])

  const filteredTables = useMemo(
    () => (schema?.tables ?? []).filter((t) => t.name.toLowerCase().includes(filter.toLowerCase())),
    [schema, filter]
  )
  const filteredViews = useMemo(
    () => (schema?.views ?? []).filter((v) => v.name.toLowerCase().includes(filter.toLowerCase())),
    [schema, filter]
  )
  const isView = useMemo(
    () => !!schema?.views.some((v) => v.name === selected),
    [schema, selected]
  )

  if (fatal) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-md text-center space-y-3">
          <AlertCircle className="mx-auto h-10 w-10 text-destructive" />
          <h3 className="text-lg font-semibold">Couldn&apos;t open this database</h3>
          <p className="text-sm text-muted-foreground">{fatal}</p>
          <Button variant="outline" onClick={loadSchema}>
            <RefreshCw className="mr-2 h-4 w-4" /> Retry
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header + stats */}
      <div className="border-b bg-gradient-to-b from-muted/40 to-transparent px-5 py-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="rounded-lg bg-primary/10 text-primary p-2">
            <Database className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">
                {schema?.database ?? 'Database'}
              </h1>
              <Badge variant="secondary" className="uppercase text-[10px]">
                {schema?.engine ?? '—'}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">Database Studio</p>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ImportDialog projectId={projectId} dbId={dbId} onDone={loadSchema} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Download className="mr-2 h-4 w-4" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Export as .sql</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => doExport('full')}>
                  Full (structure + data)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => doExport('structure')}>
                  Structure only
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => doExport('data')}>Data only</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" size="sm" onClick={loadSchema} disabled={loadingSchema}>
              <RefreshCw className={cn('mr-2 h-4 w-4', loadingSchema && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard icon={Table2} label="Tables" value={formatNumber(stats?.tableCount)} loading={!stats} />
          <StatCard icon={Eye} label="Views" value={formatNumber(stats?.viewCount)} loading={!stats} />
          <StatCard icon={Rows3} label="Total rows" value={formatNumber(stats?.totalRows)} loading={!stats} />
          <StatCard icon={HardDrive} label="Size" value={formatBytes(stats?.sizeBytes)} loading={!stats} />
        </div>
      </div>

      {/* Body: explorer + main */}
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-r flex flex-col">
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter objects…"
                className="pl-7 h-8 text-sm"
              />
            </div>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-2 space-y-4">
              <ExplorerGroup
                icon={Table2}
                title="Tables"
                count={filteredTables.length}
                loading={loadingSchema}
                items={filteredTables.map((t) => ({ name: t.name, sub: `${formatNumber(t.rows)} rows` }))}
                selected={selected}
                onSelect={setSelected}
              />
              <ExplorerGroup
                icon={Eye}
                title="Views"
                count={filteredViews.length}
                loading={loadingSchema}
                items={filteredViews.map((v) => ({ name: v.name, sub: 'view' }))}
                selected={selected}
                onSelect={setSelected}
              />
              <ExplorerGroup
                icon={Layers}
                title="Routines"
                count={schema?.routines.length ?? 0}
                loading={loadingSchema}
                items={(schema?.routines ?? []).map((r) => ({ name: r.name, sub: r.kind.toLowerCase() }))}
                selectable={false}
              />
              <ExplorerGroup
                icon={Zap}
                title="Triggers"
                count={schema?.triggers.length ?? 0}
                loading={loadingSchema}
                items={(schema?.triggers ?? []).map((t) => ({ name: t.name, sub: `${t.timing} ${t.event}` }))}
                selectable={false}
              />
            </div>
          </ScrollArea>
        </aside>

        <main className="min-w-0 flex-1 flex flex-col">
          <Tabs defaultValue="browse" className="flex flex-col flex-1 min-h-0">
            <div className="border-b px-3 pt-2">
              <TabsList>
                <TabsTrigger value="browse">
                  <Rows3 className="mr-1.5 h-3.5 w-3.5" /> Browse
                </TabsTrigger>
                <TabsTrigger value="structure">
                  <Table2 className="mr-1.5 h-3.5 w-3.5" /> Structure
                </TabsTrigger>
                <TabsTrigger value="sql">
                  <Terminal className="mr-1.5 h-3.5 w-3.5" /> SQL
                </TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="browse" className="flex-1 min-h-0 m-0">
              <BrowseTab
                projectId={projectId}
                dbId={dbId}
                table={selected}
                isView={isView}
                onSchemaChanged={() => {
                  setSelected(null)
                  loadSchema()
                }}
              />
            </TabsContent>
            <TabsContent value="structure" className="flex-1 min-h-0 m-0">
              <StructureTab projectId={projectId} dbId={dbId} table={selected} />
            </TabsContent>
            <TabsContent value="sql" className="flex-1 min-h-0 m-0">
              <SqlTab projectId={projectId} dbId={dbId} />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  )
}

// ─── explorer group ────────────────────────────────────────────────────────

function ExplorerGroup({
  icon: Icon,
  title,
  count,
  items,
  loading,
  selected,
  onSelect,
  selectable = true,
}: {
  icon: typeof Table2
  title: string
  count: number
  items: Array<{ name: string; sub?: string }>
  loading?: boolean
  selected?: string | null
  onSelect?: (name: string) => void
  selectable?: boolean
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 px-1 mb-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        <Icon className="h-3.5 w-3.5" />
        {title}
        <Badge variant="outline" className="ml-auto h-4 px-1 text-[10px] font-normal">
          {count}
        </Badge>
      </div>
      {loading ? (
        <div className="space-y-1 px-1">
          <Skeleton className="h-7 w-full" />
          <Skeleton className="h-7 w-4/5" />
        </div>
      ) : items.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground/60">none</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((it) => (
            <li key={it.name}>
              <button
                type="button"
                disabled={!selectable}
                onClick={() => selectable && onSelect?.(it.name)}
                className={cn(
                  'w-full text-left rounded-md px-2 py-1.5 text-sm flex items-center gap-2 transition-colors',
                  selectable && 'hover:bg-accent',
                  selected === it.name && selectable && 'bg-accent text-accent-foreground font-medium'
                )}
              >
                <span className="truncate font-mono text-[13px]">{it.name}</span>
                {it.sub && (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{it.sub}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Browse tab (editable data grid) ───────────────────────────────────────

function BrowseTab({
  projectId,
  dbId,
  table,
  isView,
  onSchemaChanged,
}: {
  projectId: string
  dbId: string
  table: string | null
  isView: boolean
  onSchemaChanged: () => void
}) {
  const [data, setData] = useState<TableRowsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(0)
  const [orderBy, setOrderBy] = useState<string | undefined>()
  const [orderDir, setOrderDir] = useState<'ASC' | 'DESC'>('ASC')
  const [editing, setEditing] = useState<{ rowIdx: number; col: string } | null>(null)
  const [editVal, setEditVal] = useState('')
  const [busy, setBusy] = useState(false)
  const limit = 50

  const pkCols = useMemo(
    () => (data?.columns ?? []).filter((c) => c.key === 'PRI').map((c) => c.name),
    [data]
  )
  const editable = !isView && pkCols.length > 0

  const reload = useCallback(() => {
    if (!table) return
    setLoading(true)
    studioApi
      .rows(projectId, dbId, table, { limit, offset: page * limit, orderBy, orderDir })
      .then(setData)
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Failed to load rows'))
      .finally(() => setLoading(false))
  }, [projectId, dbId, table, page, orderBy, orderDir])

  useEffect(() => {
    setPage(0)
    setOrderBy(undefined)
    setEditing(null)
  }, [table])

  useEffect(() => {
    reload()
  }, [reload])

  const sort = (col: string) => {
    setEditing(null)
    if (orderBy === col) setOrderDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'))
    else {
      setOrderBy(col)
      setOrderDir('ASC')
    }
    setPage(0)
  }

  const keyOf = (row: Record<string, unknown>) =>
    Object.fromEntries(pkCols.map((c) => [c, row[c]]))

  const saveEdit = async () => {
    if (!editing || !table || !data) return
    const row = data.rows[editing.rowIdx]
    if (String(row[editing.col] ?? '') === editVal) {
      setEditing(null)
      return
    }
    setBusy(true)
    try {
      await studioApi.updateRow(projectId, dbId, table, keyOf(row), { [editing.col]: editVal })
      setData((d) => {
        if (!d) return d
        const rows = d.rows.slice()
        rows[editing.rowIdx] = { ...rows[editing.rowIdx], [editing.col]: editVal }
        return { ...d, rows }
      })
      toast.success('Row updated')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Update failed')
    } finally {
      setBusy(false)
      setEditing(null)
    }
  }

  const remove = async (row: Record<string, unknown>) => {
    if (!table) return
    setBusy(true)
    try {
      await studioApi.deleteRow(projectId, dbId, table, keyOf(row))
      toast.success('Row deleted')
      reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed')
    } finally {
      setBusy(false)
    }
  }

  if (!table)
    return <EmptyState icon={Rows3} title="Select a table" hint="Pick a table from the Explorer to browse its rows." />

  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="font-mono font-medium">{table}</span>
        {isView && <Badge variant="outline">view</Badge>}
        {data && <span className="text-muted-foreground">· {formatNumber(data.total)} rows</span>}
        {!editable && !isView && (
          <span className="text-[10px] text-muted-foreground">(no PK — read only)</span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {!isView && (
            <TableActions
              projectId={projectId}
              dbId={dbId}
              table={table}
              onReload={reload}
              onSchemaChanged={onSchemaChanged}
            />
          )}
          {editable && data && (
            <InsertRowDialog
              columns={data.columns}
              onInsert={async (values) => {
                await studioApi.insertRow(projectId, dbId, table, values)
                toast.success('Row inserted')
                reload()
              }}
            />
          )}
          {data && data.rows.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadCsv(`${table}.csv`, data.columns.map((c) => c.name), data.rows)}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
            Prev
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums px-1">
            {page + 1} / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page + 1 >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      </div>
      <ScrollArea className="flex-1">
        {loading && !data ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : data && data.rows.length > 0 ? (
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                {data.columns.map((c) => (
                  <TableHead
                    key={c.name}
                    onClick={() => sort(c.name)}
                    className="cursor-pointer select-none whitespace-nowrap hover:text-foreground"
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.key === 'PRI' && <KeyRound className="h-3 w-3 text-amber-500" />}
                      <span className="font-mono text-xs">{c.name}</span>
                      {orderBy === c.name && <span className="text-[10px]">{orderDir === 'ASC' ? '▲' : '▼'}</span>}
                      <span className="text-[10px] text-muted-foreground font-normal">{c.dataType}</span>
                    </span>
                  </TableHead>
                ))}
                {editable && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.rows.map((row, i) => (
                <TableRow key={i}>
                  {data.columns.map((c) => {
                    const isEditing = editing?.rowIdx === i && editing.col === c.name
                    return (
                      <TableCell
                        key={c.name}
                        className="align-top max-w-sm"
                        onClick={() => {
                          if (editable && !isEditing) {
                            setEditing({ rowIdx: i, col: c.name })
                            setEditVal(row[c.name] === null || row[c.name] === undefined ? '' : String(row[c.name]))
                          }
                        }}
                      >
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <Input
                              autoFocus
                              value={editVal}
                              disabled={busy}
                              onChange={(e) => setEditVal(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEdit()
                                if (e.key === 'Escape') setEditing(null)
                              }}
                              className="h-7 font-mono text-[13px]"
                            />
                            <button className="text-emerald-500" onClick={saveEdit} disabled={busy}>
                              <Check className="h-4 w-4" />
                            </button>
                            <button className="text-muted-foreground" onClick={() => setEditing(null)}>
                              <X className="h-4 w-4" />
                            </button>
                          </div>
                        ) : (
                          <div className={cn(editable && 'cursor-text rounded px-1 -mx-1 hover:bg-accent/50')}>
                            <CellView value={row[c.name]} />
                          </div>
                        )}
                      </TableCell>
                    )
                  })}
                  {editable && (
                    <TableCell className="w-10 align-top">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <button className="text-muted-foreground hover:text-destructive" title="Delete row">
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Delete this row?</AlertDialogTitle>
                            <AlertDialogDescription>
                              This permanently deletes the row where{' '}
                              <span className="font-mono">
                                {pkCols.map((c) => `${c}=${String(row[c])}`).join(', ')}
                              </span>
                              . This cannot be undone.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Cancel</AlertDialogCancel>
                            <AlertDialogAction
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => remove(row)}
                            >
                              Delete
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <EmptyState icon={Rows3} title="No rows" hint="This table is empty." />
        )}
      </ScrollArea>
    </div>
  )
}

// ─── Insert row dialog ─────────────────────────────────────────────────────

function InsertRowDialog({
  columns,
  onInsert,
}: {
  columns: ColumnInfo[]
  onInsert: (values: Record<string, unknown>) => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [vals, setVals] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    setSaving(true)
    try {
      // Only send columns the user actually filled in; skip empty so DB
      // defaults / auto_increment apply.
      const values: Record<string, unknown> = {}
      for (const c of columns) {
        const v = vals[c.name]
        if (v !== undefined && v !== '') values[c.name] = v
      }
      await onInsert(values)
      setOpen(false)
      setVals({})
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Insert failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Insert row
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Insert row</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {columns.map((c) => {
            const auto = c.extra?.includes('auto_increment')
            return (
              <div key={c.name} className="grid grid-cols-3 items-center gap-2">
                <Label className="text-right text-xs font-mono">
                  {c.name}
                  {c.key === 'PRI' && <KeyRound className="inline ml-1 h-3 w-3 text-amber-500" />}
                </Label>
                <Input
                  className="col-span-2 h-8 font-mono text-[13px]"
                  placeholder={auto ? 'auto' : c.nullable ? `${c.dataType} · NULL` : c.dataType}
                  value={vals[c.name] ?? ''}
                  onChange={(e) => setVals((s) => ({ ...s, [c.name]: e.target.value }))}
                />
              </div>
            )
          })}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
            Insert
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Import dialog ─────────────────────────────────────────────────────────

function ImportDialog({
  projectId,
  dbId,
  onDone,
}: {
  projectId: string
  dbId: string
  onDone: () => void
}) {
  const [open, setOpen] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (!file) return
    setBusy(true)
    const tid = toast.loading(`Importing ${file.name}…`)
    try {
      const r = await importDatabase(projectId, dbId, file)
      toast.success(`Imported in ${r.durationMs} ms`, { id: tid })
      setOpen(false)
      setFile(null)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed', { id: tid })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Upload className="mr-2 h-4 w-4" /> Import
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import SQL</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Upload a <code>.sql</code> or <code>.sql.gz</code> file. Statements run as your
            database user against this database.
          </p>
          <Input
            type="file"
            accept=".sql,.gz,.sql.gz,application/sql,application/gzip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <p className="text-xs text-muted-foreground">
              {file.name} · {(file.size / 1024).toFixed(1)} KB
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={run} disabled={!file || busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Table actions (DDL menu) ──────────────────────────────────────────────

function TableActions({
  projectId,
  dbId,
  table,
  onReload,
  onSchemaChanged,
}: {
  projectId: string
  dbId: string
  table: string | null
  onReload: () => void
  onSchemaChanged: () => void
}) {
  const [dialog, setDialog] = useState<null | 'rename' | 'truncate' | 'drop'>(null)
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)

  if (!table) return null

  const run = async (
    op: 'truncate' | 'drop' | 'rename' | 'optimize' | 'analyze',
    nn?: string
  ) => {
    setBusy(true)
    const tid = toast.loading(`${op}…`)
    try {
      await studioApi.tableOp(projectId, dbId, table, op, nn)
      toast.success(`${op} complete`, { id: tid })
      setDialog(null)
      if (op === 'drop' || op === 'rename') onSchemaChanged()
      else onReload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `${op} failed`, { id: tid })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <Wrench className="mr-1.5 h-3.5 w-3.5" /> Table
            <ChevronDown className="ml-1 h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="font-mono text-xs">{table}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => run('optimize')}>Optimize</DropdownMenuItem>
          <DropdownMenuItem onClick={() => run('analyze')}>Analyze</DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              setNewName(table)
              setDialog('rename')
            }}
          >
            Rename…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDialog('truncate')}
          >
            Empty (truncate)…
          </DropdownMenuItem>
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDialog('drop')}
          >
            Drop table…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog === 'rename'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename table</DialogTitle>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="font-mono"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => run('rename', newName)}
              disabled={busy || !newName || newName === table}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={dialog === 'truncate' || dialog === 'drop'}
        onOpenChange={(o) => !o && setDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {dialog === 'drop' ? `Drop table “${table}”?` : `Empty table “${table}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {dialog === 'drop'
                ? 'This permanently deletes the table and all its data. This cannot be undone.'
                : 'This permanently deletes every row (the table structure is kept). This cannot be undone.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => run(dialog === 'drop' ? 'drop' : 'truncate')}
            >
              {dialog === 'drop' ? 'Drop' : 'Empty'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ─── Structure tab ─────────────────────────────────────────────────────────

function StructureTab({ projectId, dbId, table }: { projectId: string; dbId: string; table: string | null }) {
  const [s, setS] = useState<TableStructure | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!table) return
    let cancelled = false
    setLoading(true)
    studioApi
      .structure(projectId, dbId, table)
      .then((r) => !cancelled && setS(r))
      .catch((e) => !cancelled && toast.error(e instanceof Error ? e.message : 'Failed to load structure'))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [projectId, dbId, table])

  if (!table) return <EmptyState icon={Table2} title="Select a table" hint="Structure appears here." />
  if (loading || !s)
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    )

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-6">
        <section>
          <h3 className="text-sm font-semibold mb-2">Columns</h3>
          <div className="rounded-lg border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Null</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Default</TableHead>
                  <TableHead>Extra</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.columns.map((c) => (
                  <TableRow key={c.name}>
                    <TableCell className="font-mono text-[13px] font-medium">{c.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{c.dataType}</TableCell>
                    <TableCell>{c.nullable ? 'YES' : 'NO'}</TableCell>
                    <TableCell>
                      {c.key === 'PRI' ? (
                        <Badge variant="secondary" className="gap-1">
                          <KeyRound className="h-3 w-3" /> PRIMARY
                        </Badge>
                      ) : c.key ? (
                        <Badge variant="outline">{c.key}</Badge>
                      ) : (
                        ''
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {c.default === null ? <span className="text-muted-foreground/50 italic">NULL</span> : c.default}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.extra}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold mb-2">Indexes</h3>
          {s.indexes.length === 0 ? (
            <p className="text-sm text-muted-foreground">No indexes.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {s.indexes.map((idx) => (
                <div key={idx.name} className="rounded-lg border px-3 py-2 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-medium">{idx.name}</span>
                    {idx.primary && <Badge variant="secondary">PRIMARY</Badge>}
                    {idx.unique && !idx.primary && <Badge variant="outline">UNIQUE</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5">
                    {idx.columns.join(', ')} · {idx.type}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h3 className="text-sm font-semibold mb-2">Foreign keys</h3>
          {s.foreignKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No foreign keys.</p>
          ) : (
            <div className="space-y-1.5">
              {s.foreignKeys.map((fk) => (
                <div key={fk.name} className="rounded-lg border px-3 py-2 text-sm font-mono">
                  {fk.column} → {fk.refTable}.{fk.refColumn}
                  <span className="text-xs text-muted-foreground ml-2 font-sans">
                    ON UPDATE {fk.onUpdate} · ON DELETE {fk.onDelete}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </ScrollArea>
  )
}

// ─── SQL tab ───────────────────────────────────────────────────────────────

function SqlTab({ projectId, dbId }: { projectId: string; dbId: string }) {
  const [sql, setSql] = useState('SELECT * FROM ')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async () => {
    if (!sql.trim()) return
    setRunning(true)
    setError(null)
    try {
      const r = await studioApi.query(projectId, dbId, sql)
      setResult(r)
      if (r.affectedRows != null && r.command !== 'SELECT') toast.success(r.note || 'Done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Query failed')
      setResult(null)
    } finally {
      setRunning(false)
    }
  }, [sql, projectId, dbId])

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3 space-y-2">
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              run()
            }
          }}
          spellCheck={false}
          rows={6}
          className="w-full resize-y rounded-lg border bg-muted/30 p-3 font-mono text-[13px] leading-relaxed outline-none focus:ring-2 focus:ring-ring"
          placeholder="Write SQL… (⌘/Ctrl + Enter to run)"
        />
        <div className="flex items-center gap-2">
          <Button onClick={run} disabled={running || !sql.trim()} size="sm">
            {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            Run
          </Button>
          <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
          {result && result.columns.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadCsv('query-result.csv', result.columns.map((c) => c.name), result.rows)}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" /> CSV
            </Button>
          )}
          {result && (
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {result.note} · {result.durationMs} ms
            </span>
          )}
        </div>
      </div>
      <ScrollArea className="flex-1">
        {error ? (
          <div className="m-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive font-mono">
            {error}
          </div>
        ) : result && result.columns.length > 0 ? (
          <Table>
            <TableHeader className="sticky top-0 bg-background z-10">
              <TableRow>
                {result.columns.map((c) => (
                  <TableHead key={c.name} className="font-mono text-xs whitespace-nowrap">
                    {c.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.rows.map((row, i) => (
                <TableRow key={i}>
                  {result.columns.map((c) => (
                    <TableCell key={c.name} className="align-top max-w-sm">
                      <CellView value={row[c.name]} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : result ? (
          <EmptyState icon={Terminal} title={result.note || 'Statement executed'} hint="No result set returned." />
        ) : (
          <EmptyState icon={Terminal} title="Run a query" hint="Results appear here." />
        )}
      </ScrollArea>
    </div>
  )
}

// ─── shared empty state ────────────────────────────────────────────────────

function EmptyState({ icon: Icon, title, hint }: { icon: typeof Rows3; title: string; hint: string }) {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-8 text-center">
      <div className="rounded-full bg-muted p-3">
        <Icon className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="font-medium">{title}</p>
      <p className="text-sm text-muted-foreground max-w-xs">{hint}</p>
    </div>
  )
}
