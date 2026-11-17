'use client'

/**
 * Switch between English and Arabic. The choice is a cookie the server reads
 * (src/i18n/request.ts), so the page reloads to render <html lang dir> right.
 */
import { useLocale, useTranslations } from 'next-intl'
import { Languages } from 'lucide-react'
import { LOCALE_COOKIE, type Locale } from '@/i18n/config'
import { cn } from '@/lib/utils'

export function setLocaleCookie(locale: Locale) {
  const secure = window.location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`
}

export function LanguageSwitcher({ className, compact = false }: { className?: string; compact?: boolean }) {
  const locale = useLocale() as Locale
  const t = useTranslations('language')
  const next: Locale = locale === 'ar' ? 'en' : 'ar'
  return (
    <button
      type="button"
      onClick={() => {
        setLocaleCookie(next)
        window.location.reload()
      }}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      aria-label={`${t('label')}: ${t(next)}`}
      title={t('label')}
      lang={next}
    >
      <Languages className="size-4" aria-hidden />
      {!compact && <span>{t(next)}</span>}
    </button>
  )
}
