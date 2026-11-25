'use client'

/**
 * Dialogs for the file manager's server-side actions: permissions, copy /
 * move (with a folder picker), extract, compress and preview. Each dialog
 * sends its own request and reports the result through `onDone`, so
 * file-manager.tsx only decides which one is open.
 *
 * Endpoints (src/app/api/hosting/[id]/files/**):
 *   POST /files/<p>  { action:'chmod', mode } | { action:'chmod', recursive, dirMode, fileMode }
 *   POST /files/<p>  { action:'extract', destination, overwrite }
 *   POST /files      { action:'compress', path, items, name }
 *   POST /files      { action:'copy'|'move', items, destination }
 *   GET  /files/<p>?action=preview
 */
import { useCallback, useEffect, useId, useState, type ComponentProps } from 'react'
import { AlertTriangle, ChevronRight, CornerLeftUp, Download, Folder, FolderOpen, Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { EmptyState, InlineError, jsonHeaders } from './shared'
import {
  defaultZipName,
  describeOctal,
  encodePath,
  gridFromOctal,
  isManagedFile,
  joinPath,
  octalFromGrid,
  parentOf,
  previewKind,
  toOctal,
  validateName,
  validateOctalMode,
  type FileEntry,
  type PermBit,
  type PermWho,
} from './file-utils'

type CloseFocus = ComponentProps<typeof DialogContent>['onCloseAutoFocus']

interface BaseProps {
  /** `/api/hosting/<id>/files` */
  base: string
  onClose: () => void
  /** Called with the success message; the caller refreshes the listing. */
  onDone: (message: string) => void
  onCloseAutoFocus?: CloseFocus
}

/** POST JSON, resolve with the message or throw the API's error. */
async function postJson(url: string, body: unknown): Promise<{ message?: string; failed?: Array<{ path: string; error: string }> }> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify(body) })
  } catch {
    throw new Error('Network error. Check your connection and try again.')
  }
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || `The server answered ${res.status}.`)
  return data ?? {}
}

function FieldError({ id, children }: { id: string; children: string | null }) {
  if (!children) return null
  return (
    <p id={id} role="alert" className="text-xs text-red-700 dark:text-red-300">
      {children}
    </p>
  )
}

