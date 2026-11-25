'use client'

/**
 * Website file manager.
 *
 * Shows every file of the website, dotfiles included. It opens in the
 * website's document root (site/, where WordPress and imported sites live)
 * and the breadcrumb goes up to the deploy path, where the platform files
 * (docker-compose.yml, Dockerfile, ...) sit. Those are marked "Managed by
 * Apsamo" and need a confirmation before they are edited or deleted.
 *
 * Endpoints (src/app/api/hosting/[id]/files/**), used exactly as they are:
 *   GET    /files?path=<dir>                    list
 *   GET    /files?action=export&path=<dir>      folder as .zip / .tar.gz
 *   POST   /files  multipart file+path          upload
 *   POST   /files  multipart file+path+action=import   upload and extract
 *   POST   /files  JSON { action:'mkdir', path }        new folder
 *   GET    /files/<p>?action=download|content   download / read text
 *   PUT    /files/<p>  { content }              save (also creates)
 *   POST   /files/<p>  { action:'rename', newPath }
 *   DELETE /files/<p>
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronRight,
  CornerLeftUp,
  Download,
  File as FileIcon,
  FileCode2,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Link2,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { PROXY_BODY_LIMIT_BYTES, formatMegabytes } from '@/lib/request-limits'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { EmptyState, InlineError, formatDate, jsonHeaders, timeAgo } from './shared'
import {
  DOCUMENT_ROOT_DIR,
  encodePath,
  fileKind,
  formatBytes,
  isLikelyTextFile,
  isManagedFile,
  joinPath,
  parentOf,
  sortEntries,
  toOctal,
  validateName,
  type FileEntry,
  type SortDir,
  type SortKey,
} from './file-utils'

type ListResult = { ok: true; files: FileEntry[] } | { ok: false; error: string }

interface UploadItem {
  id: number
  name: string
  progress: number
  state: 'uploading' | 'done' | 'error'
  error?: string
}

const KIND_ICON = {
  folder: Folder,
  link: Link2,
  code: FileCode2,
  image: FileImage,
  archive: Archive,
  text: FileText,
  other: FileIcon,
} as const

function EntryIcon({ entry }: { entry: FileEntry }) {
  const kind = fileKind(entry)
  const Icon = KIND_ICON[kind]
  return (
    <Icon
      aria-hidden
      className={cn('size-4 shrink-0', kind === 'folder' ? 'fill-indigo-100 text-indigo-600 dark:fill-indigo-900/50 dark:text-indigo-300' : 'text-muted-foreground')}
    />
  )
}

function ManagedBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant="outline"
          tabIndex={0}
          className="h-5 cursor-help gap-1 border-amber-300 bg-amber-50 px-1.5 text-[11px] font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
        >
          <ShieldAlert aria-hidden />
          <span className="hidden sm:inline">Managed by Apsamo</span>
          <span className="sm:hidden">Managed</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">
        The platform writes this file to run your site. Edits can break the site and may be replaced on the next deploy.
      </TooltipContent>
    </Tooltip>
  )
}

/** Sends one multipart upload with progress; resolves with the API's answer. */
function xhrUpload(
  url: string,
  form: FormData,
  onProgress: (pct: number) => void
): Promise<{ ok: boolean; message?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url) // the session cookie authenticates it
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) resolve({ ok: true, message: data.message })
        else resolve({ ok: false, error: data.error || data.message || 'Upload failed' })
      } catch {
        // A proxy refusing the body (413, 502) answers with HTML; the status is the useful part.
        resolve({
          ok: false,
          error:
            xhr.status >= 200 && xhr.status < 300
              ? 'Upload succeeded but the server response could not be read.'
              : `Upload failed (HTTP ${xhr.status || 'no response'}).`,
        })
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    xhr.send(form)
  })
}

