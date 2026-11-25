'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, Check, Loader2, X } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

export type PhaseStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface Phase {
  id: string
  label: string
  /** What happens in this phase, in plain words. */
  description: string
  status: PhaseStatus
}

export type ProgressTone = 'running' | 'success' | 'failed' | 'stopped'

/**
 * The shared "what is happening" view: one headline, a bar, and a short list
 * of named phases with the current one called out and the next one named.
 * Used for both a new site being set up and an import being restored.
 */
export function ProgressTimeline({
  tone,
  headline,
  subline,
  percent,
  phases,
  banner,
  actions,
  children,
}: {
  tone: ProgressTone
  headline: string
  subline?: ReactNode
  percent: number
  phases: Phase[]
  /** Success or failure explanation, shown above the phase list. */
  banner?: ReactNode
  actions?: ReactNode
  /** Folded technical details. */
  children?: ReactNode
}) {
  const current = phases.find((p) => p.status === 'running')
  const currentIndex = current ? phases.indexOf(current) : -1
  const next = currentIndex >= 0 ? phases.slice(currentIndex + 1).find((p) => p.status === 'pending') : undefined
  const pct = Math.max(0, Math.min(100, Math.round(percent)))

  return (
    <div className="space-y-5">
      <div>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold leading-snug">{headline}</h3>
            {subline && <p className="mt-1 text-sm text-muted-foreground">{subline}</p>}
          </div>
          <span
            className={cn(
              'shrink-0 text-2xl font-semibold tabular-nums tracking-tight',
              tone === 'failed' ? 'text-destructive' : tone === 'success' ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'
            )}
          >
            {pct}%
          </span>
        </div>
        <Progress
          value={pct}
          aria-label="Overall progress"
          className={cn(
            'mt-3 h-2',
            tone === 'failed' && 'bg-destructive/15 [&>div]:bg-destructive',
            tone === 'stopped' && 'bg-amber-500/15 [&>div]:bg-amber-500',
            tone === 'success' && 'bg-emerald-500/15 [&>div]:bg-emerald-500'
          )}
        />
      </div>

      {/* Polite, single announcement of the phase — not every percent. */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {tone === 'running'
          ? current
            ? `Now: ${current.label}.${next ? ` Next: ${next.label}.` : ''}`
            : headline
          : headline}
      </p>

      {banner}

      {/* A finished run leads with its next step; a running one keeps
          the quiet Cancel below the list. */}
      {tone !== 'running' && actions && (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{actions}</div>
      )}

      {tone === 'running' && current && (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-primary/30 bg-primary/[0.04] p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-primary">Now</p>
            <p className="mt-1 text-sm font-medium">{current.label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{current.description}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next</p>
            <p className="mt-1 text-sm font-medium">{next ? next.label : 'Your site goes live'}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {next ? next.description : 'We will show you the address as soon as it is ready.'}
            </p>
          </div>
        </div>
      )}

      <ol className="relative space-y-0" aria-label="Steps">
        {phases.map((p, i) => {
          const last = i === phases.length - 1
          return (
            <li key={p.id} className="relative flex gap-3 pb-4 last:pb-0">
              {!last && (
                <span
                  aria-hidden
                  className={cn(
                    'absolute start-[11px] top-7 h-[calc(100%-1.75rem)] w-px',
                    p.status === 'done' ? 'bg-emerald-500/50' : 'bg-border'
                  )}
                />
              )}
              <PhaseDot status={p.status} />
              <div className="min-w-0 pt-0.5">
                <p
                  className={cn(
                    'text-sm',
                    p.status === 'running' && 'font-medium',
                    p.status === 'failed' && 'font-medium text-destructive',
                    (p.status === 'pending' || p.status === 'skipped') && 'text-muted-foreground'
                  )}
                >
                  {p.label}
                  <span className="sr-only">
                    {' — '}
                    {p.status === 'done'
                      ? 'done'
                      : p.status === 'running'
                        ? 'in progress'
                        : p.status === 'failed'
                          ? 'failed'
                          : p.status === 'skipped'
                            ? 'not needed'
                            : 'waiting'}
                  </span>
                </p>
                {(p.status === 'running' || p.status === 'failed') && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{p.description}</p>
                )}
              </div>
            </li>
          )
        })}
      </ol>

      {tone === 'running' && actions && (
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{actions}</div>
      )}

      {children}
    </div>
  )
}

function PhaseDot({ status }: { status: PhaseStatus }) {
  const base = 'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full'
  if (status === 'done')
    return (
      <span className={cn(base, 'bg-emerald-500 text-white')} aria-hidden>
        <Check className="size-3.5" strokeWidth={3} />
      </span>
    )
  if (status === 'running')
    return (
      <span className={cn(base, 'bg-primary text-primary-foreground')} aria-hidden>
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
      </span>
    )
  if (status === 'failed')
    return (
      <span className={cn(base, 'bg-destructive text-white')} aria-hidden>
        <X className="size-3.5" strokeWidth={3} />
      </span>
    )
  return <span className={cn(base, 'border-2 border-border bg-background')} aria-hidden />
}

/** Explanation box for a finished run. */
export function OutcomeBanner({
  tone,
  title,
  children,
}: {
  tone: 'success' | 'failed' | 'stopped'
  title: string
  children: ReactNode
}) {
  return (
    <div
      role={tone === 'failed' ? 'alert' : 'status'}
      className={cn(
        'rounded-lg border p-4',
        tone === 'success' && 'border-emerald-500/30 bg-emerald-500/5',
        tone === 'failed' && 'border-destructive/30 bg-destructive/5',
        tone === 'stopped' && 'border-amber-500/30 bg-amber-500/5'
      )}
    >
      <p className="flex items-center gap-2 text-sm font-semibold">
        {tone === 'success' ? (
          <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
        ) : (
          <AlertTriangle className={cn('size-4', tone === 'failed' ? 'text-destructive' : 'text-amber-600')} aria-hidden />
        )}
        {title}
      </p>
      <div className="mt-1.5 space-y-2 text-sm text-muted-foreground">{children}</div>
    </div>
  )
}

/** "Technical details" fold, closed by default. */
export function TechnicalDetails({ children, label = 'Technical details' }: { children: ReactNode; label?: string }) {
  return (
    <details className="group rounded-lg border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-3 py-2.5 text-sm font-medium outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {label}
        <span className="text-xs font-normal text-muted-foreground group-open:hidden">Show</span>
        <span className="hidden text-xs font-normal text-muted-foreground group-open:inline">Hide</span>
      </summary>
      <div className="space-y-3 border-t p-3">{children}</div>
    </details>
  )
}

/** A compact technical stage list for the details fold. */
export function StageList({
  stages,
}: {
  stages: Array<{ key: string; label: string; status: string; note?: string | null; duration?: string }>
}) {
  return (
    <ul className="space-y-1 text-xs">
      {stages.map((s) => (
        <li key={s.key} className="flex items-start gap-2">
          <span
            aria-hidden
            className={cn(
              'mt-1 size-1.5 shrink-0 rounded-full',
              s.status === 'completed' && 'bg-emerald-500',
              s.status === 'running' && 'bg-primary',
              s.status === 'failed' && 'bg-destructive',
              (s.status === 'pending' || s.status === 'skipped' || s.status === 'rolled_back') && 'bg-muted-foreground/40'
            )}
          />
          <span className="min-w-0 flex-1">
            <span className={cn(s.status === 'pending' && 'text-muted-foreground')}>{s.label}</span>
            <span className="text-muted-foreground"> · {s.status.replace('_', ' ')}</span>
            {s.duration && <span className="text-muted-foreground"> · {s.duration}</span>}
            {s.note && <span className="mt-0.5 block break-words text-destructive">{s.note}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function LogBlock({ lines, label }: { lines: string[]; label: string }) {
  if (lines.length === 0) return null
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
      <pre
        tabIndex={0}
        className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-300 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {lines.slice(-400).join('\n')}
      </pre>
    </div>
  )
}
