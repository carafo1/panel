'use client'

/**
 * New website
 * ===========
 *
 * One guided flow for every way of getting a site online. The first question
 * is the customer's goal, in plain words; each goal then asks only what it
 * needs:
 *
 *   Start a new WordPress site   → Site details → Confirm
 *   Move my existing website     → Your backup → Name & address → Confirm
 *   Upload a website (HTML/ZIP)  → Your files → Name & address → Confirm
 *   Deploy from Git (developers) → Your code → Name & address → Confirm
 *
 * Importing into an existing website skips the goal and address:
 *   Your backup → Confirm
 *
 * After submitting, the same dialog shows live progress with named phases.
 *
 * APIs (unchanged): POST /api/hosting/create, POST /api/hosting/import,
 * POST /api/hosting/[id]/migrate, the chunked /api/hosting/upload, plus
 * GET /api/migrations (source catalogue) and GET /api/domains.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Code2,
  FileUp,
  HardDriveDownload,
  LayoutTemplate,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
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
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { MigrationView } from '../migration-progress'
import { BackupStep, EMPTY_BACKUP, backupErrors, slotProvided, type BackupValue } from './backup-step'
import { ChoiceList, Field, MoreOptions, describedBy } from './choice-list'
import {
  CodeStep,
  EMPTY_CODE,
  SecretInput,
  codeErrors,
  effectiveSource,
  getMethod,
  visibleFields,
  type CodeValue,
} from './code-step'
import { DeployProgress, type PendingDomain } from './deploy-progress'
import { FileDrop } from './file-drop'
import { formatBytes, generatePassword, isValidEmail, isValidHttpUrl, nameFromFilename } from './format'
import { ImportProgress } from './import-progress'
import { PlanBlocker, PlanNote, usePlanUsage } from './plan-usage'
import {
  EMPTY_IDENTITY,
  SiteIdentity,
  addressError,
  addressSummary,
  identityPayload,
  nameError,
  type IdentityValue,
} from './site-identity'
import { FALLBACK_SOURCES, MAX_SITE_ZIP_BYTES, SQL_ACCEPT, sourceForFile, MAX_IMPORT_BYTES, type SourceDefinition } from './sources'
import { useFileUpload, type FileSlot, type FileUpload } from './use-file-upload'

export type Goal = 'wordpress' | 'move' | 'upload' | 'code'
type StepId = 'goal' | 'backup' | 'files' | 'code' | 'details' | 'confirm'

export interface NewWebsiteWizardProps {
  open: boolean
  onClose: () => void
  /** Start on a goal (e.g. "move" from an Import button). */
  initialGoal?: Goal
  /** Import into this existing website instead of creating one. */
  target?: { projectId: string; projectName: string }
  /** A website was created (the list can refresh right away). */
  onCreated?: (project: { id: string; name: string }) => void
  /** "Manage website" after a successful setup. */
  onOpenProject?: (projectId: string) => void
  /** An import reached a final state. */
  onImportFinished?: (m: MigrationView) => void
}

const GOALS: Array<{ id: Goal; title: string; description: string; need: string; icon: typeof FileUp }> = [
  {
    id: 'wordpress',
    title: 'Start a new WordPress site',
    description: 'A blog, shop or business site. We install WordPress and give you the login.',
    need: 'Nothing — just a name and an email address',
    icon: LayoutTemplate,
  },
  {
    id: 'move',
    title: 'Move my existing website here',
    description: 'From Hostinger, GoDaddy, cPanel or any other host, using a backup file or a download link.',
    need: 'A backup of your site (.zip, .tar.gz, .wpress…)',
    icon: HardDriveDownload,
  },
  {
    id: 'upload',
    title: 'Upload a website (HTML or ZIP)',
    description: 'You already have the finished files of a site, for example from a designer.',
    need: 'A .zip file of the site',
    icon: FileUp,
  },
  {
    id: 'code',
    title: 'Deploy from Git (developers)',
    description: 'Node.js, PHP, Laravel, Python, Docker or static projects — from a repository, a ZIP or a starter.',
    need: 'A repository URL',
    icon: Code2,
  },
]

const STEP_TEXT: Record<StepId, { label: string; title: string; description: string }> = {
  goal: { label: 'Goal', title: 'What would you like to do?', description: 'Pick the one that fits. You can go back and change it.' },
  backup: {
    label: 'Your backup',
    title: 'Add your website backup',
    description: 'We read everything we need from the backup — the type of site, its database and its old address.',
  },
  files: { label: 'Your files', title: 'Add your website files', description: 'Upload the ZIP and tell us what kind of site it is.' },
  code: { label: 'Your code', title: 'Connect your code', description: 'Choose the technology and where the code lives.' },
  details: { label: 'Name & address', title: 'Name your website', description: 'Choose a name and where visitors will find it.' },
  confirm: { label: 'Confirm', title: 'Ready to go', description: 'Check the details, then start.' },
}

type UploadSiteType = 'html' | 'built' | 'php'

interface WpAccount {
  email: string
  user: string
  password: string
}

type Result =
  | {
      kind: 'deploy'
      projectId: string
      projectName: string
      liveUrl: string
      pendingDomain: PendingDomain | null
      manual: boolean
    }
  | { kind: 'import'; migrationId: string; migration: MigrationView | null }

const zipRules = { accept: ['.zip'], maxBytes: MAX_SITE_ZIP_BYTES, kind: 'ZIP archive' }
const sqlRules = { accept: SQL_ACCEPT, maxBytes: MAX_IMPORT_BYTES, kind: 'database export' }

