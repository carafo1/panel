'use client'

/** Shows current platform incidents/maintenance (from the public status page) in the dashboard. */
import { useEffect, useState } from 'react'
import { AlertTriangle, Wrench, X } from 'lucide-react'
import { useTranslations } from 'next-intl'

interface Item { id: string; title: string; impact: string; status: string }

export function IncidentBanner() {
  const [items, setItems] = useState<Item[]>([])
  const [hidden, setHidden] = useState<string[]>([])
  const t = useTranslations('banners')

  useEffect(() => {
    let alive = true
    const load = () =>
      fetch('/api/status', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { active?: Item[] } | null) => alive && d?.active && setItems(d.active))
        .catch(() => {})
    void load()
    const t = setInterval(load, 5 * 60_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const visible = items.filter((i) => !hidden.includes(i.id))
  if (visible.length === 0) return null
  return (
    <div className="space-y-px">
      {visible.map((i) => {
        const maint = i.impact === 'maintenance'
        const Icon = maint ? Wrench : AlertTriangle
        return (
          <div
            key={i.id}
            role="status"
            className={`flex items-center gap-3 px-4 py-2 text-sm ${
              maint ? 'bg-sky-50 text-sky-900 dark:bg-sky-950/50 dark:text-sky-100' : 'bg-amber-50 text-amber-950 dark:bg-amber-950/50 dark:text-amber-100'
            }`}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <p className="min-w-0 flex-1 truncate">
              <span className="font-medium">{maint ? t('maintenance') : t('serviceIssue')}{' '}</span>
              {i.title}
            </p>
            <a href="/status" target="_blank" rel="noreferrer" className="shrink-0 font-medium underline underline-offset-2">
              {t('details')}
            </a>
            <button type="button" onClick={() => setHidden((h) => [...h, i.id])} aria-label={t('dismiss')} className="shrink-0 rounded p-1 hover:bg-black/5 dark:hover:bg-white/10">
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
