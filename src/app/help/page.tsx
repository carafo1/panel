import type { Metadata } from 'next'
import Link from 'next/link'
import { Search } from 'lucide-react'
import { getTranslations } from 'next-intl/server'
import { listPublished, HELP_CATEGORIES } from '@/lib/help'
import { HelpShell } from '@/components/help/help-shell'

export const dynamic = 'force-dynamic'

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('shell')
  return { title: `${t('helpCenter')} · Apsamo`, description: 'Guides for hosting, domains, email, billing and your account.' }
}

export default async function HelpPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const t = await getTranslations('help')
  const { q } = await searchParams
  const query = typeof q === 'string' ? q.slice(0, 100) : ''
  const articles = await listPublished(query || undefined)

  return (
    <HelpShell>
      <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
      <form action="/help" method="get" role="search" className="relative mt-5">
        <Search className="absolute start-3 top-3 size-4 text-muted-foreground" aria-hidden />
        <label htmlFor="help-q" className="sr-only">
          {t('searchLabel')}
        </label>
        <input
          id="help-q"
          name="q"
          defaultValue={query}
          placeholder={t('searchPlaceholder')}
          className="h-10 w-full rounded-lg border bg-card ps-9 pe-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        />
      </form>

      {query ? (
        <section className="mt-8" aria-live="polite">
          <p className="mb-3 text-sm text-muted-foreground">
            {articles.length === 0 ? t('noMatch', { query }) : t('results', { query })}{' '}
            <Link href="/help" className="underline">
              {t('showAll')}
            </Link>
          </p>
          <ArticleList items={articles} />
        </section>
      ) : articles.length === 0 ? (
        <p className="mt-8 rounded-xl border bg-card p-5 text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="mt-8 space-y-8">
          {HELP_CATEGORIES.map((c) => {
            const items = articles.filter((a) => a.category === c.key)
            if (items.length === 0) return null
            return (
              <section key={c.key} aria-labelledby={`cat-${c.key}`}>
                <h2 id={`cat-${c.key}`} className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {t(`categories.${c.key}`)}
                </h2>
                <ArticleList items={items} />
              </section>
            )
          })}
        </div>
      )}

      <p className="mt-12 rounded-xl border bg-card p-5 text-sm">
        <strong className="font-medium">{t('stuck')}</strong> <span className="text-muted-foreground">{t('stuckBody')}</span>
      </p>
    </HelpShell>
  )
}

function ArticleList({ items }: { items: Array<{ id: string; slug: string; title: string; summary: string }> }) {
  if (items.length === 0) return null
  return (
    <ul className="divide-y rounded-xl border bg-card">
      {items.map((a) => (
        <li key={a.id}>
          {/* Articles are written in English; mark them so screen readers pronounce them right. */}
          <Link href={`/help/${a.slug}`} lang="en" className="block px-5 py-3.5 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none">
            <span className="block text-sm font-medium">{a.title}</span>
            {a.summary && <span className="block text-xs text-muted-foreground">{a.summary}</span>}
          </Link>
        </li>
      ))}
    </ul>
  )
}
