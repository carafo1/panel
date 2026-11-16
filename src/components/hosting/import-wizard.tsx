'use client'

/**
 * Website Import & Migration wizard.
 * =================================
 *
 * Five steps, then live progress:
 *
 *   0. Start fresh or import      → hands a "fresh install" off to the
 *                                    create-website wizard
 *   1. Where is your site now?    → the eight supported backup sources
 *   2. Provide the backup         → upload / remote URL / git clone
 *   3. Where should it go?        → name, domain, and the few settings that
 *                                    genuinely need a human
 *   4. Review                     → what will happen, in plain language
 *   5. Progress                   → the shared MigrationProgress view
 *
 * The guiding rule is that the customer should have to answer as little as
 * possible. Everything the backup can tell us — the platform, the site root,
 * the table prefix, the old URL — is detected on the server rather than asked
 * for here. The only inputs that remain are the ones we genuinely cannot infer.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CloudDownload,
  Container,
  Copy,
  Database,
  FileArchive,
  FileUp,
  GitBranch,
  Globe,
  HardDriveDownload,
  Info,
  Link2,
  Loader2,
  Lock,
  Package,
  Rocket,
  Server,
  Settings2,
  Sparkles,
  Upload,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import MigrationProgress, { type MigrationView } from './migration-progress'

// ─── Source catalogue (mirrors IMPORT_SOURCES on the server) ─────────────

interface SourceDefinition {
  id: string
  name: string
  tagline: string
  description: string
  icon: string
  accept: string[]
  modes: Array<'upload' | 'url' | 'git'>
  needsSeparateSql?: boolean
  hint: string
  wordpress: boolean
}

const ICONS: Record<string, typeof Globe> = {
  Globe,
  Package,
  Copy,
  CloudDownload,
  Server,
  FileArchive,
  GitBranch,
  Container,
}

/**
 * Local copy of the catalogue so step 1 renders instantly. The server's list
 * is authoritative and replaces this as soon as it loads — if the two ever
 * disagree, the server wins and validation still holds.
 */
const FALLBACK_SOURCES: SourceDefinition[] = [
  {
    id: 'wordpress-zip',
    name: 'WordPress backup',
    tagline: 'A ZIP or tarball of your WordPress folder',
    description:
      'The most common way to move a WordPress site. Include your whole WordPress directory and a .sql export of the database.',
    icon: 'Globe',
    accept: ['.zip', '.tar.gz', '.tgz', '.tar'],
    modes: ['upload', 'url'],
    hint: 'Export your database from phpMyAdmin as a .sql file and place it inside the archive before zipping.',
    wordpress: true,
  },
  {
    id: 'wpress',
    name: 'All-in-One WP Migration',
    tagline: '.wpress export file',
    description:
      'The export produced by the All-in-One WP Migration plugin. It already contains both your files and your database.',
    icon: 'Package',
    accept: ['.wpress'],
    modes: ['upload', 'url'],
    hint: 'All-in-One WP Migration → Export → Export to File, then upload the .wpress file here.',
    wordpress: true,
  },
  {
    id: 'duplicator',
    name: 'Duplicator package',
    tagline: 'Duplicator archive',
    description:
      'Duplicator’s archive contains your site and its database. Upload the archive only.',
    icon: 'Copy',
    accept: ['.zip', '.daf'],
    modes: ['upload', 'url'],
    hint: 'Upload the archive file (the large one). You do not need installer.php.',
    wordpress: true,
  },
  {
    id: 'updraftplus',
    name: 'UpdraftPlus backup',
    tagline: 'UpdraftPlus backup set',
    description:
      'UpdraftPlus splits a backup into separate files. Put all of them into one ZIP — they are reassembled automatically.',
    icon: 'CloudDownload',
    accept: ['.zip', '.tar.gz', '.gz'],
    modes: ['upload', 'url'],
    hint: 'Encrypted (.crypt) database backups cannot be imported — decrypt them in UpdraftPlus first.',
    wordpress: true,
  },
  {
    id: 'cpanel',
    name: 'cPanel backup',
    tagline: 'Full or partial cPanel backup',
    description:
      'A cPanel backup tarball. The site is taken from homedir/public_html and the database from the mysql folder.',
    icon: 'Server',
    accept: ['.tar.gz', '.tar', '.tgz', '.zip'],
    modes: ['upload', 'url'],
    hint: 'cPanel → Backup → Download a Full Account Backup.',
    wordpress: false,
  },
  {
    id: 'files-sql',
    name: 'Files + database',
    tagline: 'Any site archive with a separate .sql file',
    description:
      'For sites that are not WordPress, or backups made by hand. Upload files and database separately.',
    icon: 'FileArchive',
    accept: ['.zip', '.tar.gz', '.tar', '.tgz'],
    modes: ['upload'],
    needsSeparateSql: true,
    hint: 'The .sql file can be plain or gzipped (.sql.gz).',
    wordpress: false,
  },
  {
    id: 'git',
    name: 'Git repository',
    tagline: 'Clone from GitHub, GitLab or Bitbucket',
    description:
      'Deploy straight from a repository. Private repositories need a personal access token, used once and never stored.',
    icon: 'GitBranch',
    accept: [],
    modes: ['git'],
    hint: 'Use the HTTPS clone URL, e.g. https://github.com/user/repo.git',
    wordpress: false,
  },
  {
    id: 'docker',
    name: 'Docker project',
    tagline: 'Repository or archive with a Dockerfile',
    description:
      'A project that builds itself. A Dockerfile or docker-compose.yml is used directly.',
    icon: 'Container',
    accept: ['.zip', '.tar.gz', '.tar'],
    modes: ['git', 'upload'],
    hint: 'A docker-compose.yml takes precedence over a plain Dockerfile.',
    wordpress: false,
  },
]

