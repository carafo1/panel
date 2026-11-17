'use client'

/**
 * Admin → Usage. Every paying customer's measured consumption against their
 * plan, with over-limit customers first (GET /api/admin/usage), and a button
 * to measure everyone now (POST { action: "collect" }).
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Gauge, Loader2, RefreshCw, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Check {
  key: string
  label: string
  used: number
  limit: number | null
  percent: number | null
  over: boolean
}
interface Row {
  userId: string
  user: { name: string; email: string }
  planName: string | null
  overCount: number
  checks: Check[]
  capturedAt: string | null
}

export function UsageAdminPanel() {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [collecting, setCollecting] = useState(false)
  const [onlyOver, setOnlyOver] = useState(false)

  const load = useCallback(() => {
    setError(null)
    apiFetch<{ customers: Row[] }>('/admin/usage')
      .then((d) => setRows(d.customers || []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load usage'))
  }, [])
  useEffect(load, [load])

  const collect = async () => {
    setCollecting(true)
    try {
      const r = await apiFetch<{ message?: string }>('/admin/usage', { method: 'POST', body: JSON.stringify({ action: 'collect' }) })
      toast.success(r.message || 'Usage measured')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not measure usage')
    } finally {
      setCollecting(false)
    }
  }

  const shown = useMemo(() => {
    const list = [...(rows || [])].sort((a, b) => b.overCount - a.overCount)
    return onlyOver ? list.filter((r) => r.overCount > 0) : list
  }, [rows, onlyOver])
  const overTotal = (rows || []).filter((r) => r.overCount > 0).length

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="size-5 text-indigo-500" /> Usage
            </CardTitle>
            <CardDescription className="mt-1.5">
              Measured consumption of customers with a plan. {rows ? `${overTotal} over a limit.` : ''}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant={onlyOver ? 'default' : 'outline'} className={onlyOver ? 'bg-indigo-600 text-white hover:bg-indigo-700' : ''} onClick={() => setOnlyOver((v) => !v)}>
              Over limit only
            </Button>
            <Button size="sm" onClick={collect} disabled={collecting}>
              {collecting ? <Loader2 className="mr-2 size-4 animate-spin" /> : <RefreshCw className="mr-2 size-4" />}
              Measure everyone now
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0" aria-live="polite">
        {error ? (
          <div className="m-4 flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4" /> {error}
            </span>
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        ) : !rows ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading usage…
          </div>
        ) : shown.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {onlyOver ? 'Nobody is over a limit.' : 'No customers with an active plan yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Over limit</TableHead>
                  <TableHead>Measured</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => {
                  const over = r.checks.filter((c) => c.over)
                  return (
                    <TableRow key={r.userId}>
                      <TableCell>
                        <div className="font-medium">{r.user?.name}</div>
                        <div className="text-xs text-muted-foreground">{r.user?.email}</div>
                      </TableCell>
                      <TableCell>{r.planName || '—'}</TableCell>
                      <TableCell>
                        {over.length === 0 ? (
                          <span className="text-xs text-muted-foreground">Within limits</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {over.map((c) => (
                              <Badge key={c.key} variant="destructive" className="text-[11px]">
                                {c.label}: {c.used}/{c.limit}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {r.capturedAt ? new Date(r.capturedAt).toLocaleString() : 'Never'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
