'use client'

/** Admin → Status: post incidents and maintenance to the public /status page. */
import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ExternalLink, Loader2, Plus, Trash2, Megaphone } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const COMPONENTS: Array<[string, string]> = [
  ['panel', 'Control panel & API'],
  ['hosting', 'Website hosting'],
  ['deployments', 'Deployments & automation'],
  ['monitoring', 'Uptime monitoring'],
  ['email', 'Email hosting'],
  ['domains', 'Domains & DNS'],
  ['billing', 'Billing & payments'],
]
const INCIDENT_STATUSES = ['investigating', 'identified', 'monitoring', 'resolved']
const MAINTENANCE_STATUSES = ['scheduled', 'in_progress', 'completed']
const IMPACT_STYLE: Record<string, string> = {
  minor: 'border-amber-400 text-amber-700 dark:text-amber-400',
  major: 'border-orange-400 text-orange-700 dark:text-orange-400',
  critical: 'border-red-400 text-red-700 dark:text-red-400',
  maintenance: 'border-sky-400 text-sky-700 dark:text-sky-400',
}
const word = (s: string) => s.replace('_', ' ')

interface Incident {
  id: string
  title: string
  impact: string
  status: string
  components: string[]
  startedAt: string
  resolvedAt: string | null
  updates: Array<{ id: string; status: string; message: string; createdAt: string }>
}

export function IncidentsAdminPanel() {
  const [incidents, setIncidents] = useState<Incident[] | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    try {
      setIncidents((await apiFetch<{ incidents: Incident[] }>('/admin/incidents')).incidents)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load incidents')
      setIncidents([])
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="text-base">Status page</CardTitle>
            <CardDescription>
              Incidents and maintenance you post here appear on the public status page and as a banner in customers’ dashboards.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" asChild>
              <a href="/status" target="_blank" rel="noreferrer">
                <ExternalLink className="me-1.5 size-3.5" /> View page
              </a>
            </Button>
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              <Plus className="me-1.5 size-3.5" /> New incident
            </Button>
          </div>
        </CardHeader>
        {creating && (
          <CardContent>
            <NewIncidentForm
              onDone={() => {
                setCreating(false)
                void load()
              }}
            />
          </CardContent>
        )}
      </Card>

      {incidents === null ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      ) : incidents.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <Megaphone className="size-8 opacity-50" />
            No incidents posted. The status page shows automatic checks only.
          </CardContent>
        </Card>
      ) : (
        incidents.map((i) => <IncidentRow key={i.id} incident={i} onChanged={load} />)
      )}
    </div>
  )
}

function NewIncidentForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState('')
  const [impact, setImpact] = useState('minor')
  const [message, setMessage] = useState('')
  const [components, setComponents] = useState<string[]>([])
  const [startsAt, setStartsAt] = useState('')
  const [busy, setBusy] = useState(false)
  const maintenance = impact === 'maintenance'

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await apiFetch('/admin/incidents', {
        method: 'POST',
        body: JSON.stringify({
          title,
          impact,
          message,
          components,
          startsAt: maintenance && startsAt ? new Date(startsAt).toISOString() : undefined,
        }),
      })
      toast.success('Posted to the status page')
      onDone()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not post')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 border-t pt-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_200px]">
        <div className="space-y-1.5">
          <Label htmlFor="inc-title">Title</Label>
          <Input id="inc-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Slow deployments in eu-central" maxLength={160} required />
        </div>
        <div className="space-y-1.5">
          <Label>Impact</Label>
          <Select value={impact} onValueChange={setImpact}>
            <SelectTrigger aria-label="Impact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minor">Minor — degraded</SelectItem>
              <SelectItem value="major">Major — partial outage</SelectItem>
              <SelectItem value="critical">Critical — major outage</SelectItem>
              <SelectItem value="maintenance">Scheduled maintenance</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {maintenance && (
        <div className="space-y-1.5 sm:max-w-xs">
          <Label htmlFor="inc-start">Starts at (your local time)</Label>
          <Input id="inc-start" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
        </div>
      )}
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Affected services</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {COMPONENTS.map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={components.includes(k)}
                onCheckedChange={(c) => setComponents((cur) => (c ? [...cur, k] : cur.filter((x) => x !== k)))}
              />
              {l}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="space-y-1.5">
        <Label htmlFor="inc-msg">First update (public)</Label>
        <Textarea id="inc-msg" rows={3} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} required />
      </div>
      <div className="flex justify-end">
        <Button type="submit" disabled={busy || !title.trim() || !message.trim() || components.length === 0}>
          {busy && <Loader2 className="me-1.5 size-4 animate-spin" />} Publish
        </Button>
      </div>
    </form>
  )
}

function IncidentRow({ incident: i, onChanged }: { incident: Incident; onChanged: () => void }) {
  const statuses = i.impact === 'maintenance' ? MAINTENANCE_STATUSES : INCIDENT_STATUSES
  const [status, setStatus] = useState(i.status)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const post = async () => {
    setBusy(true)
    try {
      await apiFetch(`/admin/incidents/${i.id}`, { method: 'POST', body: JSON.stringify({ status, message }) })
      setMessage('')
      toast.success('Update posted')
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not post the update')
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete “${i.title}” from the status page? This cannot be undone.`)) return
    try {
      await apiFetch(`/admin/incidents/${i.id}`, { method: 'DELETE' })
      toast.success('Incident deleted')
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete')
    }
  }

  return (
    <Card className={i.resolvedAt ? 'opacity-80' : ''}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={IMPACT_STYLE[i.impact]}>
            {i.impact}
          </Badge>
          <Badge variant={i.resolvedAt ? 'secondary' : 'default'}>{word(i.status)}</Badge>
          <span className="text-xs text-muted-foreground">
            {i.resolvedAt ? `resolved ${formatDistanceToNow(new Date(i.resolvedAt), { addSuffix: true })}` : `started ${formatDistanceToNow(new Date(i.startedAt), { addSuffix: true })}`}
          </span>
          <Button variant="ghost" size="icon" className="ms-auto size-8" onClick={remove} aria-label="Delete incident">
            <Trash2 className="size-4" />
          </Button>
        </div>
        <CardTitle className="text-sm">{i.title}</CardTitle>
        <CardDescription className="text-xs">{i.components.map((k) => COMPONENTS.find(([c]) => c === k)?.[1] ?? k).join(', ')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="space-y-1.5 text-sm">
          {i.updates.map((u) => (
            <li key={u.id}>
              <span className="font-medium capitalize">{word(u.status)}</span>
              <span className="text-muted-foreground"> — {u.message}</span>
              <span className="ms-1 text-xs text-muted-foreground">({formatDistanceToNow(new Date(u.createdAt), { addSuffix: true })})</span>
            </li>
          ))}
        </ol>
        {!i.resolvedAt && (
          <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row">
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger className="sm:w-44" aria-label="New status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {statuses.map((s) => (
                  <SelectItem key={s} value={s} className="capitalize">
                    {word(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed?" maxLength={5000} aria-label="Update message" />
            <Button onClick={post} disabled={busy || !message.trim()}>
              {busy && <Loader2 className="me-1.5 size-4 animate-spin" />} Post update
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
