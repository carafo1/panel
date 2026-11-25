'use client'

/**
 * Progress for a brand-new site (WordPress install, uploaded site, or code).
 *
 * Polls GET /api/hosting/[id]/stages, which returns the latest deployment's
 * status and its stages. The thirteen deployer stages are grouped into six
 * phases a customer can follow. Retry re-runs the deployment through
 * POST /api/hosting/[id]/deploy.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Check, Copy, ExternalLink, Eye, EyeOff, LifeBuoy, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store/app-store'
import { explainFailure } from './friendly-errors'
import { formatDuration } from './format'
import {
  LogBlock,
  OutcomeBanner,
  ProgressTimeline,
  StageList,
  TechnicalDetails,
  type Phase,
  type PhaseStatus,
} from './progress-timeline'

interface StageRow {
  id: string
  name: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped'
  message?: string | null
  log?: string | null
  order: number
  durationMs?: number | null
}

export interface PendingDomain {
  domain: string
  txtRecord: { type: string; name: string; value: string }
  aRecord: { type: string; name: string; value: string[] }
}

const PHASES: Array<{ id: string; label: string; description: string; stages: string[] }> = [
  {
    id: 'prepare',
    label: 'Preparing your space',
    description: 'Reserving a place for your site on the server.',
    stages: ['plan', 'create_directory'],
  },
  {
    id: 'files',
    label: 'Getting your files',
    description: 'Fetching your site’s files.',
    stages: ['download_source'],
  },
  {
    id: 'database',
    label: 'Setting up the database',
    description: 'Creating a private database for your site.',
    stages: ['provision_database'],
  },
  {
    id: 'build',
    label: 'Building your site',
    description: 'Packaging your site so it can run.',
    stages: ['write_dockerfile', 'write_compose', 'build_image'],
  },
  {
    id: 'start',
    label: 'Starting your site',
    description: 'Switching your site on and finishing its setup.',
    stages: ['start_container', 'run_migrations', 'post_install'],
  },
  {
    id: 'live',
    label: 'Going live',
    description: 'Connecting your address, issuing HTTPS and checking the site loads.',
    stages: ['configure_proxy', 'configure_ssl', 'verify'],
  },
]

const DONE_STATUSES = ['live', 'completed', 'success', 'succeeded']

function toPhases(stages: StageRow[], state: 'running' | 'live' | 'failed', isWordPress: boolean): Phase[] {
  const known = new Set(PHASES.flatMap((p) => p.stages))
  const phases: Phase[] = PHASES.map((p) => {
    const members = stages.filter(
      (s) => p.stages.includes(s.name) || (p.id === 'start' && !known.has(s.name))
    )
    let status: PhaseStatus = 'pending'
    if (members.some((s) => s.status === 'failed')) status = 'failed'
    else if (members.length > 0 && members.every((s) => s.status === 'skipped')) status = 'skipped'
    else if (members.length > 0 && members.every((s) => s.status === 'completed' || s.status === 'skipped'))
      status = 'done'
    else if (members.some((s) => s.status === 'running')) status = 'running'
    else if (members.some((s) => s.status === 'completed')) status = 'running'
    const label = p.id === 'files' && isWordPress ? 'Downloading WordPress' : p.label
    return { id: p.id, label, description: p.description, status }
  })
    // A stage set without, say, a database step should not show an empty phase.
    .filter((p, i) => stages.length === 0 || stages.some((s) => PHASES[i].stages.includes(s.name) || (PHASES[i].id === 'start' && !known.has(s.name))))

  if (state === 'live') return phases.map((p) => (p.status === 'skipped' ? p : { ...p, status: 'done' }))
  if (state === 'running' && !phases.some((p) => p.status === 'running' || p.status === 'failed')) {
    const first = phases.find((p) => p.status === 'pending')
    if (first) first.status = 'running'
  }
  return phases
}

export function DeployProgress({
  projectId,
  projectName,
  liveUrl,
  isWordPress,
  wpAdmin,
  pendingDomain,
  branch,
  onOpenSite,
  onStartOver,
}: {
  projectId: string
  projectName: string
  liveUrl: string
  isWordPress: boolean
  wpAdmin?: { user: string; password: string }
  pendingDomain?: PendingDomain | null
  branch?: string
  onOpenSite: () => void
  onStartOver: () => void
}) {
  const setDashboardTab = useAppStore((s) => s.setDashboardTab)
  const [stages, setStages] = useState<StageRow[]>([])
  const [deployStatus, setDeployStatus] = useState<string | null>(null)
  const [buildLog, setBuildLog] = useState<string>('')
  const [retrying, setRetrying] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const startedAt = useRef(Date.now())

  const failed = deployStatus === 'failed' || stages.some((s) => s.status === 'failed')
  const live =
    !failed &&
    ((deployStatus !== null && DONE_STATUSES.includes(deployStatus)) ||
      (stages.length > 0 && stages.every((s) => s.status === 'completed' || s.status === 'skipped')))
  const state: 'running' | 'live' | 'failed' = failed ? 'failed' : live ? 'live' : 'running'

  const poll = useCallback(async () => {
    try {
      const res = await fetch(`/api/hosting/${projectId}/stages`, { credentials: 'same-origin' })
      if (res.ok) {
        const data = await res.json()
        if (Array.isArray(data.stages)) setStages(data.stages as StageRow[])
        setDeployStatus(data.deployment?.status ?? null)
        setBuildLog(data.deployment?.buildLog ?? '')
      }
    } catch {
      // keep polling
    }
  }, [projectId])

  useEffect(() => {
    if (state !== 'running') return
    let stop = false
    const tick = async () => {
      await poll()
      if (!stop) timer.current = setTimeout(tick, 1500)
    }
    void tick()
    return () => {
      stop = true
      if (timer.current) clearTimeout(timer.current)
    }
  }, [state, poll])

  const retry = useCallback(async () => {
    setRetrying(true)
    try {
      const res = await fetch(`/api/hosting/${projectId}/deploy`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch: branch || 'main' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.error || 'Could not start again. Please try in a moment.')
        return
      }
      setStages([])
      setDeployStatus(null)
      setBuildLog('')
      startedAt.current = Date.now()
    } catch {
      toast.error('No connection to the server. Check your internet and try again.')
    } finally {
      setRetrying(false)
    }
  }, [projectId, branch])

  const phases = toPhases(stages, state, isWordPress)
  const total = stages.length
  const doneCount = stages.filter((s) => s.status === 'completed' || s.status === 'skipped').length
  const running = stages.some((s) => s.status === 'running') ? 0.5 : 0
  const percent = state === 'live' ? 100 : total ? ((doneCount + running) / total) * 100 : 2

  const failedStage = stages.find((s) => s.status === 'failed')
  const rawError = failedStage?.message || failedStage?.log?.split('\n').filter(Boolean).slice(-1)[0] || (failed ? buildLog.split('\n').filter(Boolean).slice(-1)[0] : null)
  const explanation = explainFailure(`${failedStage?.label ?? ''} ${rawError ?? ''}`, 'deploy')

  const verb = isWordPress ? 'Installing WordPress for' : 'Setting up'
  let headline = `${verb} ${projectName}`
  let subline: ReactNode = 'You can close this window — setup continues and your website list shows its status.'
  let banner: ReactNode = null
  let actions: ReactNode = null

  if (state === 'live') {
    headline = 'Your website is ready'
    subline = undefined
    banner = (
      <OutcomeBanner tone="success" title="It is online">
        <p>
          <a href={liveUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-foreground underline underline-offset-2">
            {liveUrl}
          </a>
        </p>
        <p>The HTTPS certificate is issued on the first visit, which can take a few seconds.</p>
      </OutcomeBanner>
    )
    actions = (
      <>
        <Button type="button" variant="ghost" onClick={onStartOver}>
          Add another website
        </Button>
        <Button type="button" variant="outline" onClick={onOpenSite}>
          Manage website
        </Button>
        <Button asChild>
          <a href={liveUrl} target="_blank" rel="noopener noreferrer">
            Visit your site
            <ExternalLink className="ms-1.5 size-4" aria-hidden />
          </a>
        </Button>
      </>
    )
  } else if (state === 'failed') {
    headline = explanation.title
    subline = failedStage ? `It stopped at: ${failedStage.label.replace(/…$/, '')}.` : undefined
    banner = (
      <OutcomeBanner tone="failed" title="What happened">
        <p>{explanation.body}</p>
        <p>Your website was created and keeps its name and address, so trying again does not create a second one.</p>
      </OutcomeBanner>
    )
    actions = (
      <>
        <Button type="button" variant="ghost" onClick={() => setDashboardTab('support')}>
          <LifeBuoy className="me-1.5 size-4" aria-hidden />
          Contact support
        </Button>
        <Button type="button" onClick={() => void retry()} disabled={retrying}>
          {retrying ? (
            <Loader2 className="me-1.5 size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <RefreshCw className="me-1.5 size-4" aria-hidden />
          )}
          Try again
        </Button>
      </>
    )
  }

  const logLines = (stages.find((s) => s.status === 'running')?.log || failedStage?.log || buildLog || '')
    .split('\n')
    .filter(Boolean)

  return (
    <ProgressTimeline
      tone={state === 'live' ? 'success' : state === 'failed' ? 'failed' : 'running'}
      headline={headline}
      subline={subline}
      percent={percent}
      phases={phases}
      banner={
        <>
          {banner}
          {state === 'live' && isWordPress && wpAdmin && <WordPressLogin url={liveUrl} {...wpAdmin} />}
          {state === 'live' && pendingDomain && <DnsRecords pending={pendingDomain} />}
        </>
      }
      actions={actions}
    >
      <TechnicalDetails>
        {rawError && failed && (
          <p className="break-words rounded-md bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">{rawError}</p>
        )}
        <StageList
          stages={stages.map((s) => ({
            key: s.id || s.name,
            label: s.label.replace(/…$/, ''),
            status: s.status,
            note: s.status === 'failed' ? s.message : null,
            duration: formatDuration(s.durationMs),
          }))}
        />
        <LogBlock lines={logLines} label="Log" />
      </TechnicalDetails>
    </ProgressTimeline>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7"
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          },
          () => toast.error('Could not copy — select the text instead.')
        )
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
    </Button>
  )
}

function WordPressLogin({ url, user, password }: { url: string; user: string; password: string }) {
  const [show, setShow] = useState(false)
  const admin = `${url.replace(/\/$/, '')}/wp-admin`
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm font-semibold">Your WordPress login</p>
      <p className="mt-0.5 text-xs text-muted-foreground">Save these now — the password is not shown again.</p>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
        <dt className="text-muted-foreground">Admin page</dt>
        <dd className="flex min-w-0 items-center gap-1">
          <a href={admin} target="_blank" rel="noopener noreferrer" className="truncate font-mono text-xs text-primary underline-offset-2 hover:underline">
            {admin}
          </a>
          <CopyButton value={admin} label="admin page address" />
        </dd>
        <dt className="text-muted-foreground">Username</dt>
        <dd className="flex items-center gap-1 font-mono text-xs">
          {user}
          <CopyButton value={user} label="username" />
        </dd>
        <dt className="text-muted-foreground">Password</dt>
        <dd className="flex items-center gap-1 font-mono text-xs">
          <span>{show ? password : '•'.repeat(12)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={show ? 'Hide password' : 'Show password'}
            onClick={() => setShow((v) => !v)}
          >
            {show ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
          </Button>
          <CopyButton value={password} label="password" />
        </dd>
      </dl>
    </div>
  )
}

function DnsRecords({ pending }: { pending: PendingDomain }) {
  const ips = pending.aRecord.value.filter(Boolean)
  const rows = [
    ...(ips.length > 0 ? [{ type: pending.aRecord.type, name: pending.aRecord.name, value: ips.join(', ') }] : []),
    { type: pending.txtRecord.type, name: pending.txtRecord.name, value: pending.txtRecord.value },
  ]
  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm font-semibold">Connect {pending.domain}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Add {rows.length === 1 ? 'this record' : 'these records'} where your domain is registered. It connects by
        itself once {rows.length === 1 ? 'it is' : 'they are'} visible — DNS changes can take a while to spread. Until then your site works
        on the address above.
        {ips.length === 0 && ' The A record (your server address) is shown on the website’s Domains page.'}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[28rem] text-xs">
          <thead>
            <tr className="text-start text-muted-foreground">
              <th scope="col" className="pb-1.5 pe-3 text-start font-medium">Type</th>
              <th scope="col" className="pb-1.5 pe-3 text-start font-medium">Name</th>
              <th scope="col" className="pb-1.5 text-start font-medium">Value</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((r) => (
              <tr key={r.type} className="border-t">
                <td className="py-1.5 pe-3">{r.type}</td>
                <td className="break-all py-1.5 pe-3">{r.name}</td>
                <td className="py-1.5">
                  <span className="flex items-center gap-1 break-all">
                    {r.value}
                    <CopyButton value={r.value} label={`${r.type} value`} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
