'use client'

/**
 * Website → App tools. The stack's routine maintenance commands as buttons
 * (Laravel artisan, Django manage.py, package lists, the app log), with the
 * output shown underneath. Backed by /api/hosting/[id]/app-tools.
 */
import { useCallback, useEffect, useState } from 'react'
import { Loader2, Play, FileText, AlertTriangle, TerminalSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface Tool {
  id: string
  label: string
  description: string
  permission: string
  confirm?: string
}
interface ToolList {
  stack: string
  demo: boolean
  hasLog: boolean
  tools: Tool[]
}

const STACK_NAMES: Record<string, string> = {
  laravel: 'Laravel',
  django: 'Django',
  python: 'Python',
  nodejs: 'Node.js',
  php: 'PHP',
}

export function AppToolsTab({ projectId }: { projectId: string }) {
  const url = `/api/hosting/${projectId}/app-tools`
  const [list, setList] = useState<ToolList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ label: string; output: string; exitCode: number } | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch(url, { credentials: 'same-origin' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Could not load app tools')
      setList(data as ToolList)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load app tools')
    }
  }, [url])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (tool: { id: string; label: string; confirm?: string }) => {
    if (tool.confirm && !window.confirm(tool.confirm)) return
    setBusy(tool.id)
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: tool.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Command failed')
      setResult({ label: data.label, output: data.output || '(no output)', exitCode: data.exitCode })
      if (data.exitCode === 0) toast.success(`${data.label} finished`)
      else toast.error(`${data.label} failed (exit code ${data.exitCode})`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Command failed')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TerminalSquare className="size-5 text-indigo-500" /> App tools
          {list && <Badge variant="outline">{STACK_NAMES[list.stack] || list.stack}</Badge>}
          {list?.demo && <Badge variant="outline">Demo server</Badge>}
        </CardTitle>
        <CardDescription>Routine maintenance commands for this app, run inside its container.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4" /> {error}
            </span>
            <Button size="sm" variant="outline" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        ) : !list ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <ul className="grid gap-2 md:grid-cols-2">
              {list.tools.map((t) => (
                <li key={t.id} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{t.label}</p>
                    <p className="text-xs text-muted-foreground">{t.description}</p>
                  </div>
                  <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run(t)} aria-label={`Run: ${t.label}`}>
                    {busy === t.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                  </Button>
                </li>
              ))}
            </ul>
            {list.hasLog && (
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => run({ id: '__log', label: 'Application log' })}>
                {busy === '__log' ? <Loader2 className="me-1.5 size-3.5 animate-spin" /> : <FileText className="me-1.5 size-3.5" />}
                Show application log
              </Button>
            )}
            {result && (
              <div className="space-y-1.5" aria-live="polite">
                <p className="text-xs font-medium text-muted-foreground">
                  {result.label} — exit code {result.exitCode}
                </p>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-950 p-3 font-mono text-xs text-zinc-100">
                  {result.output}
                </pre>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
