'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from '@/components/ui/card'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from 'sonner'
import {
  Plus, Pencil, Trash2, Eye, EyeOff, GripVertical, Save, Loader2,
  FileText, LayoutGrid, RefreshCw, X, ChevronUp, ChevronDown, Save as SaveIcon,
  ChevronRight, Sparkles,
} from 'lucide-react'
import { useAuthStore } from '@/store/auth-store'
import { ICON_NAMES, resolveIcon } from '@/components/landing/icon-registry'
import { CONTENT_GROUPS, KNOWN_CONTENT_KEYS } from '@/lib/content-schema'
import { cn } from '@/lib/utils'

// ── Types ──────────────────────────────────────────────────────────────
interface CmsPlan {
  id?: string
  name: string
  price: number
  period: string
  description: string
  features: string[]
  popular: boolean
}

interface CmsHighlight {
  title: string
  description: string
  iconName: string
}

interface CmsFaq {
  q: string
  a: string
}

interface CmsService {
  id: string
  slug: string
  name: string
  tagline: string
  description: string
  iconName: string
  accent: string
  features: string[]
  visible: boolean
  order: number
  plans: CmsPlan[]
  highlights: CmsHighlight[]
  faqs: CmsFaq[]
}

interface SiteContentMap {
  [key: string]: string
}

