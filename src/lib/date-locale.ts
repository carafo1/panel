'use client'

import { useLocale } from 'next-intl'
import { ar, enUS, type Locale as DateLocale } from 'date-fns/locale'

/** date-fns locale matching the interface language ("3 minutes ago" / "منذ 3 دقائق"). */
export function useDateLocale(): DateLocale {
  return useLocale() === 'ar' ? ar : enUS
}
