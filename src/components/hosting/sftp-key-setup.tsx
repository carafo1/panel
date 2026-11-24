'use client'

/**
 * Step 1 of SFTP setup: get a public key onto the account.
 *
 * Either the browser makes an Ed25519 pair (Web Crypto) and fills in the
 * public half, or the customer pastes one they already have. The private key
 * only ever lives in this component's memory until it is downloaded as a
 * local file; it is never sent, logged or stored.
 */
import { useEffect, useId, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Download, KeyRound, Loader2, ShieldAlert, Wand2 } from 'lucide-react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import { checkPublicKey, describeKey, generateEd25519KeyPair, KeyGenUnsupportedError } from '@/lib/sftp-keys'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SftpKeygenHelp } from '@/components/hosting/sftp-keygen-help'

type GenState =
  | { status: 'idle' }
  | { status: 'working' }
  | { status: 'ready'; fingerprint: string; downloaded: boolean }
  | { status: 'unsupported'; reason: string }

const today = () => new Date().toISOString().slice(0, 10)

function downloadFile(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function SftpKeySetup({ fileBase, onAdded }: { fileBase: string; onAdded: (keyId: string, privateFile: string | null) => void | Promise<void> }) {
  const [mode, setMode] = useState<'generate' | 'paste'>('generate')
  const [gen, setGen] = useState<GenState>({ status: 'idle' })
  const [name, setName] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [showErrors, setShowErrors] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Memory only: cleared once saved, on a new key, and when this unmounts.
  const privateKey = useRef<string | null>(null)
  useEffect(() => () => void (privateKey.current = null), [])

  const ids = useId()
  const nameId = `${ids}-name`
  const keyId = `${ids}-key`
  const msgId = `${ids}-msg`
  const privateFile = `${fileBase}-sftp-ed25519.key`

  const check = publicKey.trim() ? checkPublicKey(publicKey) : null
  const generated = mode === 'generate' && gen.status === 'ready'
  const clientError = !publicKey.trim() ? (showErrors ? 'Paste your public key.' : null) : check && !check.ok && showErrors ? check.error : null
  const error = serverError ?? clientError

  const generate = async () => {
    setGen({ status: 'working' })
    setServerError(null)
    try {
      const pair = await generateEd25519KeyPair(`${fileBase}-sftp-${today()}`)
      privateKey.current = pair.privateKey
      setPublicKey(pair.publicKey)
      setName(`Browser key ${today()}`)
      setGen({ status: 'ready', fingerprint: pair.fingerprint, downloaded: false })
    } catch (e) {
      privateKey.current = null
      setGen({ status: 'unsupported', reason: e instanceof KeyGenUnsupportedError ? e.message : 'The browser could not create a key.' })
    }
  }

  const download = () => {
    if (!privateKey.current || gen.status !== 'ready') return
    downloadFile(privateKey.current, privateFile)
    setGen({ ...gen, downloaded: true })
  }

  const switchMode = (m: string) => {
    setMode(m as 'generate' | 'paste')
    setServerError(null)
    setShowErrors(false)
    if (m === 'paste' && gen.status === 'ready') {
      // A generated key belongs to the generator: don't carry it into the paste box.
      privateKey.current = null
      setGen({ status: 'idle' })
      setPublicKey('')
      setName('')
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setShowErrors(true)
    setServerError(null)
    if (!check?.ok) return
    if (generated && !gen.downloaded) {
      setServerError('Download your private key first. Without it, this key cannot be used to sign in.')
      return
    }
    setBusy(true)
    try {
      const r = await apiFetch<{ key: { id: string } }>('/user/ssh-keys', { method: 'POST', body: JSON.stringify({ name: name.trim(), publicKey: publicKey.trim() }) })
      toast.success('SSH key saved to your account')
      const savedFile = generated ? privateFile : null
      privateKey.current = null
      setGen({ status: 'idle' })
      setPublicKey('')
      setName('')
      setShowErrors(false)
      await onAdded(r.key.id, savedFile)
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'Could not save the key')
    } finally {
      setBusy(false)
    }
  }

  const keyForm = (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor={keyId}>Public key</Label>
        <Textarea
          id={keyId}
          rows={3}
          value={publicKey}
          readOnly={generated}
          onChange={(e) => {
            setPublicKey(e.target.value)
            setServerError(null)
          }}
          onBlur={() => publicKey.trim() && setShowErrors(true)}
          onPaste={() => setShowErrors(true)}
          placeholder="ssh-ed25519 AAAA… you@laptop"
          className="break-all font-mono text-xs"
          aria-invalid={!!error}
          aria-describedby={msgId}
          spellCheck={false}
          autoComplete="off"
        />
        <div id={msgId} aria-live="polite" className="min-h-5 text-xs">
          {error ? (
            <p className="flex items-start gap-1.5 text-destructive">
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden /> {error}
            </p>
          ) : check?.ok ? (
            <p className="flex items-center gap-1.5 text-muted-foreground">
              <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              Valid {describeKey(check.type, check.bits)} public key{check.comment ? ` (${check.comment})` : ''}
            </p>
          ) : (
            <p className="text-muted-foreground">One line starting with ssh-ed25519, ecdsa-sha2-… or ssh-rsa (2048 bits or more).</p>
          )}
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={nameId}>Name</Label>
        <Input id={nameId} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work laptop" maxLength={60} />
      </div>
      <Button type="submit" disabled={busy || !publicKey.trim()}>
        {busy ? <Loader2 className="me-1.5 size-4 animate-spin" /> : <KeyRound className="me-1.5 size-4" />}
        Save key to my account
      </Button>
    </form>
  )

  return (
    <Tabs value={mode} onValueChange={switchMode}>
      <TabsList className="w-full sm:w-fit">
        <TabsTrigger value="generate">
          <Wand2 aria-hidden /> Create a key here
        </TabsTrigger>
        <TabsTrigger value="paste">
          <KeyRound aria-hidden /> I have a key
        </TabsTrigger>
      </TabsList>

      <TabsContent value="generate" className="space-y-4 pt-2">
        {gen.status === 'unsupported' ? (
          <div className="space-y-3">
            <p className="flex items-start gap-2 rounded-md border p-3 text-sm" role="status">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <span>
                {gen.reason} Make the key on your computer instead, then switch to <strong>I have a key</strong> and paste the public key.
              </span>
            </p>
            <SftpKeygenHelp fileBase={fileBase} />
          </div>
        ) : gen.status !== 'ready' ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your browser creates a new Ed25519 key pair on this device. You download the private key; only the public key is saved to your account.
            </p>
            <Button type="button" onClick={generate} disabled={gen.status === 'working'}>
              {gen.status === 'working' ? <Loader2 className="me-1.5 size-4 animate-spin" /> : <Wand2 className="me-1.5 size-4" />}
              Create key pair
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm" role="note">
              <p className="flex items-start gap-2 font-medium">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                Download your private key now. This is the only chance to get it.
              </p>
              <ul className="list-disc space-y-0.5 ps-10 text-muted-foreground">
                <li>Anyone with this file can change your website. Never email it, share it or upload it anywhere.</li>
                <li>It was made in your browser and is not stored by us, so we cannot send it again. If you lose it, create a new key.</li>
              </ul>
              <div className="flex flex-wrap items-center gap-2 ps-6">
                <Button type="button" variant={gen.downloaded ? 'outline' : 'default'} onClick={download}>
                  <Download className="me-1.5 size-4" /> {gen.downloaded ? 'Download again' : 'Download private key'}
                </Button>
                <span className="font-mono text-xs text-muted-foreground">{privateFile}</span>
              </div>
              {gen.downloaded && (
                <p className="flex items-center gap-1.5 ps-6 text-xs text-muted-foreground" role="status">
                  <CheckCircle2 className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> Downloaded. Move it somewhere safe, then save the public key below.
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
              <span>Fingerprint</span>
              <code className="break-all font-mono">{gen.fingerprint}</code>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => navigator.clipboard.writeText(publicKey).then(() => toast.success('Public key copied'), () => toast.error('Could not copy'))}
              >
                <Copy className="me-1 size-3.5" /> Copy public key
              </Button>
            </div>
            {keyForm}
            <button type="button" className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={generate}>
              Discard and create a different key
            </button>
          </div>
        )}
      </TabsContent>

      <TabsContent value="paste" className="space-y-4 pt-2">
        {keyForm}
        <details className="group rounded-md border p-3">
          <summary className="cursor-pointer text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            No key yet? Make one on your computer
          </summary>
          <div className="pt-3">
            <SftpKeygenHelp fileBase={fileBase} />
          </div>
        </details>
      </TabsContent>
    </Tabs>
  )
}