// ── API helper ─────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  // Authenticated by the httpOnly session cookie (see src/lib/session.ts).
  const res = await fetch(`/api${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(data.error || `Request failed with status ${res.status}`)
  }
  return res.json()
}

// ── Accent gradient presets ────────────────────────────────────────────
const ACCENT_PRESETS = [
  'from-indigo-500 to-indigo-400',
  'from-indigo-950 to-indigo-500',
  'from-indigo-400 to-indigo-600',
  'from-indigo-500 to-indigo-950',
  'from-indigo-500 to-indigo-700',
  'from-indigo-700 to-indigo-300',
  'from-indigo-300 to-indigo-700',
  'from-indigo-400 to-indigo-700',
]

// ── Default blank service for the "Create" dialog ──────────────────────
function blankService(): Partial<CmsService> {
  return {
    slug: '',
    name: '',
    tagline: '',
    description: '',
    iconName: 'LayoutGrid',
    accent: ACCENT_PRESETS[0],
    features: [],
    visible: true,
    plans: [],
    highlights: [],
    faqs: [],
  }
}

// ── Component ──────────────────────────────────────────────────────────
export function CmsPanel() {
  const [services, setServices] = useState<CmsService[]>([])
  const [content, setContent] = useState<SiteContentMap>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<Partial<CmsService> | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CmsService | null>(null)
  const [view, setView] = useState<'services' | 'pages'>('services')

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [svcRes, contentRes] = await Promise.all([
        apiFetch<{ services: CmsService[] }>('/admin/services'),
        apiFetch<{ content: SiteContentMap }>('/admin/site-content'),
      ])
      setServices(svcRes.services)
      setContent(contentRes.content)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load CMS data')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  // ── Service CRUD ────────────────────────────────────────────────────
  const openCreate = () => {
    setEditing(blankService())
    setDialogOpen(true)
  }

  const openEdit = (svc: CmsService) => {
    setEditing({ ...svc })
    setDialogOpen(true)
  }

  const handleSave = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const body = {
        slug: editing.slug,
        name: editing.name,
        tagline: editing.tagline,
        description: editing.description,
        iconName: editing.iconName,
        accent: editing.accent,
        features: editing.features,
        visible: editing.visible,
        plans: editing.plans,
        highlights: editing.highlights,
        faqs: editing.faqs,
      }
      if (editing.id) {
        await apiFetch(`/admin/services/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        toast.success('Service updated')
      } else {
        await apiFetch('/admin/services', { method: 'POST', body: JSON.stringify(body) })
        toast.success('Service created')
      }
      setDialogOpen(false)
      setEditing(null)
      fetchAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save service')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setSaving(true)
    try {
      await apiFetch(`/admin/services/${deleteTarget.id}`, { method: 'DELETE' })
      toast.success(`Deleted "${deleteTarget.name}"`)
      setDeleteTarget(null)
      fetchAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to delete service')
    } finally {
      setSaving(false)
    }
  }

  const toggleVisible = async (svc: CmsService) => {
    try {
      await apiFetch(`/admin/services/${svc.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ visible: !svc.visible }),
      })
      toast.success(svc.visible ? 'Service hidden' : 'Service published')
      fetchAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to toggle visibility')
    }
  }

  const moveOrder = async (svc: CmsService, direction: 'up' | 'down') => {
    const idx = services.findIndex((s) => s.id === svc.id)
    const swapWith = direction === 'up' ? idx - 1 : idx + 1
    if (swapWith < 0 || swapWith >= services.length) return
    const other = services[swapWith]
    try {
      await Promise.all([
        apiFetch(`/admin/services/${svc.id}`, { method: 'PATCH', body: JSON.stringify({ order: other.order }) }),
        apiFetch(`/admin/services/${other.id}`, { method: 'PATCH', body: JSON.stringify({ order: svc.order }) }),
      ])
      fetchAll()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reorder')
    }
  }

  // ── Site content save ──────────────────────────────────────────────
  const saveContent = async () => {
    setSaving(true)
    try {
      await apiFetch('/admin/site-content', { method: 'PUT', body: JSON.stringify({ content }) })
      toast.success('Site text saved')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save text')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <LayoutGrid className="size-6 text-indigo-500" />
            Content Management
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Manage services, pricing, and all text on the website. Changes go live instantly.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={fetchAll} disabled={loading}>
            <RefreshCw className="size-4 me-1" /> Refresh
          </Button>
          {view === 'services' && (
            <Button size="sm" onClick={openCreate} className="bg-indigo-500 hover:bg-indigo-600 text-white border-0">
              <Plus className="size-4 me-1" /> New Service
            </Button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b">
        <TabButton active={view === 'services'} onClick={() => setView('services')} icon={LayoutGrid} label="Services" count={services.length} />
        <TabButton active={view === 'pages'} onClick={() => setView('pages')} icon={FileText} label="Pages & Text" count={CONTENT_GROUPS.length} />
      </div>

      {/* Services view */}
      {view === 'services' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Services ({services.length})</CardTitle>
            <CardDescription>Add, edit, delete, reorder, and toggle visibility of services shown on the public site. Each service drives its dedicated page, the pricing page, and the navbar dropdown.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="max-h-[32rem]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>Service</TableHead>
                    <TableHead className="hidden md:table-cell">Slug</TableHead>
                    <TableHead className="hidden lg:table-cell">Plans</TableHead>
                    <TableHead className="text-center">Visible</TableHead>
                    <TableHead className="text-end">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {services.map((svc, i) => {
                    const Icon = resolveIcon(svc.iconName)
                    return (
                      <TableRow key={svc.id}>
                        <TableCell className="align-middle">
                          <div className="flex flex-col">
                            <button onClick={() => moveOrder(svc, 'up')} disabled={i === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Move up">
                              <ChevronUp className="size-3.5" />
                            </button>
                            <button onClick={() => moveOrder(svc, 'down')} disabled={i === services.length - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30" aria-label="Move down">
                              <ChevronDown className="size-3.5" />
                            </button>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className={`flex size-9 items-center justify-center rounded-lg bg-gradient-to-br ${svc.accent} text-white shadow-sm shrink-0`}>
                              <Icon className="size-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="font-medium truncate">{svc.name}</p>
                              <p className="text-xs text-muted-foreground truncate max-w-[20rem]">{svc.tagline}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <code className="text-xs rounded bg-muted px-1.5 py-0.5">{svc.slug}</code>
                        </TableCell>
                        <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">{svc.plans.length}</TableCell>
                        <TableCell className="text-center">
                          <button onClick={() => toggleVisible(svc)} className="inline-flex" aria-label="Toggle visibility">
                            {svc.visible ? (
                              <Eye className="size-4 text-indigo-500" />
                            ) : (
                              <EyeOff className="size-4 text-muted-foreground" />
                            )}
                          </button>
                        </TableCell>
                        <TableCell className="text-end">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="sm" onClick={() => openEdit(svc)}>
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(svc)} className="text-red-500 hover:text-red-600">
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                  {services.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-12">
                        No services yet. Click &ldquo;New Service&rdquo; to create one.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {/* Pages & Text view */}
      {view === 'pages' && (
        <PagesEditor
          content={content}
          setContent={setContent}
          onSave={saveContent}
          saving={saving}
        />
      )}

      {/* Service editor dialog */}
      <ServiceEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        service={editing}
        onChange={setEditing}
        onSave={handleSave}
        saving={saving}
        isEdit={!!editing?.id}
      />

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete &ldquo;{deleteTarget?.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              This permanently removes the service and all its plans, highlights, and FAQs. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)} disabled={saving}>Cancel</Button>
            <Button variant="destructive" onClick={handleDelete} disabled={saving}>
              {saving ? <Loader2 className="size-4 me-1 animate-spin" /> : <Trash2 className="size-4 me-1" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Tab button ────────────────────────────────────────────────────────
function TabButton({ active, onClick, icon: Icon, label, count }: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
  count?: number
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'relative inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors -mb-px border-b-2',
        active
          ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      )}
    >
      <Icon className="size-4" />
      {label}
      {count != null && (
        <Badge variant="secondary" className="text-xs h-5 px-1.5">{count}</Badge>
      )}
    </button>
  )
}

// ── Pages & Text editor ──────────────────────────────────────────────
interface PagesEditorProps {
  content: SiteContentMap
  setContent: React.Dispatch<React.SetStateAction<SiteContentMap>>
  onSave: () => void
  saving: boolean
}

function PagesEditor({ content, setContent, onSave, saving }: PagesEditorProps) {
  const [openGroup, setOpenGroup] = useState<string>(CONTENT_GROUPS[0]?.group ?? '')
  const [customOpen, setCustomOpen] = useState(false)
  const [newKey, setNewKey] = useState('')

  // Keys that exist in the content map but aren't part of the schema (power-user additions).
  const customKeys = Object.keys(content).filter((k) => !KNOWN_CONTENT_KEYS.includes(k))

  const setField = (key: string, value: string) => {
    setContent((c) => ({ ...c, [key]: value }))
  }

  const addCustomKey = () => {
    const k = newKey.trim()
    if (!k) {
      toast.error('Enter a key first')
      return
    }
    if (content[k] != null) {
      toast.error('That key already exists')
      return
    }
    setField(k, '')
    setNewKey('')
    setCustomOpen(true)
  }

  const removeKey = (key: string) => {
    setContent((c) => {
      const next = { ...c }
      delete next[key]
      return next
    })
  }

  return (
    <div className="space-y-4">
      {/* Sticky save bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between rounded-lg border bg-background/95 backdrop-blur px-4 py-3 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <FileText className="size-4 text-indigo-500" />
          <span>Edit the text shown across every public page. Fields are pre-filled with defaults.</span>
        </div>
        <Button size="sm" onClick={onSave} disabled={saving} className="bg-indigo-500 hover:bg-indigo-600 text-white border-0">
          {saving ? <Loader2 className="size-4 me-1 animate-spin" /> : <SaveIcon className="size-4 me-1" />}
          Save Changes
        </Button>
      </div>

      {/* Grouped content */}
      {CONTENT_GROUPS.map((group) => {
        const isOpen = openGroup === group.group
        const GroupIcon = resolveIcon(group.icon ?? 'FileText')
        // Count how many fields in this group differ from the default (unsaved edits indicator).
        const changedCount = group.fields.filter((f) => content[f.key] != null && content[f.key] !== '').length

        return (
          <Card key={group.group} className="overflow-hidden">
            <button
              type="button"
              onClick={() => setOpenGroup(isOpen ? '' : group.group)}
              className="w-full text-start flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-accent/50 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10">
                  <GroupIcon className="size-4 text-indigo-500" />
                </div>
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm truncate">{group.group}</h3>
                  {group.description && (
                    <p className="text-xs text-muted-foreground truncate">{group.description}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant="outline" className="text-xs">{group.fields.length} fields</Badge>
                <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
              </div>
            </button>
            {isOpen && (
              <CardContent className="pt-0 border-t">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3 pt-4">
                  {group.fields.map((field) => (
                    <div key={field.key} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <Label className="text-xs font-medium">{field.label}</Label>
                        <code className="text-[10px] text-muted-foreground/70 truncate max-w-[12rem]">{field.key}</code>
                      </div>
                      {field.type === 'textarea' ? (
                        <Textarea
                          value={content[field.key] ?? ''}
                          onChange={(e) => setField(field.key, e.target.value)}
                          rows={2}
                          className="text-sm resize-y"
                        />
                      ) : (
                        <Input
                          value={content[field.key] ?? ''}
                          onChange={(e) => setField(field.key, e.target.value)}
                          className="text-sm"
                        />
                      )}
                      {field.hint && (
                        <p className="text-[11px] text-muted-foreground">{field.hint}</p>
                      )}
                    </div>
                  ))}
                </div>
              </CardContent>
            )}
          </Card>
        )
      })}

      {/* Custom keys (power-user) */}
      <Card className="overflow-hidden">
        <button
          type="button"
          onClick={() => setCustomOpen((v) => !v)}
          className="w-full text-start flex items-center justify-between gap-3 px-4 py-3.5 hover:bg-accent/50 transition-colors"
        >
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10">
              <ChevronRight className="size-4 text-amber-600" />
            </div>
            <div>
              <h3 className="font-semibold text-sm">Custom Keys</h3>
              <p className="text-xs text-muted-foreground">Advanced: add arbitrary key/value pairs not covered by the schema above.</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {customKeys.length > 0 && <Badge variant="outline" className="text-xs">{customKeys.length}</Badge>}
            <ChevronDown className={cn('size-4 text-muted-foreground transition-transform', customOpen && 'rotate-180')} />
          </div>
        </button>
        {customOpen && (
          <CardContent className="pt-0 border-t space-y-3">
            <div className="pt-4 space-y-2">
              {customKeys.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">No custom keys. Add one below if you need a value not covered by the groups above.</p>
              ) : (
                customKeys.map((key) => (
                  <div key={key} className="grid grid-cols-1 md:grid-cols-[12rem_1fr_auto] gap-2 items-start">
                    <div className="flex items-center gap-1 pt-2">
                      <code className="text-xs rounded bg-muted px-1.5 py-0.5 truncate">{key}</code>
                      <button onClick={() => removeKey(key)} className="text-red-400 hover:text-red-600" aria-label="Remove key">
                        <X className="size-3.5" />
                      </button>
                    </div>
                    <Textarea
                      value={content[key] ?? ''}
                      onChange={(e) => setField(key, e.target.value)}
                      rows={2}
                      className="text-sm"
                    />
                  </div>
                ))
              )}
            </div>
            <div className="flex gap-2 pt-2 border-t">
              <Input
                placeholder="new.key (e.g. hero.promoBanner)"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomKey() } }}
                className="text-sm max-w-xs"
              />
              <Button variant="outline" size="sm" onClick={addCustomKey}>
                <Plus className="size-4 me-1" /> Add Key
              </Button>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  )
}

// ── Service editor dialog ──────────────────────────────────────────────
interface EditorProps {
  open: boolean
  onOpenChange: (o: boolean) => void
  service: Partial<CmsService> | null
  onChange: (s: Partial<CmsService>) => void
  onSave: () => void
  saving: boolean
  isEdit: boolean
}

function ServiceEditorDialog({ open, onOpenChange, service, onChange, onSave, saving, isEdit }: EditorProps) {
  if (!service) return null

  const update = (patch: Partial<CmsService>) => onChange({ ...service, ...patch })

  // Web hosting is sold as a subscription, so its plans belong to the billing
  // catalogue rather than to CMS copy.
  const isBilledHostingService = service.slug === 'web-hosting'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit Service' : 'New Service'}</DialogTitle>
          <DialogDescription>
            {isEdit ? 'Update the service details below.' : 'Fill in the details to create a new service.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Core fields */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Name *</Label>
              <Input value={service.name ?? ''} onChange={(e) => update({ name: e.target.value })} placeholder="Web Development" />
            </div>
            <div className="space-y-1.5">
              <Label>Slug *</Label>
              <Input value={service.slug ?? ''} onChange={(e) => update({ slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })} placeholder="web-development" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Tagline *</Label>
            <Input value={service.tagline ?? ''} onChange={(e) => update({ tagline: e.target.value })} placeholder="Custom web apps engineered for scale." />
          </div>

          <div className="space-y-1.5">
            <Label>Description *</Label>
            <Textarea value={service.description ?? ''} onChange={(e) => update({ description: e.target.value })} rows={3} placeholder="From MVP to enterprise — Apsamo Technology builds production-grade web applications..." />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Icon *</Label>
              <Select value={service.iconName ?? 'LayoutGrid'} onValueChange={(v) => update({ iconName: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick an icon" />
                </SelectTrigger>
                <SelectContent className="max-h-72">
                  {ICON_NAMES.map((name) => {
                    const Icon = resolveIcon(name)
                    return (
                      <SelectItem key={name} value={name}>
                        <span className="inline-flex items-center gap-2">
                          <Icon className="size-4" />
                          {name}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Accent gradient *</Label>
              <Select value={service.accent ?? ACCENT_PRESETS[0]} onValueChange={(v) => update({ accent: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Pick a gradient" />
                </SelectTrigger>
                <SelectContent>
                  {ACCENT_PRESETS.map((g) => (
                    <SelectItem key={g} value={g}>
                      <span className="inline-flex items-center gap-2">
                        <span className={`size-4 rounded bg-gradient-to-br ${g}`} />
                        <code className="text-xs">{g}</code>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Features (one per line)</Label>
            <Textarea
              value={(service.features ?? []).join('\n')}
              onChange={(e) => update({ features: e.target.value.split('\n').filter(Boolean) })}
              rows={4}
              placeholder={'Full-stack Next.js architecture\nPixel-perfect UI\nServerless APIs'}
            />
          </div>

          <div className="flex items-center gap-2">
            <Switch checked={service.visible ?? true} onCheckedChange={(v) => update({ visible: v })} id="visible" />
            <Label htmlFor="visible">Visible on public site</Label>
          </div>

          {/*
            Hosting prices are NOT edited here.

            They live in the billing catalogue (Admin → Plans) because that is
            what checkout charges from. When this editor also owned them there
            were two sources of truth, and they drifted: the site advertised
            $9/$29/$99 while customers were billed $4.99/$8.99/$17.99. Editing
            them here would silently do nothing now that the public pages read
            the catalogue, which is worse than not offering the field.
          */}
          {isBilledHostingService ? (
            <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-4">
              <p className="text-sm font-medium flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-indigo-500" />
                Pricing plans are managed in Admin → Plans
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Hosting is sold as a subscription, so its prices, limits and
                features come from the billing catalogue — the same record
                checkout charges from. Editing them in one place keeps the
                advertised price and the charged price identical.
              </p>
            </div>
          ) : (
          <SubSection
            title="Pricing Plans"
            count={service.plans?.length ?? 0}
            onAdd={() => update({ plans: [...(service.plans ?? []), { name: '', price: 0, period: '/mo', description: '', features: [], popular: false }] })}
          >
            {(service.plans ?? []).map((plan, i) => (
              <NestedCard key={i} onRemove={() => update({ plans: service.plans!.filter((_, idx) => idx !== i) })}>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <Input placeholder="Name" value={plan.name} onChange={(e) => { const p = [...service.plans!]; p[i] = { ...plan, name: e.target.value }; update({ plans: p }) }} />
                  <Input type="number" placeholder="Price" value={plan.price} onChange={(e) => { const p = [...service.plans!]; p[i] = { ...plan, price: Number(e.target.value) }; update({ plans: p }) }} />
                  <Input placeholder="Period" value={plan.period} onChange={(e) => { const p = [...service.plans!]; p[i] = { ...plan, period: e.target.value }; update({ plans: p }) }} />
                  <div className="flex items-center gap-2">
                    <Switch checked={plan.popular} onCheckedChange={(v) => { const p = [...service.plans!]; p[i] = { ...plan, popular: v }; update({ plans: p }) }} id={`pop-${i}`} />
                    <Label htmlFor={`pop-${i}`} className="text-xs">Popular</Label>
                  </div>
                </div>
                <Input placeholder="Description" value={plan.description} onChange={(e) => { const p = [...service.plans!]; p[i] = { ...plan, description: e.target.value }; update({ plans: p }) }} className="mt-2" />
                <Textarea placeholder="Features (one per line)" rows={2} value={plan.features.join('\n')} onChange={(e) => { const p = [...service.plans!]; p[i] = { ...plan, features: e.target.value.split('\n').filter(Boolean) }; update({ plans: p }) }} className="mt-2" />
              </NestedCard>
            ))}
          </SubSection>
          )}

          {/* Highlights */}
          <SubSection
            title="Highlights"
            count={service.highlights?.length ?? 0}
            onAdd={() => update({ highlights: [...(service.highlights ?? []), { title: '', description: '', iconName: 'LayoutGrid' }] })}
          >
            {(service.highlights ?? []).map((h, i) => (
              <NestedCard key={i} onRemove={() => update({ highlights: service.highlights!.filter((_, idx) => idx !== i) })}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <Input placeholder="Title" value={h.title} onChange={(e) => { const arr = [...service.highlights!]; arr[i] = { ...h, title: e.target.value }; update({ highlights: arr }) }} />
                  <Select value={h.iconName} onValueChange={(v) => { const arr = [...service.highlights!]; arr[i] = { ...h, iconName: v }; update({ highlights: arr }) }}>
                    <SelectTrigger><SelectValue placeholder="Icon" /></SelectTrigger>
                    <SelectContent className="max-h-60">
                      {ICON_NAMES.map((name) => {
                        const Icon = resolveIcon(name)
                        return <SelectItem key={name} value={name}><span className="inline-flex items-center gap-2"><Icon className="size-4" />{name}</span></SelectItem>
                      })}
                    </SelectContent>
                  </Select>
                </div>
                <Textarea placeholder="Description" rows={2} value={h.description} onChange={(e) => { const arr = [...service.highlights!]; arr[i] = { ...h, description: e.target.value }; update({ highlights: arr }) }} className="mt-2" />
              </NestedCard>
            ))}
          </SubSection>

          {/* FAQs */}
          <SubSection
            title="FAQs"
            count={service.faqs?.length ?? 0}
            onAdd={() => update({ faqs: [...(service.faqs ?? []), { q: '', a: '' }] })}
          >
            {(service.faqs ?? []).map((f, i) => (
              <NestedCard key={i} onRemove={() => update({ faqs: service.faqs!.filter((_, idx) => idx !== i) })}>
                <Input placeholder="Question" value={f.q} onChange={(e) => { const arr = [...service.faqs!]; arr[i] = { ...f, q: e.target.value }; update({ faqs: arr }) }} />
                <Textarea placeholder="Answer" rows={2} value={f.a} onChange={(e) => { const arr = [...service.faqs!]; arr[i] = { ...f, a: e.target.value }; update({ faqs: arr }) }} className="mt-2" />
              </NestedCard>
            ))}
          </SubSection>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={onSave} disabled={saving} className="bg-indigo-500 hover:bg-indigo-600 text-white border-0">
            {saving ? <Loader2 className="size-4 me-1 animate-spin" /> : <Save className="size-4 me-1" />}
            {isEdit ? 'Save Changes' : 'Create Service'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Sub-section wrapper ────────────────────────────────────────────────
function SubSection({ title, count, onAdd, children }: { title: string; count: number; onAdd: () => void; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold">{title}</h4>
          <Badge variant="secondary" className="text-xs">{count}</Badge>
        </div>
        <Button variant="outline" size="sm" onClick={onAdd} type="button">
          <Plus className="size-3.5 me-1" /> Add
        </Button>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

// ── Nested card with remove button ─────────────────────────────────────
function NestedCard({ onRemove, children }: { onRemove: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3 relative">
      <button onClick={onRemove} className="absolute top-2 end-2 text-red-400 hover:text-red-600 z-10" aria-label="Remove">
        <X className="size-4" />
      </button>
      <div className="pe-6">{children}</div>
    </div>
  )
}