// ─── Upload plumbing ─────────────────────────────────────────────────────

/**
 * Files at or below this go up in one request; larger ones are chunked.
 *
 * The split exists because a single multi-gigabyte request is fragile in ways
 * that have nothing to do with our code: reverse proxies cap body size, mobile
 * connections drop, and a failure at 95% means starting over. Chunking costs
 * one round trip per 8 MB and makes a retry cost 8 MB instead of everything.
 */
const SINGLE_SHOT_MAX = 64 * 1024 * 1024
const CHUNK_SIZE = 8 * 1024 * 1024

interface UploadState {
  uploadId: string
  filename: string
  sizeBytes: number
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** The httpOnly session cookie authenticates same-origin requests. */
function jsonHeaders(): HeadersInit {
  return { 'Content-Type': 'application/json' }
}

/** Single request, streamed, with real upload progress from XHR. */
function uploadSingleShot(
  file: File,
  onProgress: (pct: number) => void,
  signal: AbortSignal
): Promise<UploadState> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/hosting/upload') // session cookie authenticates it
    // The filename travels in a header so the server can stream the body
    // straight to disk instead of buffering a multipart parse.
    xhr.setRequestHeader('X-Upload-Filename', encodeURIComponent(file.name))
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress((e.loaded / e.total) * 100)
    }
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300 && data.uploadId) {
          resolve(data as UploadState)
        } else {
          reject(new Error(data.error || `Upload failed (${xhr.status})`))
        }
      } catch {
        reject(new Error('Upload failed — the server sent an unexpected response.'))
      }
    }
    xhr.onerror = () => reject(new Error('Network error during upload'))
    xhr.onabort = () => reject(new Error('Upload cancelled'))
    signal.addEventListener('abort', () => xhr.abort())
    xhr.send(file)
  })
}

/** Chunked upload: begin → N chunks → finish. */
async function uploadChunked(
  file: File,
  onProgress: (pct: number) => void,
  signal: AbortSignal
): Promise<UploadState> {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  const beginRes = await fetch('/api/hosting/upload?action=begin', {
    method: 'POST',
    headers: jsonHeaders(),
    signal,
    body: JSON.stringify({
      filename: file.name,
      totalChunks,
      sizeBytes: file.size,
    }),
  })
  const begin = await beginRes.json()
  if (!beginRes.ok) throw new Error(begin.error || 'Could not start the upload')
  const uploadId: string = begin.uploadId

  for (let i = 0; i < totalChunks; i++) {
    if (signal.aborted) throw new Error('Upload cancelled')
    const slice = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size))

    // One retry per chunk. Long uploads on mobile connections drop the odd
    // request, and failing the whole transfer for one blip would be needless.
    let lastError: unknown = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(
          `/api/hosting/upload?action=chunk&uploadId=${uploadId}&index=${i}`,
          {
            method: 'POST',
            credentials: 'same-origin',
            body: slice,
            signal,
          }
        )
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          throw new Error(err.error || `Chunk ${i + 1} failed`)
        }
        lastError = null
        break
      } catch (err) {
        lastError = err
        if (signal.aborted) throw err
      }
    }
    if (lastError) throw lastError

    onProgress(((i + 1) / totalChunks) * 100)
  }

  const finishRes = await fetch(
    `/api/hosting/upload?action=finish&uploadId=${uploadId}`,
    { method: 'POST', headers: jsonHeaders(), signal }
  )
  const finish = await finishRes.json()
  if (!finishRes.ok) throw new Error(finish.error || 'Could not finish the upload')
  return finish as UploadState
}

