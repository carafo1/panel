import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { getLocale, getTranslations } from 'next-intl/server'
import { db } from '@/lib/db'
import { getPublished, HELP_CATEGORIES } from '@/lib/help'
import { HelpShell } from '@/components/help/help-shell'
import { ArticleBody } from '@/components/help/article-body'
import { ArticleFeedback } from '@/components/help/article-feedback'

export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  const a = await db.helpArticle.findUnique({ where: { slug }, select: { title: true, summary: true, published: true } }).catch(() => null)
  if (!a?.published) return { title: 'Help center · Apsamo' }
  return { title: `${a.title} · Help center`, description: a.summary || undefined }
}

export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const a = await getPublished(slug)
  if (!a) notFound()
  const t = await getTranslations('help')
  const locale = await getLocale()
  const known = HELP_CATEGORIES.some((c) => c.key === a.category)

  return (
    <HelpShell>
      <Link href="/help" className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t('all')}
      </Link>
      {locale !== 'en' && <p className="mb-4 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{t('englishOnly')}</p>}
      <article lang="en" dir="ltr">
        {known && (
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400" lang={locale} dir="auto">
            {t(`categories.${a.category}` as never)}
          </p>
        )}
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">{a.title}</h1>
        {a.summary && <p className="mt-2 text-muted-foreground">{a.summary}</p>}
        <div className="mt-8">
          <ArticleBody markdown={a.body} />
        </div>
        <p className="mt-8 text-xs text-muted-foreground" lang={locale} dir="auto">
          {t('updated', { date: a.updatedAt.toLocaleDateString(locale === 'ar' ? 'ar' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) })}
        </p>
      </article>
      <div className="mt-8 border-t pt-6">
        <ArticleFeedback slug={a.slug} />
      </div>
    </HelpShell>
  )
}
