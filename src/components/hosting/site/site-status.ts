/**
 * What a website's status means, in words a site owner understands.
 *
 * Project.status is one of creating | running | stopped | error | deploying |
 * building | deleting | suspended. The raw value is still shown in the
 * container details; the header shows this plain meaning instead.
 *
 * Pure module so the rules are unit-tested.
 */

export type StatusTone = 'success' | 'progress' | 'neutral' | 'warning' | 'danger'

/** What the status banner's button should do. */
export type StatusAction = 'view-deploy-log' | 'open-import' | 'redeploy' | null

export interface SiteStatusMeaning {
  label: string
  tone: StatusTone
  /** One sentence shown under the header when the site is not simply live. */
  detail: string | null
  action: StatusAction
  actionLabel: string | null
}

export interface StatusInput {
  status: string
  deploymentSource?: string | null
  lastDeployment?: { status: string } | null
}

export function describeSiteStatus(p: StatusInput): SiteStatusMeaning {
  const lastFailed = p.lastDeployment?.status === 'failed'
  switch (p.status) {
    case 'running':
      if (lastFailed) {
        return {
          label: 'Live',
          tone: 'warning',
          detail: 'Your site is online, but the latest deploy failed, so it is still serving the previous version.',
          action: 'view-deploy-log',
          actionLabel: 'See why',
        }
      }
      return { label: 'Live', tone: 'success', detail: null, action: null, actionLabel: null }
    case 'creating':
      if (p.deploymentSource === 'imported') {
        return {
          label: 'Waiting for import',
          tone: 'progress',
          detail: 'This website will go live once its import finishes. You can follow the import under Backups.',
          action: 'open-import',
          actionLabel: 'View import',
        }
      }
      return {
        label: 'Setting up',
        tone: 'progress',
        detail: 'Your website is being created. This usually takes a minute or two.',
        action: null,
        actionLabel: null,
      }
    case 'building':
    case 'deploying':
      return {
        label: 'Deploying',
        tone: 'progress',
        detail: 'A new version is being deployed. Visitors keep seeing the current version until it finishes.',
        action: 'view-deploy-log',
        actionLabel: 'Watch progress',
      }
    case 'stopped':
      return {
        label: 'Stopped',
        tone: 'neutral',
        detail: 'Your site is offline. Visitors see an error page until you start it again.',
        action: 'redeploy',
        actionLabel: 'Start site',
      }
    case 'error':
      return {
        label: 'Deploy failed',
        tone: 'danger',
        detail: lastFailed || p.lastDeployment
          ? 'The last deploy did not finish, so the site is not running. The build log shows what went wrong.'
          : 'The site could not be started. Try deploying it again.',
        action: p.lastDeployment ? 'view-deploy-log' : 'redeploy',
        actionLabel: p.lastDeployment ? 'See why' : 'Deploy again',
      }
    case 'suspended':
      return {
        label: 'Suspended',
        tone: 'danger',
        detail: 'This website is suspended, usually because of an unpaid invoice. Check Billing or contact support.',
        action: null,
        actionLabel: null,
      }
    case 'deleting':
      return {
        label: 'Deleting',
        tone: 'neutral',
        detail: 'This website is being deleted.',
        action: null,
        actionLabel: null,
      }
    default:
      return { label: p.status || 'Unknown', tone: 'neutral', detail: null, action: null, actionLabel: null }
  }
}

/** Tailwind classes per tone. One place, so every status badge matches. */
export const TONE_CLASSES: Record<StatusTone, { badge: string; dot: string; banner: string }> = {
  success: {
    badge: 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300',
    dot: 'bg-emerald-500',
    banner: 'border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-100',
  },
  progress: {
    badge: 'border-indigo-200 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-200',
    dot: 'bg-indigo-500 animate-pulse motion-reduce:animate-none',
    banner: 'border-indigo-200 bg-indigo-50 text-indigo-950 dark:border-indigo-800 dark:bg-indigo-950/40 dark:text-indigo-100',
  },
  neutral: {
    badge: 'border-border bg-muted text-muted-foreground',
    dot: 'bg-muted-foreground/60',
    banner: 'border-border bg-muted/60 text-foreground',
  },
  warning: {
    badge: 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200',
    dot: 'bg-amber-500',
    banner: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100',
  },
  danger: {
    badge: 'border-red-200 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300',
    dot: 'bg-red-500',
    banner: 'border-red-200 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-100',
  },
}