async function uploadFile(
  file: File,
  onProgress: (pct: number) => void,
  signal: AbortSignal
): Promise<UploadState> {
  return file.size <= SINGLE_SHOT_MAX
    ? uploadSingleShot(file, onProgress, signal)
    : uploadChunked(file, onProgress, signal)
}

// ─── File drop zone ──────────────────────────────────────────────────────

function DropZone({
  accept,
  label,
  hint,
  upload,
  uploading,
  progress,
  error,
  onFile,
  onClear,
  icon: Icon = FileUp,
}: {
  accept: string[]
  label: string
  hint: string
  upload: UploadState | null
  uploading: boolean
  progress: number
  error: string | null
  onFile: (file: File) => void
  onClear: () => void
  icon?: typeof FileUp
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)

  if (upload) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
        <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{upload.filename}</p>
          <p className="text-xs text-muted-foreground">
            {formatBytes(upload.sizeBytes)} · ready to import
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClear} className="shrink-0">
          <X className="size-4" />
        </Button>
      </div>
    )
  }

  if (uploading) {
    return (
      <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 dark:border-indigo-900 dark:bg-indigo-950/40">
        <div className="mb-2 flex items-center gap-2">
          <Loader2 className="size-4 animate-spin text-indigo-600 dark:text-indigo-400" />
          <span className="text-sm font-medium">Uploading…</span>
          <span className="ml-auto text-sm tabular-nums text-muted-foreground">
            {Math.round(progress)}%
          </span>
        </div>
        <Progress value={progress} className="h-2" />
        <p className="mt-2 text-xs text-muted-foreground">
          Large backups take a while. Keep this tab open until the upload finishes.
        </p>
      </div>
    )
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files?.[0]
          if (file) onFile(file)
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-8 text-center transition-colors',
          dragging
            ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40'
            : 'border-muted-foreground/25 hover:border-indigo-400 hover:bg-muted/40'
        )}
      >
        <Icon className="mb-3 size-8 text-muted-foreground" />
        <p className="text-sm font-medium">{label}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Drag and drop, or click to browse
        </p>
        {accept.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {accept.join(' · ')}
          </p>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={accept.join(',')}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onFile(file)
          e.target.value = ''
        }}
      />
      {hint && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          <span>{hint}</span>
        </p>
      )}
      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </div>
  )
}

// ─── Wizard ──────────────────────────────────────────────────────────────

export interface ImportWizardProps {
  open: boolean
  onClose: () => void
  /** Called when an import finishes so the caller can refresh its list. */
  onCompleted?: () => void
  /**
   * Import into an existing website instead of creating one. When set, the
   * destination step collapses to just the import options.
   */
  projectId?: string
  projectName?: string
  /** Opens the fresh-install wizard when the customer picks "start new". */
  onChooseFreshInstall?: () => void
}

type Step = 'start' | 'source' | 'payload' | 'destination' | 'review' | 'progress'

