'use client'

import { useState } from 'react'
import { ThumbsUp, ThumbsDown } from 'lucide-react'
import { useTranslations } from 'next-intl'

export function ArticleFeedback({ slug }: { slug: string }) {
  const t = useTranslations('help')
  const [sent, setSent] = useState<null | boolean>(null)
  const vote = async (helpful: boolean) => {
    setSent(helpful)
    await fetch(`/api/help/${encodeURIComponent(slug)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ helpful }),
    }).catch(() => {})
  }
  if (sent !== null) {
    return (
      <p className="text-sm text-muted-foreground" role="status">
        {sent ? t('thanks') : t('sorry')}
      </p>
    )
  }
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted-foreground">{t('helpful')}</span>
      <button type="button" onClick={() => vote(true)} className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 hover:bg-muted">
        <ThumbsUp className="size-3.5" /> {t('yes')}
      </button>
      <button type="button" onClick={() => vote(false)} className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 hover:bg-muted">
        <ThumbsDown className="size-3.5" /> {t('no')}
      </button>
    </div>
  )
}
