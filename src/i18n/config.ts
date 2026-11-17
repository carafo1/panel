/**
 * Languages. English is the default; Arabic is right-to-left.
 *
 * The choice lives in a cookie (no /ar/ URL prefix): the panel is one app
 * behind a login, and the cookie lets the server render <html lang dir>
 * correctly on the first byte, so Arabic never flashes left-to-right.
 */
export const LOCALES = ['en', 'ar'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_COOKIE = 'apsamo_locale'
const RTL: readonly Locale[] = ['ar']

export const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v)
export const dirFor = (l: Locale): 'rtl' | 'ltr' => (RTL.includes(l) ? 'rtl' : 'ltr')

/** Cookie first; otherwise the browser's preferred language if we support it. */
export function resolveLocale(cookieValue: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(cookieValue)) return cookieValue
  for (const part of (acceptLanguage || '').split(',')) {
    const tag = part.split(';')[0].trim().toLowerCase().split('-')[0]
    if (isLocale(tag)) return tag
  }
  return DEFAULT_LOCALE
}