export default function ImportWizard({
  open,
  onClose,
  onCompleted,
  projectId,
  projectName,
  onChooseFreshInstall,
}: ImportWizardProps) {
  const importingIntoExisting = Boolean(projectId)

  const [step, setStep] = useState<Step>(importingIntoExisting ? 'source' : 'start')
  const [sources, setSources] = useState<SourceDefinition[]>(FALLBACK_SOURCES)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [mode, setMode] = useState<'upload' | 'url' | 'git'>('upload')

  // Payload
  const [upload, setUpload] = useState<UploadState | null>(null)
  const [sqlUpload, setSqlUpload] = useState<UploadState | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [sqlUploading, setSqlUploading] = useState(false)
  const [sqlProgress, setSqlProgress] = useState(0)
  const [sqlError, setSqlError] = useState<string | null>(null)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [gitBranch, setGitBranch] = useState('')
  const [gitToken, setGitToken] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  // Destination
  const [name, setName] = useState('')
  const [domainType, setDomainType] = useState<'subdomain' | 'existing' | 'external'>(
    'subdomain'
  )
  const [domain, setDomain] = useState('')
  const [ownedDomains, setOwnedDomains] = useState<string[]>([])
  const [originalUrl, setOriginalUrl] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [skipUrlRewrite, setSkipUrlRewrite] = useState(false)
  const [disableCachePlugins, setDisableCachePlugins] = useState(true)

  // Submission
  const [submitting, setSubmitting] = useState(false)
  const [migration, setMigration] = useState<MigrationView | null>(null)

  const source = useMemo(
    () => sources.find((s) => s.id === sourceId) ?? null,
    [sources, sourceId]
  )

  // ── Load the server's source list + the customer's domains ────────
  useEffect(() => {
    if (!open) return
    void fetch('/api/migrations?limit=1', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.sources?.length) setSources(d.sources as SourceDefinition[])
      })
      .catch(() => {})
    void fetch('/api/domains', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const list = (d?.domains ?? []) as Array<{ name: string; status?: string }>
        setOwnedDomains(list.map((x) => x.name).filter(Boolean))
      })
      .catch(() => {})
  }, [open])

  // ── Reset on close ────────────────────────────────────────────────
  const reset = useCallback(() => {
    abortRef.current?.abort()
    setStep(importingIntoExisting ? 'source' : 'start')
    setSourceId(null)
    setUpload(null)
    setSqlUpload(null)
    setUploading(false)
    setUploadProgress(0)
    setUploadError(null)
    setSqlUploading(false)
    setSqlProgress(0)
    setSqlError(null)
    setRemoteUrl('')
    setGitUrl('')
    setGitBranch('')
    setGitToken('')
    setName('')
    setDomainType('subdomain')
    setDomain('')
    setOriginalUrl('')
    setShowAdvanced(false)
    setSkipUrlRewrite(false)
    setDisableCachePlugins(true)
    setSubmitting(false)
    setMigration(null)
  }, [importingIntoExisting])

  const handleClose = useCallback(() => {
    // Never discard a running import just because the dialog closed — the
    // customer can reopen it from the dashboard.
    if (step === 'progress' && migration && migration.status === 'completed') {
      onCompleted?.()
    }
    onClose()
    // Give the close animation a beat before wiping the state under it.
    setTimeout(reset, 250)
  }, [step, migration, onClose, onCompleted, reset])

  // ── Upload handlers ───────────────────────────────────────────────
  const startUpload = useCallback(
    async (file: File, kind: 'payload' | 'sql') => {
      const setBusy = kind === 'payload' ? setUploading : setSqlUploading
      const setPct = kind === 'payload' ? setUploadProgress : setSqlProgress
      const setErr = kind === 'payload' ? setUploadError : setSqlError
      const setDone = kind === 'payload' ? setUpload : setSqlUpload

      if (kind === 'sql' && !/\.sql(\.gz|\.bz2)?$/i.test(file.name)) {
        setErr('Choose a .sql, .sql.gz or .sql.bz2 file.')
        return
      }

      setErr(null)
      setBusy(true)
      setPct(0)
      const controller = new AbortController()
      abortRef.current = controller
      try {
        const result = await uploadFile(file, setPct, controller.signal)
        setDone(result)
        // Offer the archive's name as the website name — a small touch that
        // saves the customer a decision they do not care about.
        if (kind === 'payload' && !name) {
          const guess = file.name
            .replace(/\.(zip|wpress|tar|tgz|gz|bz2|xz|daf)$/gi, '')
            .replace(/\.tar$/i, '')
            .replace(/[_-]+/g, ' ')
            .trim()
          if (guess) setName(guess.slice(0, 60))
        }
        toast.success('Upload complete')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Upload failed'
        setErr(msg)
        if (!/cancelled/i.test(msg)) toast.error(msg)
      } finally {
        setBusy(false)
        abortRef.current = null
      }
    },
    [name]
  )

  // ── Validation per step ───────────────────────────────────────────
  const payloadReady = useMemo(() => {
    if (!source) return false
    if (mode === 'upload') {
      if (!upload) return false
      if (source.needsSeparateSql && !sqlUpload) return false
      return true
    }
    if (mode === 'url') return remoteUrl.trim().length > 0
    return gitUrl.trim().length > 0
  }, [source, mode, upload, sqlUpload, remoteUrl, gitUrl])

  const destinationReady = useMemo(() => {
    if (importingIntoExisting) return true
    if (!name.trim()) return false
    if (domainType !== 'subdomain' && !domain.trim()) return false
    return true
  }, [importingIntoExisting, name, domainType, domain])

  // ── Submit ────────────────────────────────────────────────────────
  const submit = useCallback(async () => {
    if (!source) return
    setSubmitting(true)
    try {
      const payload: Record<string, unknown> = {
        sourceType: source.id,
        sourceMode: mode,
        uploadId: mode === 'upload' ? upload?.uploadId : undefined,
        sqlUploadId: sqlUpload?.uploadId,
        url: mode === 'url' ? remoteUrl.trim() : undefined,
        gitUrl: mode === 'git' ? gitUrl.trim() : undefined,
        gitBranch: gitBranch.trim() || undefined,
        gitToken: gitToken.trim() || undefined,
        originalUrl: originalUrl.trim() || undefined,
        skipUrlRewrite,
        disableCachePlugins,
      }
      if (!importingIntoExisting) {
        payload.name = name.trim()
        payload.domainType = domainType
        payload.domain = domainType === 'subdomain' ? undefined : domain.trim()
      }

      const endpoint = importingIntoExisting
        ? `/api/hosting/${projectId}/migrate`
        : '/api/hosting/import'

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not start the import.')
        return
      }
      setMigration(data.migration as MigrationView)
      setStep('progress')
      toast.success('Import started')
    } catch {
      toast.error('Network error — please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [
    source,
    mode,
    upload,
    sqlUpload,
    remoteUrl,
    gitUrl,
    gitBranch,
    gitToken,
    originalUrl,
    skipUrlRewrite,
    disableCachePlugins,
    importingIntoExisting,
    name,
    domainType,
    domain,
    projectId,
  ])

  // ── Step chrome ───────────────────────────────────────────────────
  const steps: Array<{ id: Step; label: string }> = importingIntoExisting
    ? [
        { id: 'source', label: 'Source' },
        { id: 'payload', label: 'Backup' },
        { id: 'destination', label: 'Options' },
        { id: 'review', label: 'Review' },
      ]
    : [
        { id: 'start', label: 'Start' },
        { id: 'source', label: 'Source' },
        { id: 'payload', label: 'Backup' },
        { id: 'destination', label: 'Destination' },
        { id: 'review', label: 'Review' },
      ]
  const stepIndex = steps.findIndex((s) => s.id === step)

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-3xl max-h-[92vh] overflow-hidden flex flex-col p-0 gap-0">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <HardDriveDownload className="size-5 text-indigo-600 dark:text-indigo-400" />
            {step === 'progress'
              ? 'Importing your website'
              : importingIntoExisting
                ? `Import into ${projectName ?? 'this website'}`
                : 'Add a website'}
          </DialogTitle>
          <DialogDescription>
            {step === 'progress'
              ? 'This runs on our servers — you can close this window and come back to it.'
              : 'Move an existing site here, or start a fresh WordPress install.'}
          </DialogDescription>
        </DialogHeader>

        {/* Step rail */}
        {step !== 'progress' && (
          <div className="flex items-center gap-1 px-6 pb-4 shrink-0">
            {steps.map((s, i) => (
              <div key={s.id} className="flex flex-1 items-center gap-1">
                <div
                  className={cn(
                    'flex h-1.5 flex-1 rounded-full transition-colors',
                    i <= stepIndex ? 'bg-indigo-600' : 'bg-muted'
                  )}
                />
              </div>
            ))}
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0">
          <div className="px-6 pb-6">
            {/* ── Step: start ──────────────────────────────────── */}
            {step === 'start' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => {
                    onChooseFreshInstall?.()
                    onClose()
                    setTimeout(reset, 250)
                  }}
                  className="group flex flex-col items-start rounded-xl border-2 border-muted p-5 text-left transition-colors hover:border-indigo-400 hover:bg-muted/40"
                >
                  <span className="mb-3 flex size-10 items-center justify-center rounded-lg bg-indigo-100 text-indigo-600 dark:bg-indigo-950 dark:text-indigo-400">
                    <Sparkles className="size-5" />
                  </span>
                  <span className="font-semibold">Start a new website</span>
                  <span className="mt-1 text-sm text-muted-foreground">
                    One-click WordPress, or any of our other stacks. Ready in about
                    a minute.
                  </span>
                  <span className="mt-3 flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400">
                    Choose a stack
                    <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => setStep('source')}
                  className="group flex flex-col items-start rounded-xl border-2 border-indigo-500 bg-indigo-50/50 p-5 text-left dark:bg-indigo-950/30"
                >
                  <span className="mb-3 flex size-10 items-center justify-center rounded-lg bg-indigo-600 text-white">
                    <HardDriveDownload className="size-5" />
                  </span>
                  <span className="font-semibold">Import an existing website</span>
                  <span className="mt-1 text-sm text-muted-foreground">
                    Move a site from another host. We detect what it is, rebuild
                    it here, and update its URLs automatically.
                  </span>
                  <span className="mt-3 flex items-center gap-1 text-sm font-medium text-indigo-600 dark:text-indigo-400">
                    Start the migration
                    <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </button>
              </div>
            )}

            {/* ── Step: source ─────────────────────────────────── */}
            {step === 'source' && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Where is your website now? Pick the backup you have — if you are
                  not sure, the first option handles most WordPress sites.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {sources.map((s) => {
                    const Icon = ICONS[s.icon] ?? Globe
                    const selected = sourceId === s.id
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => {
                          setSourceId(s.id)
                          setMode(s.modes[0])
                          setUpload(null)
                          setSqlUpload(null)
                        }}
                        className={cn(
                          'flex items-start gap-3 rounded-lg border-2 p-4 text-left transition-colors',
                          selected
                            ? 'border-indigo-500 bg-indigo-50/60 dark:bg-indigo-950/30'
                            : 'border-muted hover:border-indigo-300 hover:bg-muted/40'
                        )}
                      >
                        <span
                          className={cn(
                            'flex size-9 shrink-0 items-center justify-center rounded-lg',
                            selected
                              ? 'bg-indigo-600 text-white'
                              : 'bg-muted text-muted-foreground'
                          )}
                        >
                          <Icon className="size-4.5" />
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className="font-medium text-sm">{s.name}</span>
                            {s.wordpress && (
                              <Badge
                                variant="outline"
                                className="h-4 px-1 text-[10px] font-normal"
                              >
                                WP
                              </Badge>
                            )}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            {s.tagline}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
                {source && (
                  <div className="rounded-lg bg-muted/60 p-3 text-sm text-muted-foreground">
                    {source.description}
                  </div>
                )}
              </div>
            )}

            {/* ── Step: payload ────────────────────────────────── */}
            {step === 'payload' && source && (
              <div className="space-y-5">
                {source.modes.length > 1 && (
                  <div className="flex gap-2">
                    {source.modes.map((m) => (
                      <Button
                        key={m}
                        type="button"
                        variant={mode === m ? 'default' : 'outline'}
                        size="sm"
                        onClick={() => setMode(m)}
                        className={cn(
                          mode === m && 'bg-indigo-600 hover:bg-indigo-700 text-white'
                        )}
                      >
                        {m === 'upload' && <Upload className="size-4 mr-1.5" />}
                        {m === 'url' && <Link2 className="size-4 mr-1.5" />}
                        {m === 'git' && <GitBranch className="size-4 mr-1.5" />}
                        {m === 'upload'
                          ? 'Upload a file'
                          : m === 'url'
                            ? 'From a URL'
                            : 'Clone a repository'}
                      </Button>
                    ))}
                  </div>
                )}

                {mode === 'upload' && (
                  <>
                    <div>
                      <Label className="mb-2 block">
                        {source.needsSeparateSql ? 'Website files' : 'Your backup'}
                      </Label>
                      <DropZone
                        accept={source.accept}
                        label={`Upload your ${source.name.toLowerCase()}`}
                        hint={source.hint}
                        upload={upload}
                        uploading={uploading}
                        progress={uploadProgress}
                        error={uploadError}
                        onFile={(f) => void startUpload(f, 'payload')}
                        onClear={() => setUpload(null)}
                      />
                    </div>

                    {source.needsSeparateSql && (
                      <div>
                        <Label className="mb-2 block">Database export</Label>
                        <DropZone
                          accept={['.sql', '.sql.gz', '.sql.bz2']}
                          label="Upload your .sql file"
                          hint="Export it from phpMyAdmin, Adminer, or with mysqldump."
                          upload={sqlUpload}
                          uploading={sqlUploading}
                          progress={sqlProgress}
                          error={sqlError}
                          onFile={(f) => void startUpload(f, 'sql')}
                          onClear={() => setSqlUpload(null)}
                          icon={Database}
                        />
                      </div>
                    )}
                  </>
                )}

                {mode === 'url' && (
                  <div className="space-y-2">
                    <Label htmlFor="remote-url">Direct link to your backup</Label>
                    <Input
                      id="remote-url"
                      placeholder="https://example.com/backups/my-site.zip"
                      value={remoteUrl}
                      onChange={(e) => setRemoteUrl(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      The server downloads it directly, so nothing has to travel
                      through your browser. The link must be publicly reachable —
                      Dropbox and Google Drive share links need to be direct
                      download links.
                    </p>
                  </div>
                )}

                {mode === 'git' && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="git-url">Repository URL</Label>
                      <Input
                        id="git-url"
                        placeholder="https://github.com/username/my-site.git"
                        value={gitUrl}
                        onChange={(e) => setGitUrl(e.target.value)}
                      />
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="git-branch">Branch</Label>
                        <Input
                          id="git-branch"
                          placeholder="main (default)"
                          value={gitBranch}
                          onChange={(e) => setGitBranch(e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="git-token" className="flex items-center gap-1.5">
                          <Lock className="size-3.5" />
                          Access token
                        </Label>
                        <Input
                          id="git-token"
                          type="password"
                          placeholder="Only for private repositories"
                          value={gitToken}
                          onChange={(e) => setGitToken(e.target.value)}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The token is used for this one clone and is never saved. If
                      you retry the import later you will be asked for it again.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* ── Step: destination ────────────────────────────── */}
            {step === 'destination' && (
              <div className="space-y-5">
                {!importingIntoExisting && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="site-name">Website name</Label>
                      <Input
                        id="site-name"
                        placeholder="My Company Site"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        maxLength={60}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>Address</Label>
                      <Select
                        value={domainType}
                        onValueChange={(v) =>
                          setDomainType(v as 'subdomain' | 'existing' | 'external')
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="subdomain">
                            Free subdomain — live immediately
                          </SelectItem>
                          <SelectItem value="existing">
                            A domain in my account
                          </SelectItem>
                          <SelectItem value="external">
                            A domain registered elsewhere
                          </SelectItem>
                        </SelectContent>
                      </Select>

                      {domainType === 'existing' && (
                        <Select value={domain} onValueChange={setDomain}>
                          <SelectTrigger>
                            <SelectValue placeholder="Choose a domain" />
                          </SelectTrigger>
                          <SelectContent>
                            {ownedDomains.length === 0 ? (
                              <SelectItem value="__none" disabled>
                                No domains in your account yet
                              </SelectItem>
                            ) : (
                              ownedDomains.map((d) => (
                                <SelectItem key={d} value={d}>
                                  {d}
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      )}

                      {domainType === 'external' && (
                        <>
                          <Input
                            placeholder="www.example.com"
                            value={domain}
                            onChange={(e) => setDomain(e.target.value)}
                          />
                          <p className="text-xs text-muted-foreground">
                            Your site goes live on a subdomain right away. We give
                            you the DNS records to add at your registrar, and the
                            domain connects itself once they resolve — your
                            current site keeps serving in the meantime.
                          </p>
                        </>
                      )}
                    </div>
                  </>
                )}

                <div className="space-y-2">
                  <Label htmlFor="original-url">
                    Current website address{' '}
                    <span className="font-normal text-muted-foreground">
                      (optional)
                    </span>
                  </Label>
                  <Input
                    id="original-url"
                    placeholder="https://my-old-site.com"
                    value={originalUrl}
                    onChange={(e) => setOriginalUrl(e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Only needed if we cannot read it from your backup. Every link,
                    image path and setting containing this address is rewritten to
                    the new one.
                  </p>
                </div>

                <Separator />

                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
                >
                  <Settings2 className="size-4" />
                  Advanced options
                  <ChevronRight
                    className={cn(
                      'size-4 transition-transform',
                      showAdvanced && 'rotate-90'
                    )}
                  />
                </button>

                {showAdvanced && (
                  <div className="space-y-4 rounded-lg border p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Label className="text-sm">Rewrite site URLs</Label>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Turn this off only if the site keeps the exact same
                          address. Leaving it on is almost always right.
                        </p>
                      </div>
                      <Switch
                        checked={!skipUrlRewrite}
                        onCheckedChange={(v) => setSkipUrlRewrite(!v)}
                      />
                    </div>
                    <Separator />
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Label className="text-sm">Disable caching plugins</Label>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          Caching plugins store your old server&apos;s file paths and
                          will white-screen the site here. They are switched off,
                          not deleted — re-enable them once the site looks right.
                        </p>
                      </div>
                      <Switch
                        checked={disableCachePlugins}
                        onCheckedChange={setDisableCachePlugins}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Step: review ─────────────────────────────────── */}
            {step === 'review' && source && (
              <div className="space-y-5">
                <div className="rounded-lg border divide-y">
                  <ReviewRow label="Website" value={importingIntoExisting ? (projectName ?? '—') : name} />
                  <ReviewRow
                    label="Address"
                    value={
                      importingIntoExisting
                        ? 'Existing address'
                        : domainType === 'subdomain'
                          ? 'Free subdomain (assigned automatically)'
                          : domain
                    }
                  />
                  <ReviewRow label="Source" value={source.name} />
                  <ReviewRow
                    label="Backup"
                    value={
                      mode === 'upload'
                        ? `${upload?.filename ?? '—'}${
                            upload ? ` · ${formatBytes(upload.sizeBytes)}` : ''
                          }${sqlUpload ? ` + ${sqlUpload.filename}` : ''}`
                        : mode === 'url'
                          ? remoteUrl
                          : `${gitUrl}${gitBranch ? ` (${gitBranch})` : ''}`
                    }
                  />
                  {originalUrl && (
                    <ReviewRow label="Current address" value={originalUrl} />
                  )}
                </div>

                <div className="rounded-lg border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-900 dark:bg-indigo-950/30">
                  <p className="mb-2 text-sm font-medium">What happens next</p>
                  <ol className="space-y-1.5 text-sm text-muted-foreground">
                    {[
                      'Your backup is transferred to the server and unpacked',
                      'We detect what kind of site it is and check it is complete',
                      'A database is created and your data is imported into it',
                      'Files are placed, configuration written, permissions fixed',
                      'Every link and setting is updated to the new address',
                      'The site is started, routed, and given an HTTPS certificate',
                      'We load the site and confirm it works before marking it live',
                    ].map((t, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-indigo-500" />
                        <span>{t}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info className="mt-0.5 size-3.5 shrink-0" />
                    <span>
                      If any step fails, everything is undone automatically — your
                      account is left exactly as it is now.
                    </span>
                  </p>
                </div>
              </div>
            )}

            {/* ── Step: progress ───────────────────────────────── */}
            {step === 'progress' && migration && (
              <MigrationProgress
                migrationId={migration.id}
                initial={migration}
                onFinished={() => onCompleted?.()}
              />
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        {step !== 'progress' && step !== 'start' && (
          <div className="flex items-center justify-between gap-3 border-t px-6 py-4 shrink-0">
            <Button
              variant="ghost"
              onClick={() => {
                const order: Step[] = importingIntoExisting
                  ? ['source', 'payload', 'destination', 'review']
                  : ['start', 'source', 'payload', 'destination', 'review']
                const i = order.indexOf(step)
                if (i > 0) setStep(order[i - 1])
              }}
              disabled={submitting}
            >
              <ArrowLeft className="size-4 mr-1.5" />
              Back
            </Button>

            {step === 'source' && (
              <Button
                onClick={() => setStep('payload')}
                disabled={!source}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                Continue
                <ArrowRight className="size-4 ml-1.5" />
              </Button>
            )}
            {step === 'payload' && (
              <Button
                onClick={() => setStep('destination')}
                disabled={!payloadReady || uploading || sqlUploading}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                Continue
                <ArrowRight className="size-4 ml-1.5" />
              </Button>
            )}
            {step === 'destination' && (
              <Button
                onClick={() => setStep('review')}
                disabled={!destinationReady}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                Review
                <ArrowRight className="size-4 ml-1.5" />
              </Button>
            )}
            {step === 'review' && (
              <Button
                onClick={() => void submit()}
                disabled={submitting}
                className="bg-indigo-600 hover:bg-indigo-700 text-white"
              >
                {submitting ? (
                  <Loader2 className="size-4 mr-1.5 animate-spin" />
                ) : (
                  <Rocket className="size-4 mr-1.5" />
                )}
                Start import
              </Button>
            )}
          </div>
        )}

        {step === 'progress' && (
          <div className="flex justify-end border-t px-6 py-4 shrink-0">
            <Button variant="outline" onClick={handleClose}>
              Close
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <span className="text-sm text-muted-foreground shrink-0">{label}</span>
      <span className="text-sm font-medium text-right break-all">{value || '—'}</span>
    </div>
  )
}
