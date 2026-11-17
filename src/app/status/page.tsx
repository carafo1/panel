import type { Metadata } from 'next'
import Link from 'next/link'
import { getLocale, getTranslations } from 'next-intl/server'
import { getStatusPage, type ComponentStatus, type PublicIncident } from '@/lib/status'
import { Logo } from '@/components/ui/logo'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { SUPPORT_EMAIL } from '@/lib/brand-config'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('status')
  return {
    title: `${t('title')} · Apsamo`,
    description: 'Live status of Apsamo hosting, deployments, email and domains, with incident history.',
  }
}

const DOT: Record<ComponentStatus, string> = {
  operational: 'bg-emerald-500',
  degraded: 'bg-amber-500',
  partial_outage: 'bg-orange-500',
  major_outage: 'bg-red-600',
  maintenance: 'bg-sky-500',
  unknown: 'bg-zinc-400',
}
const BANNER: Record<ComponentStatus, { key: 'allOk' | 'maintenance' | 'degraded' | 'partial' | 'major'; cls: string }> = {
  operational: { key: 'allOk', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200' },
  unknown: { key: 'allOk', cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200' },
  maintenance: { key: 'maintenance', cls: 'border-sky-500/30 bg-sky-500/10 text-sky-900 dark:text-sky-200' },
  degraded: { key: 'degraded', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200' },
  partial_outage: { key: 'partial', cls: 'border-orange-500/30 bg-orange-500/10 text-orange-900 dark:text-orange-200' },
  major_outage: { key: 'major', cls: 'border-red-500/30 bg-red-500/10 text-red-900 dark:text-red-200' },
}

type T = Awaited<ReturnType<typeof getTranslations<'status'>>>

function IncidentCard({ i, t, fmt, sep }: { i: PublicIncident; t: T; fmt: (iso: string) => string; sep: string }) {
  return (
    <article className="rounded-xl border bg-card p-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{i.title}</h3>
        <span className="text-xs text-muted-foreground">
          {t(`impact.${i.impact}` as never)} · {i.components.map((k) => t(`components.${k}` as never)).join(sep)}
        </span>
      </header>
      <ol className="mt-4 space-y-3 border-s ps-4">
        {i.updates.map((u) => (
          <li key={u.id} className="relative">
            <span className="absolute -start-[21px] top-1.5 size-2 rounded-full bg-border" aria-hidden />
            <p className="text-sm">
              <strong className="font-medium">{t(`steps.${u.status}` as never)}</strong>
              <span className="text-muted-foreground"> — {u.message}</span>
            </p>
            <time className="text-xs text-muted-foreground" dateTime={u.createdAt}>
              {fmt(u.createdAt)}
            </time>
          </li>
        ))}
      </ol>
    </article>
  )
}

export default async function StatusPage() {
  const t = await getTranslations('status')
  const tShell = await getTranslations('shell')
  const locale = await getLocale()
  const sep = locale === 'ar' ? '، ' : ', '
  const fmt = (iso: string) =>
    new Date(iso).toLocaleString(locale === 'ar' ? 'ar' : 'en-GB', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
      timeZoneName: 'short',
    })

  let data: Awaited<ReturnType<typeof getStatusPage>> | null = null
  try {
    data = await getStatusPage()
  } catch (error) {
    console.error('[status page] failed:', error)
  }

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link href="/" aria-label="Home">
            <Logo className="h-7" />
          </Link>
          <nav className="flex items-center gap-2 text-sm text-muted-foreground">
            <Link href="/help" className="hover:text-foreground">
              {tShell('helpCenter')}
            </Link>
            <LanguageSwitcher />
          </nav>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>

        {!data ? (
          <p className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-5 text-sm">{t('unavailable', { email: SUPPORT_EMAIL })}</p>
        ) : (
          <>
            <div className={`mt-6 flex items-center gap-3 rounded-xl border p-5 ${BANNER[data.overall].cls}`} role="status">
              <span className={`size-3 rounded-full ${DOT[data.overall]}`} aria-hidden />
              <p className="font-medium">{t(BANNER[data.overall].key)}</p>
            </div>

            {data.active.length > 0 && (
              <section className="mt-8 space-y-3" aria-labelledby="active">
                <h2 id="active" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('current')}
                </h2>
                {data.active.map((i) => (
                  <IncidentCard key={i.id} i={i} t={t} fmt={fmt} sep={sep} />
                ))}
              </section>
            )}

            {data.upcoming.length > 0 && (
              <section className="mt-8 space-y-3" aria-labelledby="upcoming">
                <h2 id="upcoming" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('scheduled')}
                </h2>
                {data.upcoming.map((i) => (
                  <div key={i.id}>
                    <p className="mb-1 text-xs text-muted-foreground">{t('starts', { time: fmt(i.startedAt) })}</p>
                    <IncidentCard i={i} t={t} fmt={fmt} sep={sep} />
                  </div>
                ))}
              </section>
            )}

            <section className="mt-8" aria-labelledby="components">
              <h2 id="components" className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t('services')}
              </h2>
              <ul className="divide-y rounded-xl border bg-card">
                {data.components.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-4 px-5 py-3.5">
                    <div>
                      <p className="text-sm font-medium">{t(`components.${c.key}` as never)}</p>
                      <p className="text-xs text-muted-foreground">{c.auto ? t('auto') : t('manual')}</p>
                    </div>
                    <span className="flex shrink-0 items-center gap-2 text-sm">
                      <span className={`size-2.5 rounded-full ${DOT[c.status]}`} aria-hidden />
                      {t(`levels.${c.status}` as never)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="mt-10 space-y-3" aria-labelledby="history">
              <h2 id="history" className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t('history')}
              </h2>
              {data.recent.length === 0 ? (
                <p className="rounded-xl border bg-card p-5 text-sm text-muted-foreground">{t('noHistory')}</p>
              ) : (
                data.recent.map((i) => <IncidentCard key={i.id} i={i} t={t} fmt={fmt} sep={sep} />)
              )}
            </section>

            <p className="mt-10 text-xs text-muted-foreground">{t('updated', { time: fmt(data.updatedAt) })}</p>
          </>
        )}
      </div>
    </main>
  )
}
