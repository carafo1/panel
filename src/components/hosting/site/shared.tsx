'use client'

/**
 * Small building blocks shared by the website page: request headers, date
 * formatting and the inline loading / empty / error states every area uses
 * (so a failed load is shown where the customer is looking, not as a toast).
 */
import type { ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** The httpOnly session cookie authenticates same-origin requests. */
export function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' }
}

export function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const t = new Date(dateStr).getTime()
  if (!Number.isFinite(t)) return '—'
  const seconds = Math.floor((Date.now() - t) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months} mo ago`
  return `${Math.floor(months / 12)} y ago`
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (!Number.isFinite(d.getTime())) return dateStr
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** A failed load, inline, with a retry. Announced to screen readers. */
export function InlineError({
  title = 'Could not load this',
  message,
  onRetry,
  className,
}: {
  title?: string
  message?: string | null
  onRetry?: () => void
  className?: string
}) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col gap-3 rounded-lg border border-red-200 bg-red-50/70 p-4 text-sm text-red-950 sm:flex-row sm:items-center dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100',
        className
      )}
    >
      <AlertTriangle className="size-4 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {message && <p className="mt-0.5 break-words text-red-900/80 dark:text-red-100/80">{message}</p>}
      </div>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="shrink-0 bg-background">
          <RefreshCw className="size-3.5" aria-hidden />
          Try again
        </Button>
      )}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
}: {
  icon?: ReactNode
  title: string
  children?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-center px-4 py-10 text-center', className)}>
      {icon && <div className="mb-3 text-muted-foreground/60 [&_svg]:size-8">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="mt-1 max-w-sm text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

export function LoadingRows({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full" />
      ))}
    </div>
  )
}

/** Heading block used at the top of an area. */
export function AreaHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
