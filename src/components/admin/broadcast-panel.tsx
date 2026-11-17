'use client'

/**
 * Admin → Announcements. Tell customers about maintenance, an incident or a
 * price change (POST /api/admin/broadcast). Sending is irreversible, so the
 * flow is always: write → preview who it reaches → confirm.
 */
import { useState } from 'react'
import { Megaphone, Loader2, Users, Send } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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

const AUDIENCES = [
  ['active', 'All active customers'],
  ['paying', 'Customers with a paid plan'],
  ['with-hosting', 'Customers with websites'],
  ['with-email', 'Customers with email hosting'],
  ['suspended', 'Suspended accounts'],
  ['all', 'Everyone (including suspended)'],
] as const
const TYPES = [
  ['info', 'Information'],
  ['warning', 'Warning (e.g. maintenance)'],
  ['error', 'Incident'],
  ['success', 'Good news'],
] as const

interface Preview {
  recipientCount: number
  sample: string[]
  willEmail: boolean
}

export function BroadcastPanel() {
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [type, setType] = useState<string>('info')
  const [audience, setAudience] = useState<string>('active')
  const [sendEmail, setSendEmail] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'send' | null>(null)

  const valid = title.trim().length >= 3 && message.trim().length >= 3
  const body = (confirm: boolean) =>
    JSON.stringify({ title: title.trim(), message: message.trim(), type, audience, sendEmail, confirm })

  const doPreview = async () => {
    setBusy('preview')
    try {
      const p = await apiFetch<Preview>('/admin/broadcast', { method: 'POST', body: body(false) })
      setPreview(p)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not preview')
    } finally {
      setBusy(null)
    }
  }

  const doSend = async () => {
    setBusy('send')
    try {
      const r = await apiFetch<{ message: string; failed: number }>('/admin/broadcast', { method: 'POST', body: body(true) })
      if (r.failed) toast.warning(r.message)
      else toast.success(r.message)
      setPreview(null)
      setTitle('')
      setMessage('')
      setSendEmail(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="size-5 text-indigo-500" /> Announcements
        </CardTitle>
        <CardDescription>
          Send a notice to customers&apos; notification centre, and optionally by email. You&apos;ll see exactly who it
          reaches before anything is sent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="bc-audience">Send to</Label>
            <Select value={audience} onValueChange={setAudience}>
              <SelectTrigger id="bc-audience">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIENCES.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bc-type">Kind</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="bc-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bc-title">Title</Label>
          <Input id="bc-title" maxLength={120} placeholder="Scheduled maintenance on Sunday 02:00–03:00 UTC" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="bc-message">Message</Label>
          <Textarea id="bc-message" rows={5} maxLength={4000} placeholder="What is happening, who is affected, and what they need to do." value={message} onChange={(e) => setMessage(e.target.value)} />
          <p className="text-right text-xs text-muted-foreground">{message.length}/4000</p>
        </div>
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div>
            <Label htmlFor="bc-email">Also send by email</Label>
            <p className="text-xs text-muted-foreground">
              Use sparingly: most notices belong in the panel only, and a burst of identical mail can hurt your sending
              reputation.
            </p>
          </div>
          <Switch id="bc-email" checked={sendEmail} onCheckedChange={setSendEmail} />
        </div>
        <div className="flex justify-end">
          <Button onClick={doPreview} disabled={!valid || !!busy}>
            {busy === 'preview' ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Users className="mr-2 size-4" />}
            Preview recipients
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={!!preview} onOpenChange={(o) => !o && setPreview(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Send to {preview?.recipientCount} customer{preview?.recipientCount === 1 ? '' : 's'}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  “{title.trim()}” will appear in their notifications{preview?.willEmail ? ' and be emailed to them' : ''}. This
                  cannot be undone.
                </p>
                {preview && preview.sample.length > 0 && (
                  <p className="text-muted-foreground">
                    Including: {preview.sample.join(', ')}
                    {preview.recipientCount > preview.sample.length ? ` and ${preview.recipientCount - preview.sample.length} more` : ''}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === 'send'}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void doSend()
              }}
              disabled={busy === 'send'}
            >
              {busy === 'send' ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Send className="mr-2 size-4" />}
              Send now
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
