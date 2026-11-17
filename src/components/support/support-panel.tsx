'use client'

/**
 * Support tickets. Customers see their own tickets (the "Support" tab); staff
 * use the same component inside Admin → Support with `staff` set, which shows
 * every customer's tickets, queue filters, search and internal notes.
 */
import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useDateLocale } from '@/lib/date-locale'
import { LifeBuoy, Plus, Loader2, Search, Inbox, ArrowLeft, MessageSquare, BookOpen } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { TicketConversation, STATUS_STYLE, PRIORITY_STYLE } from './ticket-conversation'

interface TicketRow {
  id: string
  reference: string
  subject: string
  status: string
  priority: string
  category: string
  lastMessageAt: string
  needsAttention: boolean
  user?: { email: string; name: string }
  assignedTo?: { id: string; name: string } | null
  _count: { messages: number }
}

const CATEGORIES = ['technical', 'billing', 'domain', 'email', 'account', 'other'] as const

const FILTERS = ['active', 'open', 'waiting_customer', 'resolved', 'closed', 'all'] as const

export default function SupportPanel({ staff = false }: { staff?: boolean }) {
  const t = useTranslations('support')
  const dateLocale = useDateLocale()
  const [tickets, setTickets] = useState<TicketRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState(staff ? 'active' : 'all')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  // Notification links open a ticket directly (?ticket=<id>).
  const [selected, setSelected] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('ticket')
  )
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (staff) params.set('all', '1')
    if (filter !== 'all') params.set('status', filter)
    if (staff && query) params.set('q', query)
    try {
      const d = await apiFetch<{ tickets: TicketRow[] }>(`/support/tickets?${params}`)
      setTickets(d.tickets)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load tickets')
    }
  }, [staff, filter, query])

  useEffect(() => {
    void load()
  }, [load])

  // Debounce staff search.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(q.trim()), 300)
    return () => clearTimeout(timer)
  }, [q])

  const attention = tickets?.filter((row) => row.needsAttention).length ?? 0

  return (
    <div className="space-y-4">
      {!staff && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{t('title')}</h2>
            <p className="text-sm text-muted-foreground">{t('intro')}</p>
          </div>
          <Button onClick={() => setCreating(true)}>
            <Plus className="me-1.5 size-4" /> {t('newTicket')}
          </Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(280px,380px)_1fr]">
        <Card className={selected ? 'hidden lg:block' : ''}>
          <CardHeader className="space-y-3 pb-3">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm">{staff ? t('queue') : t('yourTickets')}</CardTitle>
              {attention > 0 && (
                <Badge className="bg-indigo-600 text-white hover:bg-indigo-600">
                  {staff ? t('needReply', { count: attention }) : t('awaitingYou', { count: attention })}
                </Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Select value={filter} onValueChange={setFilter}>
                <SelectTrigger className="h-8 text-xs" aria-label={t('filter')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FILTERS.map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`filters.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {staff && (
                <div className="relative flex-1">
                  <Search className="absolute start-2 top-2 size-4 text-muted-foreground" />
                  <Input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={t('searchPlaceholder')}
                    aria-label={t('searchPlaceholder')}
                    className="h-8 ps-8 text-xs"
                  />
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {error ? (
              <p className="p-4 text-sm text-destructive">{error}</p>
            ) : tickets === null ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> {t('loading')}
              </div>
            ) : tickets.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-sm text-muted-foreground">
                <Inbox className="size-8 opacity-50" />
                {staff ? t('emptyStaff') : t('emptyCustomer')}
                {!staff && (
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => setCreating(true)}>
                    <Plus className="me-1.5 size-3.5" /> {t('newTicket')}
                  </Button>
                )}
              </div>
            ) : (
              <ul className="max-h-[65vh] divide-y overflow-y-auto">
                {tickets.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      onClick={() => setSelected(row.id)}
                      aria-current={selected === row.id}
                      className={`flex w-full flex-col gap-1 px-4 py-3 text-start transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none ${
                        selected === row.id ? 'bg-muted' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {row.needsAttention && <span className="size-2 shrink-0 rounded-full bg-indigo-600" aria-label="Needs attention" />}
                        <span className="truncate text-sm font-medium">{row.subject}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span className="font-mono">{row.reference}</span>
                        <Badge variant="secondary" className={`px-1.5 py-0 text-[10px] ${STATUS_STYLE[row.status] || ''}`}>
                          {t(`status.${row.status}`)}
                        </Badge>
                        {row.priority !== 'normal' && (
                          <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${PRIORITY_STYLE[row.priority] || ''}`}>
                            {t(`priority.${row.priority}`)}
                          </Badge>
                        )}
                        <span className="inline-flex items-center gap-0.5">
                          <MessageSquare className="size-3" /> {row._count.messages}
                        </span>
                        <span>· {formatDistanceToNow(new Date(row.lastMessageAt), { addSuffix: true, locale: dateLocale })}</span>
                      </div>
                      {staff && row.user && (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {row.user.email}
                          {row.assignedTo ? ` · ${row.assignedTo.name}` : ' · unassigned'}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card className={selected ? '' : 'hidden lg:block'}>
          <CardContent className="pt-5">
            {selected ? (
              <>
                <Button variant="ghost" size="sm" className="mb-2 lg:hidden" onClick={() => setSelected(null)}>
                  <ArrowLeft className="me-1.5 size-4" /> {t('allTickets')}
                </Button>
                <TicketConversation ticketId={selected} staff={staff} onChanged={load} />
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
                <LifeBuoy className="size-8 opacity-50" />
                {t('selectTicket')}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {!staff && (
        <NewTicketDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(id) => {
            setCreating(false)
            setFilter('all')
            void load()
            setSelected(id)
          }}
        />
      )}
    </div>
  )
}

function NewTicketDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onCreated: (id: string) => void
}) {
  const t = useTranslations('support')
  const [subject, setSubject] = useState('')
  const [category, setCategory] = useState('technical')
  const [projectId, setProjectId] = useState('none')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [suggested, setSuggested] = useState<Array<{ slug: string; title: string; summary: string }>>([])

  // Suggest help articles that match what the customer is typing.
  useEffect(() => {
    const text = subject.trim()
    if (!open || text.length < 4) {
      setSuggested([])
      return
    }
    const timer = setTimeout(() => {
      fetch(`/api/help?suggest=${encodeURIComponent(text)}`)
        .then((r) => (r.ok ? r.json() : { articles: [] }))
        .then((d: { articles?: Array<{ slug: string; title: string; summary: string }> }) => setSuggested(d.articles ?? []))
        .catch(() => setSuggested([]))
    }, 400)
    return () => clearTimeout(timer)
  }, [subject, open])

  useEffect(() => {
    if (!open) return
    apiFetch<{ projects: Array<{ id: string; name: string }> }>('/hosting')
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]))
  }, [open])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const { ticket } = await apiFetch<{ ticket: { id: string; reference: string } }>('/support/tickets', {
        method: 'POST',
        body: JSON.stringify({ subject, category, body, projectId: projectId === 'none' ? undefined : projectId }),
      })
      toast.success(t('opened', { reference: ticket.reference }))
      setSubject('')
      setBody('')
      setProjectId('none')
      onCreated(ticket.id)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the ticket')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t('dialogTitle')}</DialogTitle>
            <DialogDescription>{t('dialogIntro')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="t-subject">{t('subject')}</Label>
            <Input id="t-subject" value={subject} onChange={(e) => setSubject(e.target.value)} minLength={3} maxLength={150} required />
          </div>
          {suggested.length > 0 && (
            <div className="rounded-md border border-indigo-200 bg-indigo-50/60 p-3 text-sm dark:border-indigo-900 dark:bg-indigo-950/30" aria-live="polite">
              <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-indigo-900 dark:text-indigo-200">
                <BookOpen className="size-3.5" /> {t('suggested')}
              </p>
              <ul className="space-y-1">
                {suggested.map((a) => (
                  <li key={a.slug}>
                    <a href={`/help/${a.slug}`} target="_blank" rel="noreferrer" className="font-medium text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-300">
                      {a.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>{t('topic')}</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger aria-label={t('topic')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`categories.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t('website')}</Label>
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger aria-label={t('website')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t('notAboutWebsite')}</SelectItem>
                  {projects.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="t-body">{t('message')}</Label>
            <Textarea id="t-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} required />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy || subject.trim().length < 3 || !body.trim()}>
              {busy && <Loader2 className="me-1.5 size-4 animate-spin" />} {t('open')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
