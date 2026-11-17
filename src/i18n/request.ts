import { cookies, headers } from 'next/headers'
import { getRequestConfig } from 'next-intl/server'
import { LOCALE_COOKIE, resolveLocale } from './config'

export default getRequestConfig(async () => {
  const [store, h] = await Promise.all([cookies(), headers()])
  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value, h.get('accept-language'))
  const messages = (await import(`./messages/${locale}.json`)).default
  return { locale, messages, timeZone: 'UTC' }
})
