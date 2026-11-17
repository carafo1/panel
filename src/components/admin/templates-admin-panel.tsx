'use client'

/**
 * Admin → Templates. Review the one-click templates customers see in the
 * create-website wizard: approve or reject submissions, feature the best,
 * mark official ones, delete broken ones (GET/PATCH/DELETE /api/admin/templates).
 */
import { useCallback, useEffect, useState } from 'react'
import { LayoutTemplate, Loader2, Check, X, Star, StarOff, BadgeCheck, Trash2, ExternalLink, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

interface Template {
  id: string
  name: string
  description: string | null
  category: string | null
  framework: string | null
  author: string | null
  status: 'pending' | 'approved' | 'rejected' | 'featured' | string
  isOfficial: boolean
  version: string | null
  repoUrl: string | null
  demoUrl: string | null
  installCount: number
  avgRating: string | null
  ratingCount: number
  rejectedReason: string | null
  createdAt: string
  submittedBy: { name: string; email: string } | null
}

const FILTERS = ['pending', 'approved', 'featured', 'rejected', 'all'] as const
type Action = 'approve' | 'reject' | 'feature' | 'unfeature' | 'make_official'

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  approved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  featured: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  rejected: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
}

export function TemplatesAdminPanel() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('pending')
  const [items, setItems] = useState<Template[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    setItems(null)
    apiFetch<{ templates: Template[] }>(`/admin/templates?status=${filter}&limit=100`)
      .then((d) => setItems(d.templates || []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load templates'))
  }, [filter])
  useEffect(load, [load])

  const act = async (t: Template, action: Action) => {
    let reason: string | undefined
    if (action === 'reject') {
      const r = window.prompt(`Why is “${t.name}” being rejected? The submitter sees this.`, '')
      if (r === null) return
      reason = r.trim() || undefined
    }
    setBusy(t.id + action)
    try {
      await apiFetch(`/admin/templates/${t.id}`, { method: 'PATCH', body: JSON.stringify({ action, reason }) })
      toast.success(
        { approve: 'Approved', reject: 'Rejected', feature: 'Featured', unfeature: 'No longer featured', make_official: 'Marked official' }[action]
      )
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Action failed')
    } finally {
      setBusy(null)
    }
  }

  const remove = async (t: Template) => {
    if (!window.confirm(`Delete “${t.name}” from the marketplace? Existing websites are not affected.`)) return
    setBusy(t.id + 'delete')
    try {
      await apiFetch(`/admin/templates/${t.id}`, { method: 'DELETE' })
      toast.success('Template deleted')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete')
    } finally {
      setBusy(null)
    }
  }

  const ActionButton = ({ t, action, icon: Icon, label }: { t: Template; action: Action; icon: typeof Check; label: string }) => (
    <Button size="sm" variant="outline" onClick={() => act(t, action)} disabled={!!busy}>
      {busy === t.id + action ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Icon className="mr-1.5 size-3.5" />}
      {label}
    </Button>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LayoutTemplate className="size-5 text-indigo-500" /> Templates
        </CardTitle>
        <CardDescription>
          Templates customers can start a website from. Only approved and featured ones are shown to customers.
        </CardDescription>
        <div className="flex flex-wrap gap-2 pt-2" role="tablist" aria-label="Filter by status">
          {FILTERS.map((f) => (
            <Button
              key={f}
              size="sm"
              role="tab"
              aria-selected={filter === f}
              variant={filter === f ? 'default' : 'outline'}
              className={filter === f ? 'bg-indigo-600 text-white hover:bg-indigo-700' : ''}
              onClick={() => setFilter(f)}
            >
              {f[0].toUpperCase() + f.slice(1)}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent aria-live="polite">
        {error ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            <span className="flex items-center gap-2">
              <AlertTriangle className="size-4" /> {error}
            </span>
            <Button size="sm" variant="outline" onClick={load}>
              Retry
            </Button>
          </div>
        ) : !items ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading templates…
          </div>
        ) : items.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">
            {filter === 'pending' ? 'No templates waiting for review.' : `No ${filter === 'all' ? '' : filter + ' '}templates.`}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((t) => (
              <li key={t.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t.name}</span>
                    <Badge className={STATUS_STYLE[t.status] || ''} variant="secondary">
                      {t.status}
                    </Badge>
                    {t.isOfficial && (
                      <Badge variant="outline" className="gap-1">
                        <BadgeCheck className="size-3" /> Official
                      </Badge>
                    )}
                    {t.framework && <Badge variant="outline">{t.framework}</Badge>}
                  </div>
                  {t.description && <p className="text-sm text-muted-foreground line-clamp-2">{t.description}</p>}
                  <p className="text-xs text-muted-foreground">
                    {t.submittedBy ? `Submitted by ${t.submittedBy.email}` : t.author ? `By ${t.author}` : 'Built-in'} ·{' '}
                    {t.installCount} install{t.installCount === 1 ? '' : 's'}
                    {t.avgRating ? ` · ★ ${t.avgRating} (${t.ratingCount})` : ''}
                    {t.version ? ` · v${t.version}` : ''}
                  </p>
                  {t.status === 'rejected' && t.rejectedReason && (
                    <p className="text-xs text-destructive">Rejected: {t.rejectedReason}</p>
                  )}
                  <div className="flex flex-wrap gap-3 text-xs">
                    {t.repoUrl && (
                      <a href={t.repoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400">
                        Source <ExternalLink className="size-3" />
                      </a>
                    )}
                    {t.demoUrl && (
                      <a href={t.demoUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:underline dark:text-indigo-400">
                        Demo <ExternalLink className="size-3" />
                      </a>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {(t.status === 'pending' || t.status === 'rejected') && <ActionButton t={t} action="approve" icon={Check} label="Approve" />}
                  {t.status !== 'rejected' && <ActionButton t={t} action="reject" icon={X} label="Reject" />}
                  {t.status === 'approved' && <ActionButton t={t} action="feature" icon={Star} label="Feature" />}
                  {t.status === 'featured' && <ActionButton t={t} action="unfeature" icon={StarOff} label="Unfeature" />}
                  {!t.isOfficial && t.status !== 'rejected' && <ActionButton t={t} action="make_official" icon={BadgeCheck} label="Mark official" />}
                  <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => remove(t)} disabled={!!busy}>
                    {busy === t.id + 'delete' ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Trash2 className="mr-1.5 size-3.5" />}
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