export default function NewWebsiteWizard({
  open,
  onClose,
  initialGoal,
  target,
  onCreated,
  onOpenProject,
  onImportFinished,
}: NewWebsiteWizardProps) {
  const intoExisting = Boolean(target)
  const startGoal: Goal | null = intoExisting ? 'move' : initialGoal ?? null

  const [goal, setGoal] = useState<Goal | null>(startGoal)
  const [stepIndex, setStepIndex] = useState(startGoal && !intoExisting ? 1 : 0)
  const [showErrors, setShowErrors] = useState(false)

  const [identity, setIdentity] = useState<IdentityValue>(EMPTY_IDENTITY)
  const [wp, setWp] = useState<WpAccount>({ email: '', user: 'admin', password: '' })
  const [backup, setBackup] = useState<BackupValue>(EMPTY_BACKUP)
  const [originalUrl, setOriginalUrl] = useState('')
  const [rewriteUrls, setRewriteUrls] = useState(true)
  const [disableCache, setDisableCache] = useState(true)
  const [siteType, setSiteType] = useState<UploadSiteType>('html')
  const [builtFramework, setBuiltFramework] = useState('react')
  const [outputDir, setOutputDir] = useState('dist')
  const [buildCommand, setBuildCommand] = useState('npm run build')
  const [phpVersion, setPhpVersion] = useState('8.2')
  const [code, setCode] = useState<CodeValue>(EMPTY_CODE)
  const [deployNow, setDeployNow] = useState(true)
  const [moreOpen, setMoreOpen] = useState(false)

  const [sources, setSources] = useState<SourceDefinition[]>(FALLBACK_SOURCES)
  const [domains, setDomains] = useState<string[]>([])
  const [domainsLoading, setDomainsLoading] = useState(true)

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)

  const plan = usePlanUsage(open && !intoExisting)
  const headingRef = useRef<HTMLHeadingElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  const source = sources.find((s) => s.id === backup.sourceId) ?? null

  // Offer the backup's filename as the website name.
  const suggestName = useCallback((filename: string) => {
    const guess = nameFromFilename(filename)
    if (guess) setIdentity((v) => (v.name.trim() ? v : { ...v, name: guess }))
  }, [])

  const archive = useFileUpload(
    { accept: source?.accept ?? [], maxBytes: MAX_IMPORT_BYTES, kind: `${source?.name ?? 'backup'} file` },
    { onDone: (_r, f) => suggestName(f.name) }
  )
  const sql = useFileUpload(sqlRules)
  const siteZip = useFileUpload(zipRules, { onDone: (_r, f) => suggestName(f.name) })
  const codeZip = useFileUpload(zipRules)

  // A dropped .wpress / .daf / cPanel backup switches to the matching source.
  const smartArchive: FileUpload = useMemo(
    () => ({
      ...archive,
      select: (file: File) => {
        const match = sourceForFile(file.name)
        const current = sources.find((s) => s.id === backup.sourceId)
        const fits = current?.accept.some((ext) => file.name.toLowerCase().endsWith(ext))
        if (match && match !== backup.sourceId && (!fits || match === 'wpress' || match === 'duplicator')) {
          const next = sources.find((s) => s.id === match)
          if (next) {
            setBackup((b) => ({ ...b, sourceId: match, mode: 'upload' }))
            archive.select(file, { accept: next.accept, maxBytes: MAX_IMPORT_BYTES, kind: `${next.name} file` })
            return
          }
        }
        archive.select(file)
      },
    }),
    [archive, sources, backup.sourceId]
  )

  // ── Reference data ───────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void fetch('/api/migrations?limit=1', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled && Array.isArray(d?.sources) && d.sources.length) setSources(d.sources as SourceDefinition[])
      })
      .catch(() => {})
    if (!intoExisting) {
      setDomainsLoading(true)
      void fetch('/api/domains', { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (cancelled) return
          const list = (d?.domains ?? []) as Array<{ name: string; status?: string }>
          // Registered here and live, or added but not yet serving another site.
          setDomains(list.filter((x) => !x.status || x.status === 'active' || x.status === 'not_connected').map((x) => x.name))
        })
        .catch(() => {})
        .finally(() => !cancelled && setDomainsLoading(false))
    }
    return () => {
      cancelled = true
    }
  }, [open, intoExisting])

  // ── Steps ────────────────────────────────────────────────────────────
  const steps: StepId[] = useMemo(() => {
    if (intoExisting) return ['backup', 'confirm']
    switch (goal) {
      case 'wordpress':
        return ['goal', 'details', 'confirm']
      case 'move':
        return ['goal', 'backup', 'details', 'confirm']
      case 'upload':
        return ['goal', 'files', 'details', 'confirm']
      case 'code':
        return ['goal', 'code', 'details', 'confirm']
      default:
        return ['goal']
    }
  }, [goal, intoExisting])
  const step: StepId = steps[Math.min(stepIndex, steps.length - 1)]

  // Move focus to the new step's heading so keyboard and screen-reader users
  // start at the top of what changed.
  useEffect(() => {
    if (open) headingRef.current?.focus()
  }, [step, open, result])

  // ── Reset ────────────────────────────────────────────────────────────
  const reset = useCallback(() => {
    setGoal(startGoal)
    setStepIndex(startGoal && !intoExisting ? 1 : 0)
    setShowErrors(false)
    setIdentity(EMPTY_IDENTITY)
    setWp({ email: '', user: 'admin', password: '' })
    setBackup(EMPTY_BACKUP)
    setOriginalUrl('')
    setRewriteUrls(true)
    setDisableCache(true)
    setSiteType('html')
    setCode(EMPTY_CODE)
    setDeployNow(true)
    setMoreOpen(false)
    setSubmitting(false)
    setSubmitError(null)
    setResult(null)
    archive.cancel()
    sql.cancel()
    siteZip.cancel()
    codeZip.cancel()
  }, [startGoal, intoExisting, archive, sql, siteZip, codeZip])

  // Fresh state every time the dialog opens.
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) reset()
    wasOpen.current = open
  }, [open, reset])

  // WordPress password is generated once, visible, and replaceable.
  useEffect(() => {
    if (goal === 'wordpress' && !wp.password) setWp((w) => ({ ...w, password: generatePassword() }))
  }, [goal, wp.password])

  // ── Validation ───────────────────────────────────────────────────────
  const wpErrors = useMemo(() => {
    const e: Record<string, string> = {}
    if (!isValidEmail(wp.email)) e.email = wp.email.trim() ? 'Enter a valid email address.' : 'Enter the email for your WordPress account.'
    if (!/^[A-Za-z0-9_.@-]{1,60}$/.test(wp.user)) e.user = 'Use letters, numbers, dots, dashes or underscores.'
    if (wp.password.length < 8) e.password = 'Use at least 8 characters.'
    return e
  }, [wp])

  const uploadSlotFor = (s: FileSlot) => slotProvided(s)

  const stepValid = (id: StepId): boolean => {
    switch (id) {
      case 'goal':
        return goal !== null
      case 'backup':
        return Object.keys(backupErrors(backup, source, archive.slot, sql.slot)).length === 0
      case 'files':
        return uploadSlotFor(siteZip.slot)
      case 'code':
        return Object.keys(codeErrors(code, uploadSlotFor(codeZip.slot))).length === 0
      case 'details':
        return (
          !nameError(identity.name) &&
          !addressError(identity) &&
          (goal !== 'wordpress' || Object.keys(wpErrors).length === 0)
        )
      case 'confirm':
        return true
    }
  }

  // Uploads that must finish before submitting.
  const pendingUploads: FileSlot[] = useMemo(() => {
    if (goal === 'move' && backup.mode === 'upload') return [archive.slot, sql.slot].filter((s) => s.status !== 'empty')
    if (goal === 'upload') return [siteZip.slot]
    if (goal === 'code' && effectiveSource(getMethod(code.methodId), code.source) === 'zip') return [codeZip.slot]
    return []
  }, [goal, backup.mode, archive.slot, sql.slot, siteZip.slot, code, codeZip.slot])
  const uploadsBusy = pendingUploads.some((s) => s.status === 'uploading')
  const uploadsBroken = pendingUploads.some((s) => s.status === 'paused' || s.status === 'failed')
  const uploadPct = (() => {
    const busy = pendingUploads.filter((s) => s.status === 'uploading') as Array<Extract<FileSlot, { status: 'uploading' }>>
    const total = busy.reduce((a, s) => a + s.size, 0)
    const loaded = busy.reduce((a, s) => a + s.progress.loaded, 0)
    return total ? Math.floor((loaded / total) * 100) : 0
  })()

  const blocked = !intoExisting && (plan.atLimit || plan.noPlan)

  // ── Navigation ───────────────────────────────────────────────────────
  const goNext = () => {
    if (!stepValid(step)) {
      setShowErrors(true)
      // Take keyboard and screen-reader users to the first problem.
      requestAnimationFrame(() => {
        const bad = bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], [role="alert"]')
        bad?.focus?.()
        bad?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
      return
    }
    setShowErrors(false)
    setStepIndex((i) => Math.min(i + 1, steps.length - 1))
  }
  const goBack = () => {
    setShowErrors(false)
    setSubmitError(null)
    setStepIndex((i) => Math.max(0, i - 1))
  }
  const chooseGoal = (g: Goal) => {
    setGoal(g)
    setShowErrors(false)
    setStepIndex(1)
  }

  // ── Submit ───────────────────────────────────────────────────────────
  const submit = async () => {
    if (uploadsBusy || uploadsBroken || submitting) return
    setSubmitting(true)
    setSubmitError(null)
    try {
      if (goal === 'move') {
        const body: Record<string, unknown> = {
          sourceType: backup.sourceId,
          sourceMode: backup.mode,
          uploadId: backup.mode === 'upload' && archive.slot.status === 'done' ? archive.slot.result.uploadId : undefined,
          sqlUploadId: backup.mode === 'upload' && sql.slot.status === 'done' ? sql.slot.result.uploadId : undefined,
          url: backup.mode === 'url' ? backup.remoteUrl.trim() : undefined,
          gitUrl: backup.mode === 'git' ? backup.gitUrl.trim() : undefined,
          gitBranch: backup.mode === 'git' ? backup.gitBranch.trim() || undefined : undefined,
          gitToken: backup.mode === 'git' ? backup.gitToken.trim() || undefined : undefined,
          originalUrl: originalUrl.trim() || undefined,
          skipUrlRewrite: !rewriteUrls,
          disableCachePlugins: disableCache,
        }
        if (!intoExisting) Object.assign(body, identityPayload(identity))
        const res = await fetch(intoExisting ? `/api/hosting/${target!.projectId}/migrate` : '/api/hosting/import', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          setSubmitError(data.error || 'The import could not be started.')
          return
        }
        if (data.project?.id) onCreated?.({ id: data.project.id, name: data.project.name })
        setResult({ kind: 'import', migrationId: data.migration.id, migration: data.migration?.stages ? (data.migration as MigrationView) : null })
        return
      }

      // New site through /api/hosting/create.
      const id = identityPayload(identity)
      let payload: Record<string, unknown>
      if (goal === 'wordpress') {
        payload = {
          ...id,
          deployMode: deployNow ? 'auto' : 'manual',
          method: 'wordpress',
          source: 'manual',
          framework: 'wordpress',
          config: {
            runtime: 'php',
            runtimeVersion: '8.2',
            wpAdminUser: wp.user.trim(),
            wpAdminPassword: wp.password,
            wpAdminEmail: wp.email.trim(),
          },
        }
      } else if (goal === 'upload') {
        const uploadId = siteZip.slot.status === 'done' ? siteZip.slot.result.uploadId : undefined
        const config: Record<string, unknown> =
          siteType === 'php'
            ? { runtime: 'php', runtimeVersion: phpVersion, documentRoot: '/var/www/html' }
            : siteType === 'built'
              ? { runtime: 'static', runtimeVersion: '1', framework: builtFramework, documentRoot: outputDir.trim() || 'dist', buildCommand: buildCommand.trim() || undefined }
              : { runtime: 'static', runtimeVersion: '1', framework: 'html' }
        payload = {
          ...id,
          deployMode: deployNow ? 'auto' : 'manual',
          method: siteType === 'php' ? 'php' : 'static',
          source: 'zip',
          uploadId,
          framework: siteType === 'php' ? 'php' : 'static',
          config,
        }
      } else {
        const m = getMethod(code.methodId)!
        const src = effectiveSource(m, code.source)
        const config: Record<string, unknown> = {}
        for (const f of visibleFields(m, src)) {
          const v = code.fields[f.id]
          if (v === undefined || v === '') continue
          if (f.type === 'number') {
            const n = Number(v)
            if (!Number.isNaN(n)) config[f.id] = n
          } else config[f.id] = v
        }
        if (m.runtime && !config.runtime) config.runtime = m.runtime
        if (m.defaultRuntimeVersion && !config.runtimeVersion) config.runtimeVersion = m.defaultRuntimeVersion
        const env = code.envVars.filter((v) => v.key.trim())
        if (env.length) config.envVars = env
        payload = {
          ...id,
          deployMode: deployNow ? 'auto' : 'manual',
          method: m.id,
          source: src,
          gitUrl: src === 'git' ? code.gitUrl.trim() : undefined,
          gitBranch: src === 'git' ? code.gitBranch.trim() || 'main' : undefined,
          gitProvider: src === 'git' ? code.gitProvider : undefined,
          gitToken: src === 'git' && code.gitToken ? code.gitToken : undefined,
          uploadId: src === 'zip' && codeZip.slot.status === 'done' ? codeZip.slot.result.uploadId : undefined,
          framework: m.stack || m.id,
          config,
        }
      }
      const res = await fetch('/api/hosting/create', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSubmitError(data.error || 'Your website could not be created.')
        return
      }
      const p = data.project
      onCreated?.({ id: p.id, name: p.name })
      setResult({
        kind: 'deploy',
        projectId: p.id,
        projectName: p.name,
        liveUrl: `https://${p.customDomain || p.subdomain}`,
        pendingDomain: (p.pendingDomain as PendingDomain | null) ?? null,
        manual: data.deployMode === 'manual',
      })
    } catch {
      setSubmitError('No connection to the server. Check your internet and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // ── Close ────────────────────────────────────────────────────────────
  const hasWork =
    !result &&
    (archive.slot.status !== 'empty' ||
      sql.slot.status !== 'empty' ||
      siteZip.slot.status !== 'empty' ||
      codeZip.slot.status !== 'empty' ||
      identity.name.trim() !== '' ||
      stepIndex > (startGoal && !intoExisting ? 2 : 1))
  const anyUploading = [archive, sql, siteZip, codeZip].some((u) => u.slot.status === 'uploading')
  const requestClose = () => {
    if (hasWork && !submitting) setConfirmClose(true)
    else onClose()
  }

  // ── Render helpers ───────────────────────────────────────────────────
  const text = STEP_TEXT[step]
  const progressView = result !== null
  const title = progressView
    ? result.kind === 'import'
      ? intoExisting
        ? `Import into ${target!.projectName}`
        : 'Moving your website'
      : 'Your new website'
    : intoExisting && step === 'backup'
      ? `Import into ${target!.projectName}`
      : text.title
  const description = progressView
    ? 'Follow each step below.'
    : intoExisting && step === 'backup'
      ? 'Replace this website’s files and database with a backup from another host.'
      : text.description

  return (
    <Dialog open={open} onOpenChange={(v) => !v && requestClose()}>
      <DialogContent
        className="flex max-h-[min(94dvh,880px)] w-[calc(100vw-1rem)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl md:min-h-[min(94dvh,600px)]"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <div className={cn('grid min-h-0 flex-1', !progressView && 'md:grid-cols-[13.5rem_1fr]')}>
          {/* Step rail (tablet and up) */}
          {!progressView && (
            <aside className="hidden min-h-0 flex-col border-e bg-muted/40 p-5 md:flex" aria-label="Steps">
              <p className="text-sm font-semibold">{intoExisting ? 'Import a backup' : 'New website'}</p>
              <ol className="mt-5 space-y-1">
                {steps.map((s, i) => {
                  const done = i < stepIndex
                  const current = i === stepIndex
                  return (
                    <li key={s}>
                      <button
                        type="button"
                        disabled={!done}
                        onClick={() => {
                          setShowErrors(false)
                          setStepIndex(i)
                        }}
                        aria-current={current ? 'step' : undefined}
                        className={cn(
                          'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-start text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                          current && 'bg-background font-medium shadow-xs',
                          done && 'text-foreground hover:bg-background/70',
                          !done && !current && 'text-muted-foreground'
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            'flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold tabular-nums',
                            current && 'border-primary bg-primary text-primary-foreground',
                            done && 'border-emerald-500 bg-emerald-500 text-white'
                          )}
                        >
                          {done ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                        </span>
                        <span className="truncate">{STEP_TEXT[s].label}</span>
                        {done && <span className="sr-only">(completed)</span>}
                      </button>
                    </li>
                  )
                })}
                {goal === null && !intoExisting && (
                  <li className="px-2 py-1.5 text-xs text-muted-foreground">The next steps depend on your choice.</li>
                )}
              </ol>
              {!intoExisting && (
                <div className="mt-auto pt-6">
                  <PlanNote usage={plan} />
                </div>
              )}
            </aside>
          )}

          <div className="flex min-h-0 flex-col">
            <header className="border-b px-5 pb-4 pt-5 pe-12 sm:px-6">
              {!progressView && (
                <div className="mb-2 md:hidden">
                  <p className="text-xs font-medium text-muted-foreground">
                    Step {stepIndex + 1} of {goal === null && !intoExisting ? '…' : steps.length} · {text.label}
                  </p>
                  <div className="mt-1.5 flex gap-1" aria-hidden>
                    {(goal === null && !intoExisting ? [0, 1, 2, 3] : steps.map((_, i) => i)).map((i) => (
                      <span key={i} className={cn('h-1 flex-1 rounded-full', i <= stepIndex ? 'bg-primary' : 'bg-border')} />
                    ))}
                  </div>
                </div>
              )}
              <DialogTitle asChild>
                <h2 ref={headingRef} tabIndex={-1} className="text-lg font-semibold leading-tight outline-none">
                  {title}
                </h2>
              </DialogTitle>
              <DialogDescription className="mt-1 max-sm:sr-only text-sm">{description}</DialogDescription>
            </header>

            <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">
              {progressView ? (
                result.kind === 'import' ? (
                  <ImportProgress
                    migrationId={result.migrationId}
                    initial={result.migration}
                    onFinished={onImportFinished}
                    onStartOver={reset}
                  />
                ) : result.manual ? (
                  <ManualCreated
                    name={result.projectName}
                    onOpen={() => {
                      onOpenProject?.(result.projectId)
                      onClose()
                    }}
                  />
                ) : (
                  <DeployProgress
                    projectId={result.projectId}
                    projectName={result.projectName}
                    liveUrl={result.liveUrl}
                    isWordPress={goal === 'wordpress'}
                    wpAdmin={goal === 'wordpress' ? { user: wp.user, password: wp.password } : undefined}
                    pendingDomain={result.pendingDomain}
                    branch={goal === 'code' ? code.gitBranch : undefined}
                    onOpenSite={() => {
                      onOpenProject?.(result.projectId)
                      onClose()
                    }}
                    onStartOver={reset}
                  />
                )
              ) : (
                <>
                  {blocked && step !== 'goal' ? (
                    <div className="mb-5">
                      <PlanBlocker usage={plan} onDone={onClose} />
                    </div>
                  ) : null}

                  {step === 'goal' && (
                    <div className="space-y-3">
                      {blocked && <PlanBlocker usage={plan} onDone={onClose} />}
                      <ul className="space-y-2">
                        {GOALS.map((g) => {
                          const Icon = g.icon
                          const selected = goal === g.id
                          return (
                            <li key={g.id}>
                              <button
                                type="button"
                                onClick={() => chooseGoal(g.id)}
                                aria-pressed={selected}
                                disabled={blocked}
                                className={cn(
                                  'group flex w-full items-start gap-4 rounded-lg border bg-card p-4 text-start outline-none transition-colors duration-150',
                                  'hover:border-primary/50 disabled:pointer-events-none disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
                                  selected && 'border-primary'
                                )}
                              >
                                <span
                                  aria-hidden
                                  className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground"
                                >
                                  <Icon className="size-5" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block font-medium">{g.title}</span>
                                  <span className="mt-0.5 block text-sm text-muted-foreground">{g.description}</span>
                                  <span className="mt-2 block text-xs text-muted-foreground">
                                    <span className="font-medium text-foreground">You’ll need:</span> {g.need}
                                  </span>
                                </span>
                                <ChevronRight
                                  aria-hidden
                                  className="mt-2.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                                />
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )}

                  {step === 'backup' && (
                    <BackupStep
                      value={backup}
                      onChange={setBackup}
                      sources={sources}
                      archive={smartArchive}
                      sql={sql}
                      showErrors={showErrors}
                    />
                  )}

                  {step === 'files' && (
                    <UploadSiteStep
                      zip={siteZip}
                      showErrors={showErrors}
                      siteType={siteType}
                      onSiteType={setSiteType}
                      framework={builtFramework}
                      onFramework={setBuiltFramework}
                      outputDir={outputDir}
                      onOutputDir={setOutputDir}
                      buildCommand={buildCommand}
                      onBuildCommand={setBuildCommand}
                      phpVersion={phpVersion}
                      onPhpVersion={setPhpVersion}
                    />
                  )}

                  {step === 'code' && (
                    <CodeStep
                      value={code}
                      onChange={setCode}
                      zip={codeZip}
                      showErrors={showErrors}
                      zipReady={uploadSlotFor(codeZip.slot)}
                    />
                  )}

                  {step === 'details' && (
                    <div className="space-y-8">
                      <SiteIdentity
                        value={identity}
                        onChange={setIdentity}
                        domains={domains}
                        domainsLoading={domainsLoading}
                        showErrors={showErrors}
                        onClose={onClose}
                      />
                      {goal === 'wordpress' && (
                        <WordPressAccount value={wp} onChange={setWp} errors={showErrors ? wpErrors : {}} />
                      )}
                      {anyUploading && <UploadTicker slots={pendingUploads} />}
                    </div>
                  )}

                  {step === 'confirm' && (
                    <div className="space-y-5">
                      <Summary
                        rows={summaryRows({
                          goal,
                          intoExisting,
                          targetName: target?.projectName,
                          identity,
                          wp,
                          backup,
                          source,
                          archive: archive.slot,
                          sql: sql.slot,
                          siteZip: siteZip.slot,
                          siteType,
                          code,
                          codeZip: codeZip.slot,
                        })}
                        onEdit={(i) => setStepIndex(i)}
                        steps={steps}
                      />

                      {intoExisting && (
                        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                          <p className="font-medium">This replaces the current site</p>
                          <p className="mt-0.5 text-muted-foreground">
                            The files and database of {target!.projectName} are replaced by the backup. A snapshot is
                            taken first, so the import can be undone.
                          </p>
                        </div>
                      )}

                      {goal === 'move' ? (
                        <MoreOptions label="Advanced import options" open={moreOpen} onToggle={() => setMoreOpen((v) => !v)}>
                          <Field
                            id="nw-original-url"
                            label="Current website address"
                            optional
                            error={showErrors && originalUrl.trim() && !isValidHttpUrl(originalUrl) ? 'Use a full address like https://my-old-site.com' : null}
                            hint="Only needed if we cannot read it from the backup. Links containing it are updated to the new address."
                          >
                            <Input
                              id="nw-original-url"
                              value={originalUrl}
                              inputMode="url"
                              spellCheck={false}
                              placeholder="https://my-old-site.com"
                              aria-describedby={describedBy('nw-original-url', null, true)}
                              onChange={(e) => setOriginalUrl(e.target.value)}
                            />
                          </Field>
                          <ToggleRow
                            id="nw-rewrite"
                            label="Update links to the new address"
                            hint="Turn off only if the site keeps exactly the same address."
                            checked={rewriteUrls}
                            onChange={setRewriteUrls}
                          />
                          <ToggleRow
                            id="nw-cache"
                            label="Switch off caching plugins"
                            hint="They remember the old server and can show a blank page here. They are switched off, not deleted."
                            checked={disableCache}
                            onChange={setDisableCache}
                          />
                        </MoreOptions>
                      ) : (
                        <MoreOptions label="More options" open={moreOpen} onToggle={() => setMoreOpen((v) => !v)}>
                          <ToggleRow
                            id="nw-deploy-now"
                            label={goal === 'wordpress' ? 'Install straight away' : 'Publish straight away'}
                            hint="Turn off to create the website without building it. You press Deploy on the website page when you are ready."
                            checked={deployNow}
                            onChange={setDeployNow}
                          />
                        </MoreOptions>
                      )}

                      {submitError && (
                        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                          <p className="font-medium">That did not work</p>
                          <p className="mt-0.5 text-muted-foreground">{submitError}</p>
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            {!progressView && step !== 'goal' && (
              <footer className="flex items-center justify-between gap-3 border-t px-5 py-3 sm:px-6">
                {stepIndex > 0 ? (
                  <Button type="button" variant="ghost" onClick={goBack} disabled={submitting}>
                    <ArrowLeft className="me-1.5 size-4" aria-hidden />
                    Back
                  </Button>
                ) : (
                  <span />
                )}
                {step === 'confirm' ? (
                  <Button
                    type="button"
                    onClick={() => void submit()}
                    disabled={submitting || uploadsBusy || uploadsBroken || blocked}
                    className="min-w-40"
                  >
                    {submitting ? (
                      <>
                        <Loader2 className="me-1.5 size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                        Starting…
                      </>
                    ) : uploadsBusy ? (
                      <>
                        <Loader2 className="me-1.5 size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                        Uploading… {uploadPct}%
                      </>
                    ) : uploadsBroken ? (
                      'Upload needs attention'
                    ) : submitError ? (
                      <>
                        <RefreshCw className="me-1.5 size-4" aria-hidden />
                        Try again
                      </>
                    ) : (
                      submitLabel(goal, intoExisting, deployNow)
                    )}
                  </Button>
                ) : (
                  <Button type="button" onClick={goNext} disabled={blocked}>
                    Continue
                    <ArrowRight className="ms-1.5 size-4" aria-hidden />
                  </Button>
                )}
              </footer>
            )}
            {progressView && (
              <footer className="flex justify-end border-t px-5 py-3 sm:px-6">
                <Button type="button" variant="outline" onClick={onClose}>
                  Close
                </Button>
              </footer>
            )}
          </div>
        </div>

        <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Leave without finishing?</AlertDialogTitle>
              <AlertDialogDescription>
                {anyUploading
                  ? 'Your upload stops and what you entered is lost. If you add the same file again later, the upload continues where it stopped.'
                  : 'What you entered so far is lost.'}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep going</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmClose(false)
                  onClose()
                }}
              >
                Leave
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

// ─── Pieces ──────────────────────────────────────────────────────────────

function submitLabel(goal: Goal | null, intoExisting: boolean, deployNow: boolean): string {
  if (goal === 'move') return intoExisting ? 'Start import' : 'Start moving my site'
  if (!deployNow) return 'Create website'
  if (goal === 'wordpress') return 'Create my WordPress site'
  if (goal === 'upload') return 'Publish my website'
  return 'Deploy'
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-describedby={`${id}-hint`} />
    </div>
  )
}

function WordPressAccount({
  value,
  onChange,
  errors,
}: {
  value: WpAccount
  onChange: (v: WpAccount) => void
  errors: Record<string, string>
}) {
  return (
    <fieldset className="space-y-4">
      <legend className="text-sm font-medium">Your WordPress login</legend>
      <p className="-mt-2 text-xs text-muted-foreground">
        You use this to sign in to WordPress and add pages, posts and products.
      </p>
      <Field id="nw-wp-email" label="Email" error={errors.email} hint="For password resets and WordPress notices.">
        <Input
          id="nw-wp-email"
          type="email"
          autoComplete="email"
          value={value.email}
          placeholder="you@example.com"
          aria-invalid={Boolean(errors.email)}
          aria-describedby={describedBy('nw-wp-email', errors.email, true)}
          onChange={(e) => onChange({ ...value, email: e.target.value })}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="nw-wp-user" label="Username" error={errors.user}>
          <Input
            id="nw-wp-user"
            autoComplete="off"
            value={value.user}
            aria-invalid={Boolean(errors.user)}
            aria-describedby={describedBy('nw-wp-user', errors.user)}
            onChange={(e) => onChange({ ...value, user: e.target.value })}
          />
        </Field>
        <Field id="nw-wp-pass" label="Password" error={errors.password} hint="We made a strong one. Change it if you like.">
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1">
              <SecretInput
                id="nw-wp-pass"
                value={value.password}
                onChange={(password) => onChange({ ...value, password })}
                invalid={Boolean(errors.password)}
                describedById={describedBy('nw-wp-pass', errors.password, true)}
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Make a new password"
              onClick={() => onChange({ ...value, password: generatePassword() })}
            >
              <RefreshCw className="size-4" aria-hidden />
            </Button>
          </div>
        </Field>
      </div>
    </fieldset>
  )
}

function UploadSiteStep(props: {
  zip: FileUpload
  showErrors: boolean
  siteType: UploadSiteType
  onSiteType: (v: UploadSiteType) => void
  framework: string
  onFramework: (v: string) => void
  outputDir: string
  onOutputDir: (v: string) => void
  buildCommand: string
  onBuildCommand: (v: string) => void
  phpVersion: string
  onPhpVersion: (v: string) => void
}) {
  const { zip, showErrors, siteType } = props
  return (
    <div className="space-y-6">
      <div>
        <FileDrop
          label="Website ZIP"
          rules={zipRules}
          upload={zip}
          description="Put index.html (or index.php) at the top of the ZIP, not inside an extra folder."
        />
        {showErrors && zip.slot.status === 'empty' && !zip.slot.error && (
          <p className="mt-2 text-xs text-destructive">Add the ZIP file of your website.</p>
        )}
      </div>
      <ChoiceList<UploadSiteType>
        name="nw-site-type"
        legend="What is in the ZIP?"
        value={siteType}
        onChange={props.onSiteType}
        choices={[
          { value: 'html', title: 'A finished HTML website', description: 'HTML, CSS, images and JavaScript, ready to show. Most common.' },
          { value: 'php', title: 'A PHP website', description: 'Files ending in .php that run on the server.' },
          { value: 'built', title: 'A project that needs building', description: 'React, Vue, Angular, Astro or Svelte source code with a build step.' },
        ]}
      >
        {(t) =>
          t === 'php' ? (
            <Field id="nw-php" label="PHP version" hint="8.2 suits most sites.">
              <Select value={props.phpVersion} onValueChange={props.onPhpVersion}>
                <SelectTrigger id="nw-php" className="w-full sm:w-48" aria-describedby="nw-php-hint">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['8.3', '8.2', '8.1', '8.0', '7.4'].map((v) => (
                    <SelectItem key={v} value={v}>
                      PHP {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          ) : t === 'built' ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field id="nw-fw" label="Framework">
                <Select value={props.framework} onValueChange={props.onFramework}>
                  <SelectTrigger id="nw-fw" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[
                      ['react', 'React'],
                      ['vue', 'Vue'],
                      ['angular', 'Angular'],
                      ['astro', 'Astro'],
                      ['svelte', 'Svelte'],
                      ['gatsby', 'Gatsby'],
                    ].map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field id="nw-build" label="Build command">
                <Input id="nw-build" className="font-mono text-xs" value={props.buildCommand} onChange={(e) => props.onBuildCommand(e.target.value)} />
              </Field>
              <Field id="nw-out" label="Output folder">
                <Input id="nw-out" className="font-mono text-xs" value={props.outputDir} onChange={(e) => props.onOutputDir(e.target.value)} />
              </Field>
            </div>
          ) : null
        }
      </ChoiceList>
    </div>
  )
}

function UploadTicker({ slots }: { slots: FileSlot[] }) {
  const busy = slots.filter((s) => s.status === 'uploading') as Array<Extract<FileSlot, { status: 'uploading' }>>
  if (busy.length === 0) return null
  return (
    <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      {busy.map((s) => `${s.name}: ${Math.floor((s.progress.loaded / Math.max(1, s.size)) * 100)}%`).join(' · ')} — still uploading
      in the background.
    </div>
  )
}

interface SummaryRow {
  label: string
  value: ReactNode
  step: StepId
}

function summaryRows(a: {
  goal: Goal | null
  intoExisting: boolean
  targetName?: string
  identity: IdentityValue
  wp: WpAccount
  backup: BackupValue
  source: SourceDefinition | null
  archive: FileSlot
  sql: FileSlot
  siteZip: FileSlot
  siteType: UploadSiteType
  code: CodeValue
  codeZip: FileSlot
}): SummaryRow[] {
  const fileText = (s: FileSlot) =>
    s.status === 'done'
      ? `${s.result.filename} · ${formatBytes(s.result.sizeBytes)}`
      : s.status === 'uploading'
        ? `${s.name} · uploading ${Math.floor((s.progress.loaded / Math.max(1, s.size)) * 100)}%`
        : s.status === 'paused'
          ? `${s.name} · upload paused`
          : s.status === 'failed'
            ? `${s.name} · upload failed`
            : '—'
  const rows: SummaryRow[] = []
  if (!a.intoExisting) {
    rows.push({ label: 'Website', value: a.identity.name.trim(), step: 'details' })
    rows.push({ label: 'Address', value: addressSummary(a.identity), step: 'details' })
  } else {
    rows.push({ label: 'Website', value: a.targetName, step: 'backup' })
  }
  if (a.goal === 'wordpress') {
    rows.push({ label: 'Type', value: 'WordPress', step: 'goal' })
    rows.push({ label: 'WordPress login', value: `${a.wp.user} · ${a.wp.email}`, step: 'details' })
  }
  if (a.goal === 'move') {
    rows.push({ label: 'Backup type', value: a.source?.name ?? '—', step: 'backup' })
    if (a.backup.mode === 'upload') {
      rows.push({ label: 'Backup file', value: fileText(a.archive), step: 'backup' })
      if (a.sql.status !== 'empty') rows.push({ label: 'Database file', value: fileText(a.sql), step: 'backup' })
    } else if (a.backup.mode === 'url') {
      rows.push({ label: 'Download link', value: <span className="break-all">{a.backup.remoteUrl}</span>, step: 'backup' })
    } else {
      rows.push({
        label: 'Repository',
        value: <span className="break-all">{`${a.backup.gitUrl}${a.backup.gitBranch ? ` (${a.backup.gitBranch})` : ''}`}</span>,
        step: 'backup',
      })
    }
  }
  if (a.goal === 'upload') {
    rows.push({ label: 'Files', value: fileText(a.siteZip), step: 'files' })
    rows.push({
      label: 'Type',
      value: a.siteType === 'html' ? 'HTML website' : a.siteType === 'php' ? 'PHP website' : 'Project with a build step',
      step: 'files',
    })
  }
  if (a.goal === 'code') {
    const m = getMethod(a.code.methodId)
    const src = effectiveSource(m, a.code.source)
    rows.push({ label: 'Technology', value: m?.name ?? '—', step: 'code' })
    rows.push({
      label: 'Source',
      value:
        src === 'git' ? (
          <span className="break-all">{`${a.code.gitUrl} (${a.code.gitBranch || 'main'})`}</span>
        ) : src === 'zip' ? (
          fileText(a.codeZip)
        ) : (
          'Empty starter project'
        ),
      step: 'code',
    })
  }
  return rows
}

function Summary({ rows, steps, onEdit }: { rows: SummaryRow[]; steps: StepId[]; onEdit: (index: number) => void }) {
  return (
    <dl className="divide-y rounded-lg border">
      {rows.map((r) => {
        const index = steps.indexOf(r.step)
        return (
          <div key={r.label} className="grid grid-cols-[7.5rem_1fr_auto] items-start gap-3 px-3 py-2.5 text-sm sm:grid-cols-[10rem_1fr_auto]">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="min-w-0 font-medium">{r.value || '—'}</dd>
            {index >= 0 ? (
              <button
                type="button"
                onClick={() => onEdit(index)}
                className="rounded text-xs font-medium text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Change ${r.label.toLowerCase()}`}
              >
                Change
              </button>
            ) : (
              <span />
            )}
          </div>
        )
      })}
    </dl>
  )
}

function ManualCreated({ name, onOpen }: { name: string; onOpen: () => void }) {
  return (
    <div className="space-y-4">
      <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
        <p className="text-sm font-semibold">{name} was created</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Nothing has been published yet, so its address shows nothing. Open the website and press Deploy when you are
          ready.
        </p>
      </div>
      <div className="flex justify-end">
        <Button type="button" onClick={onOpen}>
          Open website
          <ArrowRight className="ms-1.5 size-4" aria-hidden />
        </Button>
      </div>
    </div>
  )
}
