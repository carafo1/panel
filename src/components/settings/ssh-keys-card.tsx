'use client'

/** Settings → Security: public SSH keys used for websites' SFTP access. */
import { useCallback, useEffect, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { KeyRound, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface SshKey {
  id: string
  name: string
  fingerprint: string
  type: string
  createdAt: string
}

export function SshKeysCard() {
  const [keys, setKeys] = useState<SshKey[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      setKeys((await apiFetch<{ keys: SshKey[] }>('/user/ssh-keys')).keys)
    } catch {
      setKeys([])
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await apiFetch('/user/ssh-keys', { method: 'POST', body: JSON.stringify({ name, publicKey }) })
      toast.success('SSH key added')
      setAdding(false)
      setName('')
      setPublicKey('')
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add the key')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (k: SshKey) => {
    if (!confirm(`Remove “${k.name}”? It stops working on every website immediately.`)) return
    try {
      const r = await apiFetch<{ warnings?: string[] }>(`/user/ssh-keys/${k.id}`, { method: 'DELETE' })
      if (r.warnings?.length) toast.warning(`Key removed, but a server reported: ${r.warnings[0]}`)
      else toast.success('SSH key removed')
      void load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the key')
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-4" /> SSH keys
          </CardTitle>
          <CardDescription>Public keys for SFTP access to your websites. Turn SFTP on per website in Hosting.</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus className="me-1.5 size-3.5" /> Add key
        </Button>
      </CardHeader>
      <CardContent>
        {keys === null ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </div>
        ) : keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">No keys yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{k.name}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {k.type} · {k.fingerprint} · added {formatDistanceToNow(new Date(k.createdAt), { addSuffix: true })}
                  </p>
                </div>
                <Button variant="ghost" size="icon" className="size-8" onClick={() => remove(k)} aria-label={`Remove ${k.name}`}>
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <form onSubmit={add} className="space-y-4">
            <DialogHeader>
              <DialogTitle>Add an SSH key</DialogTitle>
              <DialogDescription>
                Paste a <strong>public</strong> key, e.g. the contents of <code className="text-xs">~/.ssh/id_ed25519.pub</code>. To make one:{' '}
                <code className="text-xs">ssh-keygen -t ed25519</code>
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-1.5">
              <Label htmlFor="key-name">Name</Label>
              <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Work laptop" maxLength={60} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-pub">Public key</Label>
              <Textarea id="key-pub" rows={4} value={publicKey} onChange={(e) => setPublicKey(e.target.value)} placeholder="ssh-ed25519 AAAA… you@laptop" className="font-mono text-xs" required />
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !publicKey.trim()}>
                {busy && <Loader2 className="me-1.5 size-4 animate-spin" />} Add key
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