async function saveBlob(res: Response, fallbackName: string) {
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') || ''
  const match = cd.match(/filename="?([^"]+)"?/)
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = match?.[1] || fallbackName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function FileManager({ projectId }: { projectId: string }) {
  const base = `/api/hosting/${projectId}/files`

  // ── Listing ──────────────────────────────────────────────────────────
  const [path, setPath] = useState('')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [docRoot, setDocRoot] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [announce, setAnnounce] = useState('')
  const requestSeq = useRef(0)

  const fetchList = useCallback(
    async (dir: string): Promise<ListResult> => {
      try {
        const qs = dir ? `?path=${encodeURIComponent(dir)}` : ''
        const res = await fetch(`${base}${qs}`, { headers: jsonHeaders(), cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (!res.ok) return { ok: false, error: data?.error || `The server answered ${res.status}.` }
        return { ok: true, files: (data?.files || []) as FileEntry[] }
      } catch {
        return { ok: false, error: 'Network error. Check your connection and try again.' }
      }
    },
    [base]
  )

  const load = useCallback(
    async (dir: string, opts: { quiet?: boolean } = {}) => {
      const seq = ++requestSeq.current
      if (!opts.quiet) setStatus('loading')
      const result = await fetchList(dir)
      if (seq !== requestSeq.current) return
      if (result.ok) {
        setEntries(result.files)
        setPath(dir)
        setStatus('ready')
        setLoadError(null)
        setAnnounce(`${result.files.length} item${result.files.length === 1 ? '' : 's'} in ${dir || 'all files'}`)
      } else {
        setPath(dir)
        setStatus('error')
        setLoadError(result.error)
      }
    },
    [fetchList]
  )

  // First visit: open the document root when the site has one.
  useEffect(() => {
    let cancelled = false
    const seq = ++requestSeq.current
    ;(async () => {
      const root = await fetchList('')
      if (cancelled || seq !== requestSeq.current) return
      if (!root.ok) {
        setStatus('error')
        setLoadError(root.error)
        return
      }
      const hasDocRoot = root.files.some((f) => f.type === 'directory' && f.name === DOCUMENT_ROOT_DIR)
      if (hasDocRoot) {
        setDocRoot(DOCUMENT_ROOT_DIR)
        await load(DOCUMENT_ROOT_DIR)
      } else {
        setEntries(root.files)
        setPath('')
        setStatus('ready')
        setAnnounce(`${root.files.length} items`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchList, load])

  const navigate = (dir: string) => {
    if (dir.split('/').includes('..')) return
    setSelected(new Set())
    setFilter('')
    load(dir)
  }
  const refresh = () => load(path, { quiet: status === 'ready' })

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
    return sortEntries(list, sortKey, sortDir)
  }, [entries, filter, sortKey, sortDir])

  const totals = useMemo(() => {
    const folders = entries.filter((e) => e.type === 'directory').length
    const bytes = entries.reduce((n, e) => n + (e.type === 'file' ? e.size || 0 : 0), 0)
    return { folders, files: entries.length - folders, bytes }
  }, [entries])

  const setSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc')
    }
  }

  // ── Selection ────────────────────────────────────────────────────────
  const selectedEntries = visible.filter((e) => selected.has(e.path))
  const allSelected = visible.length > 0 && selectedEntries.length === visible.length
  const toggle = (p: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map((e) => e.path)))

  // ── Upload ───────────────────────────────────────────────────────────
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const uploadSeq = useRef(0)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)
  const [dragDepth, setDragDepth] = useState(0)
  const uploading = uploads.some((u) => u.state === 'uploading')

  const patchUpload = (id: number, patch: Partial<UploadItem>) =>
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)))

  const uploadFiles = async (files: File[], opts: { extract?: boolean } = {}) => {
    const target = path
    let okCount = 0
    for (const file of files) {
      const id = ++uploadSeq.current
      // The server refuses anything over the proxy limit; say so before sending it.
      if (file.size > PROXY_BODY_LIMIT_BYTES) {
        const error = `${file.name} is too large to upload here (max ${formatMegabytes(PROXY_BODY_LIMIT_BYTES)}). Use SFTP access, or Import Site for a full website archive.`
        setUploads((list) => [...list, { id, name: file.name, progress: 0, state: 'error', error }])
        toast.error(error)
        continue
      }
      setUploads((list) => [...list, { id, name: file.name, progress: 0, state: 'uploading' }])
      const form = new FormData()
      form.append('file', file)
      form.append('path', target)
      if (opts.extract) form.append('action', 'import')
      try {
        const result = await xhrUpload(base, form, (pct) => patchUpload(id, { progress: pct }))
        if (result.ok) {
          okCount++
          patchUpload(id, { state: 'done', progress: 100 })
          const msg = opts.extract ? result.message || `Extracted ${file.name}` : `Uploaded ${file.name}`
          toast.success(msg)
          setAnnounce(msg)
        } else {
          patchUpload(id, { state: 'error', error: result.error })
          toast.error(result.error || 'Upload failed')
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : 'Upload failed'
        patchUpload(id, { state: 'error', error })
        toast.error(error)
      }
    }
    if (okCount > 0) load(target, { quiet: true })
    // Finished rows clear themselves; failures stay until dismissed.
    setTimeout(() => setUploads((list) => list.filter((u) => u.state !== 'done')), 4000)
  }

  // ── Download / export ────────────────────────────────────────────────
  const [downloading, setDownloading] = useState<string | null>(null)
  const download = async (entry: FileEntry) => {
    setDownloading(entry.path)
    try {
      const url =
        entry.type === 'directory'
          ? `${base}?action=export&path=${encodeURIComponent(entry.path)}`
          : `${base}/${encodePath(entry.path)}?action=download`
      const res = await fetch(url, { headers: jsonHeaders() })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error || 'Download failed')
      }
      await saveBlob(res, entry.type === 'directory' ? `${entry.name}.zip` : entry.name)
      setAnnounce(`Downloading ${entry.name}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setDownloading(null)
    }
  }
  const downloadFolder = () =>
    download({
      name: path ? path.split('/').pop() || 'website' : 'website',
      path,
      type: 'directory',
      size: 0,
      modifiedAt: '',
      permissions: '',
    })

  // ── Editor ───────────────────────────────────────────────────────────
  const [editor, setEditor] = useState<{
    entry: FileEntry
    content: string
    original: string
    truncated: boolean
    loading: boolean
    error: string | null
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [managedConfirm, setManagedConfirm] = useState<FileEntry | null>(null)
  const dirty = !!editor && !editor.loading && editor.content !== editor.original

  const openEditor = async (entry: FileEntry, opts: { confirmed?: boolean } = {}) => {
    if (isManagedFile(entry) && !opts.confirmed) {
      setManagedConfirm(entry)
      return
    }
    setEditor({ entry, content: '', original: '', truncated: false, loading: true, error: null })
    try {
      const res = await fetch(`${base}/${encodePath(entry.path)}?action=content`, { headers: jsonHeaders() })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || 'Could not open this file.')
      setEditor((e) =>
        e && e.entry.path === entry.path
          ? { ...e, content: data.content || '', original: data.content || '', truncated: !!data.truncated, loading: false }
          : e
      )
    } catch (err) {
      setEditor((e) =>
        e && e.entry.path === entry.path
          ? { ...e, loading: false, error: err instanceof Error ? err.message : 'Could not open this file.' }
          : e
      )
    }
  }

  const saveEditor = async () => {
    if (!editor || editor.truncated || !dirty) return
    setSaving(true)
    try {
      const res = await fetch(`${base}/${encodePath(editor.entry.path)}`, {
        method: 'PUT',
        headers: jsonHeaders(),
        body: JSON.stringify({ content: editor.content }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error || 'Could not save the file.')
      setEditor((e) => (e ? { ...e, original: e.content } : e))
      toast.success(`Saved ${editor.entry.name}`)
      setAnnounce(`Saved ${editor.entry.name}`)
      load(path, { quiet: true })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save the file.')
    } finally {
      setSaving(false)
    }
  }

  const closeEditor = (force = false) => {
    if (!force && dirty) {
      setConfirmDiscard(true)
      return
    }
    if (confirmDiscard) {
      // Drop the edits first (so the editor is no longer dirty if it sees an
      // outside interaction), and let the confirmation finish closing before
      // the editor does: closing both modals in one render leaves Radix's
      // `pointer-events: none` on <body>.
      setConfirmDiscard(false)
      setEditor((e) => (e ? { ...e, content: e.original } : e))
      window.setTimeout(() => setEditor(null), 200)
      return
    }
    setEditor(null)
  }

  const onEditorKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      saveEditor()
    }
    // Tab inserts two spaces instead of leaving the editor; Esc still closes.
    if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart, selectionEnd, value } = el
      const next = value.slice(0, selectionStart) + '  ' + value.slice(selectionEnd)
      setEditor((ed) => (ed ? { ...ed, content: next } : ed))
      requestAnimationFrame(() => el.setSelectionRange(selectionStart + 2, selectionStart + 2))
    }
  }

  // ── Create / rename ──────────────────────────────────────────────────
  const [nameDialog, setNameDialog] = useState<
    { mode: 'folder' } | { mode: 'file' } | { mode: 'rename'; entry: FileEntry } | null
  >(null)
  const [nameValue, setNameValue] = useState('')
  const [nameError, setNameError] = useState<string | null>(null)
  const [nameBusy, setNameBusy] = useState(false)

  const openNameDialog = (d: NonNullable<typeof nameDialog>) => {
    setNameDialog(d)
    setNameValue(d.mode === 'rename' ? d.entry.name : '')
    setNameError(null)
  }

  const submitName = async () => {
    if (!nameDialog) return
    const existing = entries
      .map((e) => e.name)
      .filter((n) => nameDialog.mode !== 'rename' || n !== nameDialog.entry.name)
    const problem = validateName(nameValue, existing)
    if (problem) {
      setNameError(problem)
      return
    }
    const name = nameValue.trim()
    if (nameDialog.mode === 'rename' && name === nameDialog.entry.name) {
      setNameDialog(null)
      return
    }
    setNameBusy(true)
    try {
      let res: Response
      if (nameDialog.mode === 'folder') {
        res = await fetch(base, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ action: 'mkdir', path: joinPath(path, name) }),
        })
      } else if (nameDialog.mode === 'file') {
        res = await fetch(`${base}/${encodePath(joinPath(path, name))}`, {
          method: 'PUT',
          headers: jsonHeaders(),
          body: JSON.stringify({ content: '' }),
        })
      } else {
        const entry = nameDialog.entry
        res = await fetch(`${base}/${encodePath(entry.path)}`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ action: 'rename', newPath: joinPath(parentOf(entry.path), name) }),
        })
      }
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setNameError(data?.error || 'That did not work. Try again.')
        return
      }
      const verb = nameDialog.mode === 'folder' ? 'Created folder' : nameDialog.mode === 'file' ? 'Created' : 'Renamed to'
      toast.success(`${verb} ${name}`)
      setAnnounce(`${verb} ${name}`)
      const createdFile = nameDialog.mode === 'file'
      setNameDialog(null)
      await load(path, { quiet: true })
      if (createdFile && isLikelyTextFile(name)) {
        openEditor({ name, path: joinPath(path, name), type: 'file', size: 0, modifiedAt: new Date().toISOString(), permissions: '' })
      }
    } catch {
      setNameError('Network error. Try again.')
    } finally {
      setNameBusy(false)
    }
  }

  // ── Delete ───────────────────────────────────────────────────────────
  const [toDelete, setToDelete] = useState<FileEntry[] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const deletesManaged = !!toDelete?.some((e) => isManagedFile(e))
  const deletesDocRoot = !!toDelete?.some((e) => !e.path.includes('/') && e.name === docRoot && e.type === 'directory')

  const confirmDelete = async () => {
    if (!toDelete) return
    setDeleting(true)
    const failed: string[] = []
    for (const entry of toDelete) {
      try {
        const res = await fetch(`${base}/${encodePath(entry.path)}`, { method: 'DELETE', headers: jsonHeaders() })
        if (!res.ok) {
          const data = await res.json().catch(() => null)
          failed.push(`${entry.name}: ${data?.error || 'not deleted'}`)
        }
      } catch {
        failed.push(`${entry.name}: network error`)
      }
    }
    const done = toDelete.length - failed.length
    if (done > 0) {
      const msg = done === 1 && toDelete.length === 1 ? `Deleted ${toDelete[0].name}` : `Deleted ${done} item${done === 1 ? '' : 's'}`
      toast.success(msg)
      setAnnounce(msg)
    }
    if (failed.length) toast.error(`${failed.length} could not be deleted`, { description: failed.slice(0, 3).join(' · ') })
    setDeleting(false)
    setToDelete(null)
    setSelected(new Set())
    load(path, { quiet: true })
  }

  // ── Row activation ───────────────────────────────────────────────────
  const activate = (entry: FileEntry) => {
    if (entry.type === 'directory') navigate(entry.path)
    else if (entry.type === 'file' && isLikelyTextFile(entry.name)) openEditor(entry)
    else download(entry)
  }

  const crumbs = path ? path.split('/') : []
  const atRoot = path === ''

  // ── Render ───────────────────────────────────────────────────────────
  return (
    <section
      aria-labelledby="files-heading"
      className="relative overflow-hidden rounded-xl border bg-card"
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragDepth((d) => d + 1)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
      onDrop={(e) => {
        e.preventDefault()
        setDragDepth(0)
        const files = Array.from(e.dataTransfer.files || [])
        if (files.length) uploadFiles(files)
      }}
    >
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files || [])
          e.target.value = ''
          if (files.length) uploadFiles(files)
        }}
      />
      <input
        ref={archiveInputRef}
        type="file"
        accept=".zip,.tar.gz,.tgz,.tar"
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) uploadFiles([f], { extract: true })
        }}
      />

      {/* Header + toolbar */}
      <div className="flex flex-col gap-3 border-b p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 id="files-heading" className="flex items-center gap-2 text-base font-semibold">
              <HardDrive className="size-4 text-primary" aria-hidden />
              File manager
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every file of your website. Uploads up to {formatMegabytes(PROXY_BODY_LIMIT_BYTES)} each; drag files anywhere here to upload.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={status === 'error' && !entries.length}>
              {uploading ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
              Upload
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline">
                  <Plus aria-hidden />
                  New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => openNameDialog({ mode: 'folder' })}>
                  <FolderPlus aria-hidden /> New folder
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => openNameDialog({ mode: 'file' })}>
                  <FilePlus aria-hidden /> New file
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="outline" className="size-8" aria-label="More file actions">
                  <MoreHorizontal aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onSelect={() => archiveInputRef.current?.click()}>
                  <Archive aria-hidden /> Upload and extract archive…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={downloadFolder} disabled={downloading === path}>
                  <Download aria-hidden /> Download this folder as .zip
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={refresh}>
                  <RefreshCw aria-hidden /> Refresh
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Breadcrumbs + filter */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <nav aria-label="Folder path" className="flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0"
              onClick={() => navigate(parentOf(path))}
              disabled={atRoot}
              aria-label="Up one folder"
            >
              <CornerLeftUp aria-hidden />
            </Button>
            <ol className="flex min-w-0 flex-wrap items-center gap-0.5 font-mono text-[13px]">
              <li>
                <button
                  type="button"
                  onClick={() => navigate('')}
                  aria-current={atRoot ? 'location' : undefined}
                  className={cn(
                    'rounded px-1.5 py-1 font-sans text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    atRoot ? 'font-medium text-foreground' : 'text-muted-foreground'
                  )}
                >
                  All files
                </button>
              </li>
              {crumbs.map((c, i) => {
                const target = crumbs.slice(0, i + 1).join('/')
                const current = i === crumbs.length - 1
                return (
                  <li key={target} className="flex min-w-0 items-center">
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
                    <button
                      type="button"
                      onClick={() => navigate(target)}
                      aria-current={current ? 'location' : undefined}
                      className={cn(
                        'max-w-[12rem] truncate rounded px-1.5 py-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        current ? 'font-medium text-foreground' : 'text-muted-foreground'
                      )}
                    >
                      {c}
                    </button>
                    {target === docRoot && (
                      <span className="ms-1 rounded bg-indigo-50 px-1.5 py-0.5 font-sans text-[11px] font-medium text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-200">
                        Website root
                      </span>
                    )}
                  </li>
                )
              })}
            </ol>
          </nav>
          <div className="relative sm:w-56">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter this folder"
              aria-label="Filter files in this folder"
              className="h-8 ps-8 text-sm"
            />
          </div>
        </div>

        {atRoot && docRoot && status === 'ready' && (
          <div className="flex flex-col gap-2 rounded-lg border border-dashed bg-muted/40 p-3 text-sm sm:flex-row sm:items-center">
            <p className="flex-1 text-muted-foreground">
              This is your whole hosting space. The files visitors see are in{' '}
              <span className="font-mono text-foreground">{docRoot}/</span>; the rest run the site.
            </p>
            <Button size="sm" variant="outline" onClick={() => navigate(docRoot)}>
              <FolderOpen aria-hidden /> Open {docRoot}/
            </Button>
          </div>
        )}

        {uploads.length > 0 && (
          <ul className="space-y-2" aria-label="Uploads">
            {uploads.map((u) => (
              <li key={u.id} className="rounded-md border bg-background px-3 py-2 text-sm">
                <div className="flex items-center gap-2">
                  {u.state === 'uploading' ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden />
                  ) : u.state === 'done' ? (
                    <Upload className="size-3.5 shrink-0 text-emerald-600" aria-hidden />
                  ) : (
                    <AlertTriangle className="size-3.5 shrink-0 text-red-600" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{u.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {u.state === 'uploading' ? `${u.progress}%` : u.state === 'done' ? 'Uploaded' : 'Failed'}
                  </span>
                  {u.state === 'error' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      aria-label={`Dismiss ${u.name}`}
                      onClick={() => setUploads((l) => l.filter((x) => x.id !== u.id))}
                    >
                      <X className="size-3.5" aria-hidden />
                    </Button>
                  )}
                </div>
                {u.state === 'uploading' && <Progress value={u.progress} className="mt-1.5 h-1" aria-label={`Uploading ${u.name}`} />}
                {u.state === 'error' && u.error && <p className="mt-1 text-xs text-red-700 dark:text-red-300">{u.error}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Selection bar */}
      {selectedEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b bg-indigo-50/60 px-4 py-2 text-sm dark:bg-indigo-950/30">
          <span className="font-medium">{selectedEntries.length} selected</span>
          <div className="ms-auto flex items-center gap-1.5">
            {selectedEntries.length === 1 && (
              <Button size="sm" variant="outline" className="bg-background" onClick={() => download(selectedEntries[0])}>
                <Download aria-hidden /> Download
              </Button>
            )}
            <Button size="sm" variant="outline" className="bg-background text-red-700 hover:text-red-800 dark:text-red-300" onClick={() => setToDelete(selectedEntries)}>
              <Trash2 aria-hidden /> Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </div>
      )}

      {/* Listing */}
      <div className="max-h-[min(70vh,44rem)] overflow-auto">
        {status === 'loading' ? (
          <div className="space-y-px p-4" aria-busy="true" aria-label="Loading files">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        ) : status === 'error' ? (
          <div className="p-4">
            <InlineError title="Could not open this folder" message={loadError} onRetry={() => load(path)} />
          </div>
        ) : visible.length === 0 ? (
          filter ? (
            <EmptyState icon={<Search />} title={`Nothing here matches “${filter}”`}>
              <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => setFilter('')}>
                Clear the filter
              </button>
            </EmptyState>
          ) : (
            <EmptyState
              icon={<FolderOpen />}
              title="This folder is empty"
              action={
                <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                  <Upload aria-hidden /> Upload files
                </Button>
              }
            >
              Drop files here, or upload them from your computer.
            </EmptyState>
          )
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Files in {path || 'all files'}</caption>
            <thead className="sticky top-0 z-10 bg-card/95 text-xs text-muted-foreground backdrop-blur">
              <tr className="border-b">
                <th scope="col" className="w-10 py-2 ps-4">
                  <Checkbox
                    checked={allSelected ? true : selectedEntries.length > 0 ? 'indeterminate' : false}
                    onCheckedChange={toggleAll}
                    aria-label="Select all in this folder"
                  />
                </th>
                <SortHeader label="Name" k="name" sortKey={sortKey} sortDir={sortDir} onSort={setSort} />
                <SortHeader label="Size" k="size" sortKey={sortKey} sortDir={sortDir} onSort={setSort} className="hidden w-24 text-end md:table-cell" />
                <SortHeader label="Modified" k="modified" sortKey={sortKey} sortDir={sortDir} onSort={setSort} className="hidden w-36 md:table-cell" />
                <th scope="col" className="hidden w-40 px-3 py-2 text-start font-medium lg:table-cell">
                  Permissions
                </th>
                <th scope="col" className="w-12 pe-3">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const managed = isManagedFile(entry)
                const isSelected = selected.has(entry.path)
                const editable = entry.type === 'file' && isLikelyTextFile(entry.name)
                const octal = toOctal(entry.permissions)
                return (
                  <tr
                    key={entry.path}
                    data-state={isSelected ? 'selected' : undefined}
                    className="group border-b last:border-b-0 hover:bg-muted/50 data-[state=selected]:bg-indigo-50/70 dark:data-[state=selected]:bg-indigo-950/30"
                  >
                    <td className="py-1.5 ps-4 align-middle">
                      <Checkbox checked={isSelected} onCheckedChange={() => toggle(entry.path)} aria-label={`Select ${entry.name}`} />
                    </td>
                    <td className="max-w-0 px-3 py-1.5">
                      <div className="flex min-w-0 items-center gap-2">
                        <EntryIcon entry={entry} />
                        <button
                          type="button"
                          onClick={() => activate(entry)}
                          className="min-w-0 truncate rounded text-start font-mono text-[13px] hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          title={entry.type === 'directory' ? `Open ${entry.name}` : editable ? `Edit ${entry.name}` : `Download ${entry.name}`}
                        >
                          {entry.name}
                          {entry.type === 'directory' && <span className="text-muted-foreground">/</span>}
                        </button>
                        {managed && <ManagedBadge />}
                        {downloading === entry.path && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label="Downloading" />}
                      </div>
                      <div className="mt-0.5 ps-6 text-xs text-muted-foreground md:hidden">
                        {entry.type === 'directory' ? 'Folder' : formatBytes(entry.size)} · {timeAgo(entry.modifiedAt)}
                      </div>
                    </td>
                    <td className="hidden px-3 py-1.5 text-end tabular-nums text-muted-foreground md:table-cell">
                      {entry.type === 'directory' ? '—' : formatBytes(entry.size)}
                    </td>
                    <td className="hidden px-3 py-1.5 text-muted-foreground md:table-cell" title={formatDate(entry.modifiedAt)}>
                      {timeAgo(entry.modifiedAt)}
                    </td>
                    <td className="hidden whitespace-nowrap px-3 py-1.5 font-mono text-xs text-muted-foreground lg:table-cell" title={entry.permissions}>
                      {octal ?? entry.permissions ?? '—'}
                      {octal && <span className="ms-2 opacity-70">{entry.permissions}</span>}
                    </td>
                    <td className="pe-3 text-end">
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${entry.name}`}>
                            <MoreHorizontal aria-hidden />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          {entry.type === 'directory' && (
                            <DropdownMenuItem onSelect={() => navigate(entry.path)}>
                              <FolderOpen aria-hidden /> Open
                            </DropdownMenuItem>
                          )}
                          {editable && (
                            <DropdownMenuItem onSelect={() => openEditor(entry)}>
                              <Pencil aria-hidden /> Edit
                            </DropdownMenuItem>
                          )}
                          {entry.type !== 'symlink' && (
                            <DropdownMenuItem onSelect={() => download(entry)}>
                              <Download aria-hidden /> {entry.type === 'directory' ? 'Download as .zip' : 'Download'}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem onSelect={() => openNameDialog({ mode: 'rename', entry })}>
                            <FileText aria-hidden /> Rename
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="destructive" onSelect={() => setToDelete([entry])}>
                            <Trash2 aria-hidden /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {status === 'ready' && entries.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
          <span>
            {totals.folders} folder{totals.folders === 1 ? '' : 's'}, {totals.files} file{totals.files === 1 ? '' : 's'}
            {totals.bytes > 0 && ` · ${formatBytes(totals.bytes)}`}
            {filter && ` · showing ${visible.length}`}
          </span>
          <span>Larger than {formatMegabytes(PROXY_BODY_LIMIT_BYTES)}? Use SFTP below.</span>
        </div>
      )}

      {/* Drop overlay */}
      {dragDepth > 0 && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-background/85">
          <div className="text-center">
            <Upload className="mx-auto mb-2 size-6 text-primary" aria-hidden />
            <p className="text-sm font-medium">Drop to upload to <span className="font-mono">/{path}</span></p>
          </div>
        </div>
      )}

      {/* New folder / new file / rename */}
      <Dialog open={!!nameDialog} onOpenChange={(v) => !v && !nameBusy && setNameDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              submitName()
            }}
            className="grid gap-4"
          >
            <DialogHeader>
              <DialogTitle>
                {nameDialog?.mode === 'folder' ? 'New folder' : nameDialog?.mode === 'file' ? 'New file' : 'Rename'}
              </DialogTitle>
              <DialogDescription>
                {nameDialog?.mode === 'rename' ? (
                  <>
                    Renaming <span className="font-mono">{nameDialog.entry.path}</span>
                  </>
                ) : (
                  <>
                    Created in <span className="font-mono">/{path}</span>
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            {nameDialog?.mode === 'rename' && isManagedFile(nameDialog.entry) && (
              <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
                <ShieldAlert className="size-4 shrink-0" aria-hidden />
                The platform expects this file under its current name. Renaming it can stop the site from deploying.
              </p>
            )}
            <div className="grid gap-2">
              <Label htmlFor="fm-name">Name</Label>
              <Input
                id="fm-name"
                value={nameValue}
                onChange={(e) => {
                  setNameValue(e.target.value)
                  setNameError(null)
                }}
                onFocus={(e) => {
                  // Select the name without its extension, like a desktop file manager.
                  const v = e.currentTarget.value
                  const dot = v.lastIndexOf('.')
                  e.currentTarget.setSelectionRange(0, dot > 0 ? dot : v.length)
                }}
                placeholder={nameDialog?.mode === 'folder' ? 'images' : 'index.html'}
                className="font-mono text-sm"
                autoFocus
                aria-invalid={!!nameError}
                aria-describedby={nameError ? 'fm-name-error' : undefined}
              />
              {nameError && (
                <p id="fm-name-error" className="text-xs text-red-700 dark:text-red-300" role="alert">
                  {nameError}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setNameDialog(null)} disabled={nameBusy}>
                Cancel
              </Button>
              <Button type="submit" disabled={nameBusy || !nameValue.trim()}>
                {nameBusy && <Loader2 className="animate-spin" aria-hidden />}
                {nameDialog?.mode === 'rename' ? 'Rename' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!toDelete} onOpenChange={(v) => !v && !deleting && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {toDelete && toDelete.length === 1 ? (toDelete[0].type === 'directory' ? 'this folder' : 'this file') : `${toDelete?.length ?? 0} items`}?
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <ul className="max-h-32 space-y-0.5 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-xs text-foreground">
                  {toDelete?.slice(0, 8).map((e) => (
                    <li key={e.path} className="truncate">
                      {e.path}
                      {e.type === 'directory' && '/'}
                    </li>
                  ))}
                  {toDelete && toDelete.length > 8 && <li>…and {toDelete.length - 8} more</li>}
                </ul>
                <p>This cannot be undone. Folders are deleted with everything inside them. Take a backup first if you are unsure.</p>
                {(deletesManaged || deletesDocRoot) && (
                  <p className="flex gap-2 rounded-md border border-red-200 bg-red-50 p-2.5 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100">
                    <AlertTriangle className="size-4 shrink-0" aria-hidden />
                    {deletesDocRoot
                      ? `${docRoot}/ holds your whole website. Deleting it takes the site offline.`
                      : 'This includes files managed by Apsamo. Without them the site will not start or deploy.'}
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                confirmDelete()
              }}
              disabled={deleting}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleting ? <Loader2 className="animate-spin" aria-hidden /> : <Trash2 aria-hidden />}
              {deletesManaged || deletesDocRoot ? 'Delete anyway' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Managed-file edit warning */}
      <AlertDialog open={!!managedConfirm} onOpenChange={(v) => !v && setManagedConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-amber-600" aria-hidden />
              Edit a file managed by Apsamo?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono">{managedConfirm?.name}</span> is written by the platform to run your site. A mistake here can
              stop the site from starting, and the next deploy may replace your changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const entry = managedConfirm
                setManagedConfirm(null)
                if (entry) openEditor(entry, { confirmed: true })
              }}
            >
              Edit anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Editor */}
      <Dialog open={!!editor} onOpenChange={(v) => !v && closeEditor()}>
        <DialogContent className="flex h-[92dvh] max-w-[calc(100%-1rem)] flex-col gap-3 p-4 sm:h-[85vh] sm:max-w-5xl sm:p-6">
          <DialogHeader className="pe-8">
            <DialogTitle className="flex min-w-0 items-center gap-2 text-base">
              <span className="truncate font-mono">{editor?.entry.name}</span>
              {dirty && (
                <span className="shrink-0 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-900 dark:bg-amber-900/50 dark:text-amber-100">
                  Unsaved
                </span>
              )}
            </DialogTitle>
            <DialogDescription className="truncate font-mono text-xs">/{editor?.entry.path}</DialogDescription>
          </DialogHeader>
          {editor && isManagedFile(editor.entry) && (
            <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
              <ShieldAlert className="size-4 shrink-0" aria-hidden />
              Managed by Apsamo: the next deploy may overwrite changes to this file.
            </p>
          )}
          {editor?.truncated && (
            <p className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100" role="status">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              This file is too large to edit here, so only its beginning is shown and saving is turned off (saving would cut the file
              short). Download it or use SFTP instead.
            </p>
          )}
          <div className="min-h-0 flex-1">
            {editor?.loading ? (
              <Skeleton className="h-full w-full" />
            ) : editor?.error ? (
              <InlineError title="Could not open this file" message={editor.error} onRetry={() => openEditor(editor.entry, { confirmed: true })} />
            ) : (
              <textarea
                aria-label={`Contents of ${editor?.entry.name ?? 'file'}`}
                value={editor?.content ?? ''}
                onChange={(e) => {
                  const v = e.target.value
                  setEditor((ed) => (ed ? { ...ed, content: v } : ed))
                }}
                onKeyDown={onEditorKeyDown}
                readOnly={editor?.truncated}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                wrap="off"
                className="h-full w-full resize-none rounded-md border bg-zinc-950 p-3 font-mono text-[13px] leading-relaxed text-zinc-100 caret-indigo-300 selection:bg-indigo-500/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
          </div>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              {editor && !editor.loading && !editor.error && (
                <>
                  {editor.content.split('\n').length} lines · {formatBytes(new Blob([editor.content]).size)} · Ctrl+S to save
                </>
              )}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => closeEditor()} disabled={saving}>
                Close
              </Button>
              <Button onClick={saveEditor} disabled={saving || !dirty || !!editor?.truncated}>
                {saving ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
                Save
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits to <span className="font-mono">{editor?.entry.name}</span> have not been saved.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction className="bg-red-600 text-white hover:bg-red-700" onClick={() => closeEditor(true)}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function SortHeader({
  label,
  k,
  sortKey,
  sortDir,
  onSort,
  className,
}: {
  label: string
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onSort: (k: SortKey) => void
  className?: string
}) {
  const active = sortKey === k
  const Icon = !active ? ArrowUpDown : sortDir === 'asc' ? ArrowUp : ArrowDown
  return (
    <th
      scope="col"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={cn('px-3 py-2 text-start font-medium', className)}
    >
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cn(
          'inline-flex items-center gap-1 rounded hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          active && 'text-foreground'
        )}
      >
        {label}
        <Icon className={cn('size-3', !active && 'opacity-50')} aria-hidden />
      </button>
    </th>
  )
}
