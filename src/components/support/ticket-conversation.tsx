'use client'

/**
 * One support ticket's conversation, shared by the customer Support tab and
 * Admin → Support. New messages arrive live (lib/socket joinTicketRoom); if the
 * realtime service is down the view still works and refreshes after sending.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Send, Lock, AlertTriangle, CheckCircle2, RotateCcw, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslations } from 'next-intl'
import { formatDistanceToNow } from 'date-fns'
import { useDateLocale } from '@/lib/date-locale'
import { apiFetch } from '@/store/auth-store'
import { joinTicketRoom } from '@/lib/socket'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

export interface TicketMessage {
  id: string
  body: string
  fromStaff: boolean
  internal: boolean
  createdAt: string
  authorName: string
}
export interface TicketDetail {
  id: string
  reference: string
  subject: string
  status: string
  priority: string
  category: string
  createdAt: string
  customer?: { id: string; email: string; name: string }
  assignedTo?: { id: string; name: string } | null
  messages: TicketMessage[]
}

export const STATUS_LABEL: Record<string, string> = {
  open: 'Open',
  waiting_customer: 'Waiting for customer',
  resolved: 'Resolved',
  closed: 'Closed',
}
export const STATUS_STYLE: Record<string, string> = {
  open: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300',
  waiting_customer: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  resolved: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  closed: 'bg-muted text-muted-foreground',
}
export const PRIORITY_STYLE: Record<string, string> = {
  low: 'text-muted-foreground',
  normal: '',
  high: 'border-amber-400 text-amber-700 dark:text-amber-400',
  urgent: 'border-red-400 text-red-700 dark:text-red-400',
}

export function TicketConversation({
  ticketId,
  staff,
  onChanged,
}: {
  ticketId: string
  staff: boolean
  onChanged?: () => void
}) {
  const t = useTranslations('support')
  const dateLocale = useDateLocale()
  const [ticket, setTicket] = useState<TicketDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [internal, setInternal] = useState(false)
  const [sending, setSending] = useState(false)
  const [staffList, setStaffList] = useState<Array<{ id: string; name: string }>>([])
  const bottom = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const d = await apiFetch<{ ticket: TicketDetail }>(`/support/tickets/${ticketId}`)
      setTicket(d.ticket)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the ticket')
    }
  }, [ticketId])

  useEffect(() => {
    setTicket(null)
    void load()
  }, [load])

  useEffect(() => {
    if (staff) apiFetch<{ staff: Array<{ id: string; name: string }> }>('/support/staff').then((d) => setStaffList(d.staff)).catch(() => {})
  }, [staff])

  // Live: append messages as they arrive, refetch on status changes.
  useEffect(() => {
    const leave = joinTicketRoom(ticketId, staff, {
      onMessage: (m) => {
        const msg = m as TicketMessage
        setTicket((t) => (t && !t.messages.some((x) => x.id === msg.id) ? { ...t, messages: [...t.messages, msg] } : t))
        onChanged?.()
      },
      onUpdated: () => {
        void load()
        onChanged?.()
      },
    })
    return leave
  }, [ticketId, staff, load, onChanged])

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' })
  }, [ticket?.messages.length])

  const send = async () => {
    if (!reply.trim()) return
    setSending(true)
    try {
      const { message } = await apiFetch<{ message: TicketMessage }>(`/support/tickets/${ticketId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: reply, internal: staff && internal }),
      })
      setTicket((t) => (t && !t.messages.some((x) => x.id === message.id) ? { ...t, messages: [...t.messages, message] } : t))
      setReply('')
      setInternal(false)
      await load()
      onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send')
    } finally {
      setSending(false)
    }
  }

  const patch = async (data: Record<string, unknown>, done?: string) => {
    try {
      await apiFetch(`/support/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify(data) })
      if (done) toast.success(done)
      await load()
      onChanged?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the ticket')
    }
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
        <AlertTriangle className="size-4" /> {error}
      </div>
    )
  }
  if (!ticket) {
    return (
      <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> {t('loadingConversation')}
      </div>
    )
  }

  const closed = ticket.status === 'closed'

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-2 border-b pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{ticket.reference}</span>
          <Badge variant="secondary" className={STATUS_STYLE[ticket.status]}>
            {t(`status.${ticket.status}`)}
          </Badge>
          <Badge variant="outline" className={PRIORITY_STYLE[ticket.priority]}>
            {t(`priority.${ticket.priority}`)}
          </Badge>
          <Badge variant="outline">{t(`categories.${ticket.category}`)}</Badge>
        </div>
        <h3 className="text-base font-semibold leading-snug">{ticket.subject}</h3>
        {staff && ticket.customer && (
          <p className="text-xs text-muted-foreground">
            {ticket.customer.name} · {ticket.customer.email}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {staff && (
            <>
              <Select value={ticket.status} onValueChange={(v) => patch({ status: v }, 'Status updated')}>
                <SelectTrigger className="h-8 w-auto min-w-40 text-xs" aria-label="Status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.keys(STATUS_LABEL).map((v) => (
                    <SelectItem key={v} value={v}>
                      {t(`status.${v}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={ticket.priority} onValueChange={(v) => patch({ priority: v }, 'Priority updated')}>
                <SelectTrigger className="h-8 w-auto min-w-28 text-xs" aria-label="Priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['low', 'normal', 'high', 'urgent'].map((p) => (
                    <SelectItem key={p} value={p}>
                      {t(`priority.${p}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={ticket.assignedTo?.id || 'unassigned'}
                onValueChange={(v) => patch({ assignedToId: v === 'unassigned' ? null : v }, 'Assignment updated')}
              >
                <SelectTrigger className="h-8 w-auto min-w-36 text-xs" aria-label="Assigned to">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="unassigned">Unassigned</SelectItem>
                  {staffList.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </>
          )}
          {!staff && !closed && ticket.status !== 'resolved' && (
            <Button size="sm" variant="outline" onClick={() => patch({ status: 'resolved' }, t('markedResolved'))}>
              <CheckCircle2 className="me-1.5 size-3.5" /> {t('solved')}
            </Button>
          )}
          {!staff && !closed && (
            <Button size="sm" variant="ghost" onClick={() => patch({ status: 'closed' }, t('ticketClosed'))}>
              <XCircle className="me-1.5 size-3.5" /> {t('close')}
            </Button>
          )}
          {!staff && ticket.status === 'resolved' && (
            <Button size="sm" variant="ghost" onClick={() => patch({ status: 'open' }, t('ticketReopened'))}>
              <RotateCcw className="me-1.5 size-3.5" /> {t('reopen')}
            </Button>
          )}
        </div>
      </div>

      <ol className="max-h-[55vh] space-y-3 overflow-y-auto pe-1" aria-live="polite">
        {ticket.messages.map((m) => {
          const mine = staff ? m.fromStaff : !m.fromStaff
          return (
            <li key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm ${
                  m.internal
                    ? 'border border-dashed border-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100'
                    : mine
                      ? 'bg-indigo-600 text-white'
                      : 'bg-muted text-foreground'
                }`}
              >
                <p className={`mb-1 flex items-center gap-1.5 text-[11px] ${mine && !m.internal ? 'text-indigo-100' : 'text-muted-foreground'}`}>
                  {m.internal && <Lock className="size-3" aria-hidden />}
                  {m.internal ? `${t('internalNote')} · ` : ''}
                  {m.authorName} · {formatDistanceToNow(new Date(m.createdAt), { addSuffix: true, locale: dateLocale })}
                </p>
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              </div>
            </li>
          )
        })}
        <div ref={bottom} />
      </ol>

      {closed && !staff ? (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{t('closedNote')}</p>
      ) : (
        <div className="space-y-2 border-t pt-3">
          <Label htmlFor={`reply-${ticketId}`} className="sr-only">
            {t('replyPlaceholder')}
          </Label>
          <Textarea
            id={`reply-${ticketId}`}
            rows={3}
            maxLength={10000}
            placeholder={staff && internal ? t('notePlaceholder') : t('replyPlaceholder')}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send()
            }}
            className={staff && internal ? 'border-amber-400' : ''}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            {staff ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch checked={internal} onCheckedChange={setInternal} aria-label={t('internalNote')} />
                <Lock className="size-3" /> {t('internalToggle')}
              </label>
            ) : (
              <span className="text-xs text-muted-foreground">{t('sendHint')}</span>
            )}
            <Button size="sm" onClick={send} disabled={sending || !reply.trim()}>
              {sending ? <Loader2 className="me-1.5 size-3.5 animate-spin" /> : <Send className="me-1.5 size-3.5" />}
              {staff && internal ? t('addNote') : t('send')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
