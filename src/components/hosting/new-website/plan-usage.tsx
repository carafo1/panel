'use client'

import { useEffect, useState } from 'react'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAppStore } from '@/store/app-store'

export interface PlanUsage {
  loading: boolean
  planName: string | null
  used: number
  /** null = unlimited (the plan stores unlimited as 0). */
  limit: number | null
  /** Staff can create sites without a plan. */
  isStaff: boolean
  noPlan: boolean
  atLimit: boolean
}

const EMPTY: PlanUsage = {
  loading: true,
  planName: null,
  used: 0,
  limit: null,
  isStaff: false,
  noPlan: false,
  atLimit: false,
}

/** Reads the active plan and how many websites the customer already has. */
export function usePlanUsage(active: boolean): PlanUsage {
  const [state, setState] = useState<PlanUsage>(EMPTY)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    setState((s) => ({ ...s, loading: true }))
    void Promise.all([
      fetch('/api/auth/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/hosting', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([me, hosting]) => {
        if (cancelled) return
        const user = me?.user
        const role: string = user?.role ?? 'user'
        const isStaff = role === 'admin' || role === 'super_admin'
        const sub = (user?.subscriptions ?? []).find(
          (s: { status: string }) => s.status === 'active'
        ) as { plan?: { name: string; projects: number } } | undefined
        // Only sites the customer owns count against their plan.
        const projects = (hosting?.projects ?? []) as Array<{ ownedByMe?: boolean }>
        const used = projects.filter((p) => p.ownedByMe !== false).length
        const raw = sub?.plan?.projects
        const limit = typeof raw === 'number' && raw > 0 ? raw : null
        setState({
          loading: false,
          planName: sub?.plan?.name ?? null,
          used,
          limit,
          isStaff,
          noPlan: !sub && !isStaff,
          atLimit: !isStaff && limit !== null && used >= limit,
        })
      })
      .catch(() => {
        // Unknown is not "blocked": the server enforces the real limit.
        if (!cancelled) setState({ ...EMPTY, loading: false })
      })
    return () => {
      cancelled = true
    }
  }, [active])

  return state
}

/** One calm line under the step rail; becomes a notice only when it blocks. */
export function PlanNote({ usage }: { usage: PlanUsage }) {
  if (usage.loading) return <Skeleton className="h-4 w-40" />
  if (usage.isStaff && !usage.planName) {
    return <p className="text-xs text-muted-foreground">Staff account — no plan limit applies.</p>
  }
  if (!usage.planName) return null
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      <span className="font-medium text-foreground">{usage.planName}</span>
      <br />
      {usage.limit === null
        ? `${usage.used} website${usage.used === 1 ? '' : 's'} · no limit`
        : `${usage.used} of ${usage.limit} websites used`}
    </p>
  )
}

/** Shown in place of the flow when a new site cannot be created at all. */
export function PlanBlocker({ usage, onDone }: { usage: PlanUsage; onDone: () => void }) {
  const setDashboardTab = useAppStore((s) => s.setDashboardTab)
  if (!usage.noPlan && !usage.atLimit) return null
  return (
    <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-medium">
        {usage.noPlan ? 'You need a hosting plan first' : 'Your plan is full'}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {usage.noPlan
          ? 'Choose a plan and you can create your website straight away.'
          : `You are using all ${usage.limit} websites included in ${usage.planName}. Upgrade to add another, or remove a site you no longer need.`}
      </p>
      <Button
        size="sm"
        className="mt-3"
        onClick={() => {
          setDashboardTab('billing')
          onDone()
        }}
      >
        {usage.noPlan ? 'See plans' : 'Upgrade plan'}
        <ArrowUpRight className="ms-1.5 size-4" aria-hidden />
      </Button>
    </div>
  )
}
