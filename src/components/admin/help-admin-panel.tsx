'use client'

/** Admin → Help: write and publish help-center articles (Markdown). */
import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, Plus, Trash2, Eye, Pencil, ThumbsUp, ThumbsDown, BookOpen } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const CATEGORIES: Array<[string, string]> = [
  ['getting-started', 'Getting started'],
  ['hosting', 'Websites & hosting'],
  ['domains', 'Domains & DNS'],
  ['email', 'Email'],
  ['billing', 'Billing'],
  ['account', 'Account & security'],
]

interface Article {
  id: string
  slug: string
  title: string
  summary: string
  body: string
  category: string
  published: boolean
  order: number
  views: number
  helpfulYes: number
  helpfulNo: number
}

const blank = { id: '', slug: '', title: '', summary: '', body: '', category: 'getting-started', published: true, order: 0 }

export function HelpAdminPanel() {
  const [articles, setArticles] = useState<Article[] | null>(null)
  const [editing, setEditing] = useState<typeof blank | null>(null)

  const load = useCallback(async () => {
    try {
      setArticles((await apiFetch<{ articles: Article[] }>('/admin/help')).articles)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load articles')
      setArticles([])
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const remove = async (a: Article) => {
    if (!confirm(`Delete “${a.title}”? This cannot be undone.`)) return
    try {
      await apiFetch(`/admin/help/${a.id}`, { method: 'DELETE' })
      toast.success('Article deleted')
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete')
    }
  }

  if (editing) {
    return (
      <ArticleEditor
        initial={editing}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null)
          void load()
        }}
      />
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">Help center</CardTitle>
          <CardDescription>Articles shown at /help and suggested to customers when they open a ticket.</CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href="/help" target="_blank" rel="noreferrer">
              <ExternalLink className="me-1.5 size-3.5" /> View
            </a>
          </Button>
          <Button size="sm" onClick={() => setEditing({ ...blank })}>
            <Plus className="me-1.5 size-3.5" /> New article
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {articles === null ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : articles.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <BookOpen className="size-8 opacity-50" /> No articles.
          </div>
        ) : (
          <ul className="divide-y">
            {articles.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-6 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {a.title}
                    {!a.published && <Badge variant="secondary">Draft</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {CATEGORIES.find(([k]) => k === a.category)?.[1]} · /help/{a.slug}
                  </p>
                </div>
                <span className="flex items-center gap-3 text-xs text-muted-foreground" aria-label="Views and feedback">
                  <span className="inline-flex items-center gap-1">
                    <Eye className="size-3.5" /> {a.views}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ThumbsUp className="size-3.5" /> {a.helpfulYes}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ThumbsDown className="size-3.5" /> {a.helpfulNo}
                  </span>
                </span>
                <Button variant="ghost" size="icon" className="size-8" onClick={() => setEditing({ ...a })} aria-label={`Edit ${a.title}`}>
                  <Pencil className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" className="size-8" onClick={() => remove(a)} aria-label={`Delete ${a.title}`}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function ArticleEditor({ initial, onCancel, onSaved }: { initial: typeof blank; onCancel: () => void; onSaved: () => void }) {
  const [a, setA] = useState(initial)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof blank>(k: K, v: (typeof blank)[K]) => setA((cur) => ({ ...cur, [k]: v }))

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const body = JSON.stringify({ title: a.title, slug: a.slug || undefined, summary: a.summary, body: a.body, category: a.category, published: a.published, order: Number(a.order) || 0 })
      if (a.id) await apiFetch(`/admin/help/${a.id}`, { method: 'PATCH', body })
      else await apiFetch('/admin/help', { method: 'POST', body })
      toast.success('Article saved')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle className="text-base">{a.id ? 'Edit article' : 'New article'}</CardTitle>
          <CardDescription>Markdown: **bold**, *italic*, `code`, lists, [links](/status). HTML is not rendered.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="h-title">Title</Label>
              <Input id="h-title" value={a.title} onChange={(e) => set('title', e.target.value)} maxLength={160} required />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-slug">URL name</Label>
              <Input id="h-slug" value={a.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} placeholder="made from the title" maxLength={80} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="h-summary">Summary</Label>
            <Input id="h-summary" value={a.summary} onChange={(e) => set('summary', e.target.value)} maxLength={300} />
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_120px_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={a.category} onValueChange={(v) => set('category', v)}>
                <SelectTrigger aria-label="Category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map(([k, l]) => (
                    <SelectItem key={k} value={k}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="h-order">Order</Label>
              <Input id="h-order" type="number" min={0} value={a.order} onChange={(e) => set('order', Number(e.target.value))} />
            </div>
            <label className="flex h-9 items-center gap-2 text-sm">
              <Switch checked={a.published} onCheckedChange={(v) => set('published', v)} /> Published
            </label>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="h-body">Article</Label>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPreview((p) => !p)}>
                {preview ? <Pencil className="me-1.5 size-3.5" /> : <Eye className="me-1.5 size-3.5" />}
                {preview ? 'Edit' : 'Preview'}
              </Button>
            </div>
            {preview ? (
              <div className="min-h-64 space-y-3 rounded-md border p-4 text-sm leading-6 [&_ol]:list-decimal [&_ol]:ps-6 [&_ul]:list-disc [&_ul]:ps-6 [&_a]:text-indigo-600 [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1">
                <ReactMarkdown>{a.body || '*Nothing yet*'}</ReactMarkdown>
              </div>
            ) : (
              <Textarea id="h-body" rows={14} value={a.body} onChange={(e) => set('body', e.target.value)} maxLength={50000} required className="font-mono text-[13px]" />
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || a.title.trim().length < 3 || !a.body.trim()}>
              {busy && <Loader2 className="me-1.5 size-4 animate-spin" />} Save
            </Button>
          </div>
        </CardContent>
      </form>
    </Card>
  )
}