/** A checkbox with a real label (and optional hint), so it has an accessible name. */
function CheckboxField({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  const id = useId()
  return (
    <div className="flex items-start gap-2 text-sm">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <div className="grid gap-0.5">
        <Label htmlFor={id} className="font-normal leading-snug">
          {label}
        </Label>
        {hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── Permissions ─────────────────────────────────────────────────────────

const WHO: Array<{ id: PermWho; label: string }> = [
  { id: 'owner', label: 'Owner' },
  { id: 'group', label: 'Group' },
  { id: 'others', label: 'Everyone' },
]
const BITS: Array<{ id: PermBit; label: string }> = [
  { id: 'read', label: 'Read' },
  { id: 'write', label: 'Write' },
  { id: 'execute', label: 'Run' },
]

/** Octal field plus the read / write / run checkbox grid, kept in sync. */
function ModeEditor({ id, label, value, onChange, error }: { id: string; label: string; value: string; onChange: (v: string) => void; error: string | null }) {
  const valid = /^[0-7]{3}$/.test(value)
  const grid = gridFromOctal(valid ? value : '000')
  const set = (who: PermWho, bit: PermBit, on: boolean) => {
    const next = { ...grid, [who]: { ...grid[who], [bit]: on } }
    onChange(octalFromGrid(next))
  }
  return (
    <fieldset className="grid gap-3">
      <legend className="sr-only">{label}</legend>
      <div className="flex items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={id}>{label}</Label>
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value.replace(/[^0-7]/g, '').slice(0, 4))}
            inputMode="numeric"
            autoComplete="off"
            className="w-24 font-mono text-sm tabular-nums"
            aria-invalid={!!error}
            aria-describedby={`${id}-help${error ? ` ${id}-error` : ''}`}
          />
        </div>
        <p id={`${id}-help`} className="min-w-0 pb-2 text-xs text-muted-foreground">
          {valid ? describeOctal(value) : 'Three digits, 0–7.'}
        </p>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-muted-foreground">
            <th scope="col" className="py-1 text-start font-medium">
              <span className="sr-only">Who</span>
            </th>
            {BITS.map((b) => (
              <th key={b.id} scope="col" className="w-16 py-1 text-center font-medium">
                {b.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WHO.map((w) => (
            <tr key={w.id} className="border-t">
              <th scope="row" className="py-1.5 text-start font-normal">
                {w.label}
              </th>
              {BITS.map((b) => (
                <td key={b.id} className="py-1.5 text-center">
                  <Checkbox
                    checked={grid[w.id][b.id]}
                    disabled={!valid}
                    onCheckedChange={(v) => set(w.id, b.id, v === true)}
                    aria-label={`${w.label}: ${b.label.toLowerCase()} (${label.toLowerCase()})`}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </fieldset>
  )
}

export function PermissionsDialog({ base, entry, onClose, onDone, onCloseAutoFocus }: BaseProps & { entry: FileEntry | null }) {
  const id = useId()
  const isDir = entry?.type === 'directory'
  const [mode, setMode] = useState('644')
  const [recursive, setRecursive] = useState(false)
  const [fileMode, setFileMode] = useState('644')
  const [errors, setErrors] = useState<{ mode: string | null; fileMode: string | null; form: string | null }>({ mode: null, fileMode: null, form: null })
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!entry) return
    setMode(toOctal(entry.permissions) ?? (entry.type === 'directory' ? '755' : '644'))
    setRecursive(false)
    setFileMode('644')
    setErrors({ mode: null, fileMode: null, form: null })
  }, [entry])

  const submit = async () => {
    if (!entry) return
    const m = validateOctalMode(mode)
    const f = recursive ? validateOctalMode(fileMode) : ({ ok: true, mode: fileMode } as const)
    if (!m.ok || !f.ok) {
      setErrors({ mode: m.ok ? null : m.error, fileMode: f.ok ? null : f.error, form: null })
      return
    }
    setBusy(true)
    setErrors({ mode: null, fileMode: null, form: null })
    try {
      const body = recursive ? { action: 'chmod', recursive: true, dirMode: m.mode, fileMode: f.mode } : { action: 'chmod', mode: m.mode }
      const data = await postJson(`${base}/${encodePath(entry.path)}`, body)
      onDone(data.message || `Permissions of ${entry.name} changed`)
    } catch (err) {
      setErrors({ mode: null, fileMode: null, form: err instanceof Error ? err.message : 'Permissions were not changed.' })
    } finally {
      setBusy(false)
    }
  }

  const worldWritable = /^[0-7]{2}[2367]$/.test(mode) || (recursive && /^[0-7]{2}[2367]$/.test(fileMode))

  return (
    <Dialog open={!!entry} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>Change permissions</DialogTitle>
            <DialogDescription>
              <span className="font-mono">/{entry?.path}</span>
              {entry?.permissions && <span className="ms-2 font-mono opacity-70">now {entry.permissions}</span>}
            </DialogDescription>
          </DialogHeader>
          <ModeEditor id={`${id}-mode`} label={recursive ? 'Folders' : 'Mode'} value={mode} onChange={(v) => { setMode(v); setErrors((e) => ({ ...e, mode: null })) }} error={errors.mode} />
          {isDir && (
            <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
              <CheckboxField
                checked={recursive}
                onChange={setRecursive}
                label="Also apply to everything inside"
                hint="Folders get the mode above, files the one below. Links are skipped."
              />
              {recursive && (
                <ModeEditor id={`${id}-file`} label="Files" value={fileMode} onChange={(v) => { setFileMode(v); setErrors((e) => ({ ...e, fileMode: null })) }} error={errors.fileMode} />
              )}
            </div>
          )}
          {worldWritable && (
            <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              <ShieldAlert className="size-4 shrink-0" aria-hidden />
              Everyone on the server will be able to change this. Websites rarely need that.
            </p>
          )}
          <FieldError id={`${id}-form`}>{errors.form}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Apply
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Folder picker ───────────────────────────────────────────────────────

/**
 * Browse the site's folders and pick one. `blocked` paths (and anything
 * inside them) cannot be opened or chosen — e.g. the folders being moved.
 */
export function FolderPicker({
  base,
  value,
  onChange,
  blocked = [],
  label = 'Destination folder',
}: {
  base: string
  value: string
  onChange: (path: string) => void
  blocked?: string[]
  label?: string
}) {
  const [folders, setFolders] = useState<FileEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)
  const headingId = useId()

  const load = useCallback(
    async (dir: string, signal?: AbortSignal) => {
      setStatus('loading')
      try {
        const res = await fetch(`${base}${dir ? `?path=${encodeURIComponent(dir)}` : ''}`, { headers: jsonHeaders(), cache: 'no-store', signal })
        const data = await res.json().catch(() => null)
        if (!res.ok) throw new Error(data?.error || `The server answered ${res.status}.`)
        const list = ((data?.files || []) as FileEntry[])
          .filter((f) => f.type === 'directory')
          .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        setFolders(list)
        setStatus('ready')
        setError(null)
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        setStatus('error')
        setError(err instanceof Error ? err.message : 'Could not open this folder.')
      }
    },
    [base]
  )

  useEffect(() => {
    const ctl = new AbortController()
    load(value, ctl.signal)
    return () => ctl.abort()
  }, [value, load])

  const isBlocked = (p: string) => blocked.some((b) => p === b || p.startsWith(b + '/'))
  const crumbs = value ? value.split('/') : []

  return (
    <div className="grid gap-2">
      <p id={headingId} className="text-sm font-medium">
        {label}
      </p>
      <div className="overflow-hidden rounded-lg border">
        <div className="flex items-center gap-1 border-b bg-muted/40 px-2 py-1.5">
          <Button type="button" variant="ghost" size="icon" className="size-7 shrink-0" onClick={() => onChange(parentOf(value))} disabled={!value} aria-label="Up one folder">
            <CornerLeftUp aria-hidden />
          </Button>
          <ol className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-xs" aria-label="Current folder">
            <li>
              <button type="button" onClick={() => onChange('')} className="rounded px-1 py-0.5 font-sans hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                All files
              </button>
            </li>
            {crumbs.map((c, i) => {
              const target = crumbs.slice(0, i + 1).join('/')
              return (
                <li key={target} className="flex min-w-0 items-center">
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
                  <button
                    type="button"
                    onClick={() => onChange(target)}
                    aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                    className="max-w-[10rem] truncate rounded px-1 py-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=location]:font-medium"
                  >
                    {c}
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
        <div className="h-48 overflow-auto" aria-labelledby={headingId}>
          {status === 'loading' ? (
            <div className="space-y-1 p-2" aria-busy="true" aria-label="Loading folders">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full" />
              ))}
            </div>
          ) : status === 'error' ? (
            <div className="p-2">
              <InlineError title="Could not open this folder" message={error} onRetry={() => load(value)} />
            </div>
          ) : folders.length === 0 ? (
            <EmptyState icon={<FolderOpen />} title="No folders inside" className="py-6">
              Choose this folder, or go up.
            </EmptyState>
          ) : (
            <ul className="p-1">
              {folders.map((f) => {
                const blockedHere = isBlocked(f.path)
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => onChange(f.path)}
                      disabled={blockedHere}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-start font-mono text-[13px] hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Folder className="size-4 shrink-0 fill-indigo-100 text-indigo-600 dark:fill-indigo-900/50 dark:text-indigo-300" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      {blockedHere ? (
                        <span className="font-sans text-[11px] text-muted-foreground">selected</span>
                      ) : (
                        <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden />
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        Selected: <span className="font-mono text-foreground">/{value}</span>
      </p>
    </div>
  )
}

// ─── Copy / move ─────────────────────────────────────────────────────────

export function TransferDialog({
  base,
  op,
  items,
  startPath,
  onClose,
  onDone,
  onCloseAutoFocus,
}: BaseProps & { op: 'copy' | 'move' | null; items: FileEntry[]; startPath: string }) {
  const [dest, setDest] = useState(startPath)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errId = useId()

  useEffect(() => {
    if (op) {
      setDest(startPath)
      setError(null)
    }
  }, [op, startPath])

  const sources = items.map((i) => i.path)
  const sameFolder = items.length > 0 && items.every((i) => parentOf(i.path) === dest)
  const managed = op === 'move' ? items.filter((i) => isManagedFile(i) || (i.type === 'directory' && i.path === 'site')) : []
  const verb = op === 'copy' ? 'Copy' : 'Move'

  const submit = async () => {
    if (!op) return
    setBusy(true)
    setError(null)
    try {
      const data = await postJson(base, { action: op, items: sources, destination: dest })
      const failed = data.failed || []
      if (failed.length) {
        setError(`${failed.length} not ${op === 'copy' ? 'copied' : 'moved'}: ${failed.slice(0, 3).map((f) => `${f.path} (${f.error})`).join('; ')}`)
        // Partial success still changed the folder; report it and keep the dialog for the failures.
        onDone(data.message || `${verb} finished`)
        return
      }
      onDone(data.message || `${verb} finished`)
    } catch (err) {
      setError(err instanceof Error ? err.message : `${verb} failed.`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!op} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>
            {verb} {items.length === 1 ? items[0].name : `${items.length} items`}
          </DialogTitle>
          <DialogDescription>Choose the folder to {op} {items.length === 1 ? 'it' : 'them'} into. Nothing there is overwritten.</DialogDescription>
        </DialogHeader>
        <FolderPicker base={base} value={dest} onChange={setDest} blocked={items.filter((i) => i.type === 'directory').map((i) => i.path)} />
        {managed.length > 0 && (
          <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
            <ShieldAlert className="size-4 shrink-0" aria-hidden />
            {managed.map((m) => m.name).join(', ')} must stay where {managed.length === 1 ? 'it is' : 'they are'}; the platform will refuse to move {managed.length === 1 ? 'it' : 'them'}.
          </p>
        )}
        <FieldError id={errId}>{error}</FieldError>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {error ? 'Close' : 'Cancel'}
          </Button>
          <Button onClick={submit} disabled={busy || sameFolder} aria-describedby={error ? errId : undefined}>
            {busy && <Loader2 className="animate-spin" aria-hidden />}
            {sameFolder ? 'Already in this folder' : `${verb} here`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Extract ─────────────────────────────────────────────────────────────

export function ExtractDialog({ base, entry, onClose, onDone, onCloseAutoFocus }: BaseProps & { entry: FileEntry | null }) {
  const id = useId()
  const folderOf = entry ? parentOf(entry.path) : ''
  const stem = entry ? entry.name.replace(/\.(zip|tar|tar\.gz|tgz)$/i, '') : ''
  const [dest, setDest] = useState(folderOf)
  const [intoNew, setIntoNew] = useState(false)
  const [newName, setNewName] = useState(stem)
  const [overwrite, setOverwrite] = useState(false)
  const [busy, setBusy] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!entry) return
    setDest(parentOf(entry.path))
    setIntoNew(false)
    setNewName(entry.name.replace(/\.(zip|tar|tar\.gz|tgz)$/i, ''))
    setOverwrite(false)
    setError(null)
    setNameError(null)
  }, [entry])

  const target = intoNew ? joinPath(dest, newName.trim()) : dest

  const submit = async () => {
    if (!entry) return
    if (intoNew) {
      const problem = validateName(newName)
      if (problem) {
        setNameError(problem)
        return
      }
    }
    setBusy(true)
    setError(null)
    try {
      const data = await postJson(`${base}/${encodePath(entry.path)}`, { action: 'extract', destination: target, overwrite })
      onDone(data.message || `Extracted ${entry.name}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The archive was not extracted.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={!!entry} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg" onCloseAutoFocus={onCloseAutoFocus}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>Extract {entry?.name}</DialogTitle>
            <DialogDescription>
              Archives with links or paths outside the folder are refused. Up to 2 GB per archive, 4 GB unpacked.
            </DialogDescription>
          </DialogHeader>
          <FolderPicker base={base} value={dest} onChange={setDest} label="Extract into" />
          <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
            <CheckboxField checked={intoNew} onChange={setIntoNew} label="Put the files in a new folder" />
            {intoNew && (
              <div className="grid gap-1.5 ps-6">
                <Label htmlFor={`${id}-name`}>Folder name</Label>
                <Input
                  id={`${id}-name`}
                  value={newName}
                  onChange={(e) => {
                    setNewName(e.target.value)
                    setNameError(null)
                  }}
                  className="font-mono text-sm"
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? `${id}-name-error` : undefined}
                />
                <FieldError id={`${id}-name-error`}>{nameError}</FieldError>
              </div>
            )}
            <CheckboxField
              checked={overwrite}
              onChange={setOverwrite}
              label="Replace files that already exist"
              hint="Off: existing files are kept and only new ones are added."
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Files go to <span className="font-mono text-foreground">/{target}</span>
          </p>
          <FieldError id={`${id}-error`}>{error}</FieldError>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Extract
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Compress ────────────────────────────────────────────────────────────

export function CompressDialog({
  base,
  items,
  folder,
  open,
  onClose,
  onDone,
  onCloseAutoFocus,
}: BaseProps & { items: FileEntry[]; folder: string; open: boolean }) {
  const id = useId()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setName(defaultZipName(items.map((i) => i.path), folder))
      setError(null)
    }
    // Only when the dialog opens: the selection may re-render while it is open.
  }, [open])

  const submit = async () => {
    const problem = validateName(name)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const data = await postJson(base, { action: 'compress', path: folder, items: items.map((i) => i.path), name: name.trim() })
      onDone(data.message || `Created ${name.trim()}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The archive was not created.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" onCloseAutoFocus={onCloseAutoFocus}>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <DialogHeader>
            <DialogTitle>Compress to .zip</DialogTitle>
            <DialogDescription>
              {items.length === 1 ? (
                <span className="font-mono">{items[0].name}</span>
              ) : (
                `${items.length} items`
              )}{' '}
              into an archive in <span className="font-mono">/{folder}</span>. Up to 2 GB.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={`${id}-name`}>Archive name</Label>
            <Input
              id={`${id}-name`}
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                setError(null)
              }}
              className="font-mono text-sm"
              aria-invalid={!!error}
              aria-describedby={error ? `${id}-error` : undefined}
            />
            <FieldError id={`${id}-error`}>{error}</FieldError>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Loader2 className="animate-spin" aria-hidden />}
              Compress
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── Preview ─────────────────────────────────────────────────────────────

export function PreviewDialog({
  base,
  entry,
  onClose,
  onDownload,
  onCloseAutoFocus,
}: Omit<BaseProps, 'onDone'> & { entry: FileEntry | null; onDownload: (e: FileEntry) => void }) {
  const kind = entry ? previewKind(entry.name) : null
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [nonce, setNonce] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const src = entry ? `${base}/${encodePath(entry.path)}?action=preview&v=${nonce}` : ''

  useEffect(() => {
    setState('loading')
    setError(null)
  }, [entry, nonce])

  // An <img> error event carries no reason; ask the endpoint for its message.
  const explain = async () => {
    setState('error')
    try {
      const res = await fetch(src, { headers: jsonHeaders() })
      const data = await res.json().catch(() => null)
      setError(data?.error || (res.ok ? 'The browser could not display this image.' : `The server answered ${res.status}.`))
    } catch {
      setError('Network error. Check your connection and try again.')
    }
  }

  return (
    <Dialog open={!!entry} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[92dvh] max-w-[calc(100%-1rem)] flex-col gap-3 p-4 sm:max-w-4xl sm:p-6" onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader className="pe-8">
          <DialogTitle className="truncate font-mono text-base">{entry?.name}</DialogTitle>
          <DialogDescription className="truncate font-mono text-xs">/{entry?.path}</DialogDescription>
        </DialogHeader>
        <div className="relative flex min-h-64 flex-1 items-center justify-center overflow-auto rounded-md border bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px]">
          {state === 'loading' && <Skeleton className="absolute inset-0" aria-label="Loading preview" />}
          {state === 'error' ? (
            <div className="w-full p-4">
              <InlineError title="Could not show a preview" message={error} onRetry={() => setNonce((n) => n + 1)} />
            </div>
          ) : kind === 'pdf' ? (
            <iframe
              key={src}
              src={src}
              title={`Preview of ${entry?.name}`}
              className="h-[70dvh] w-full bg-white"
              onLoad={() => setState('ready')}
            />
          ) : kind === 'image' ? (
            <img
              key={src}
              src={src}
              alt={`Preview of ${entry?.name}`}
              className={cn('max-h-[70dvh] max-w-full object-contain', state !== 'ready' && 'invisible')}
              onLoad={() => setState('ready')}
              onError={explain}
            />
          ) : (
            <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <AlertTriangle className="size-4" aria-hidden /> This file type has no preview.
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => entry && onDownload(entry)}>
            <Download aria-hidden /> Download
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
