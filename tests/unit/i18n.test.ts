import { describe, it, expect } from 'bun:test'
import en from '@/i18n/messages/en.json'
import ar from '@/i18n/messages/ar.json'
import { resolveLocale, dirFor } from '@/i18n/config'

type Tree = { [k: string]: string | Tree }
function flatten(t: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(t)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out[key] = v
    else Object.assign(out, flatten(v, key))
  }
  return out
}
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('translations', () => {
  const E = flatten(en as Tree)
  const A = flatten(ar as Tree)

  it('Arabic has exactly the English keys', () => {
    expect(Object.keys(A).sort()).toEqual(Object.keys(E).sort())
  })

  it('every message keeps the same {placeholders}', () => {
    for (const k of Object.keys(E)) expect({ k, p: placeholders(A[k] ?? '') }).toEqual({ k, p: placeholders(E[k]) })
  })

  it('no Arabic message is left empty', () => {
    for (const [k, v] of Object.entries(A)) expect({ k, empty: v.trim() === '' }).toEqual({ k, empty: false })
  })
})

describe('locale resolution', () => {
  it('prefers the cookie, then the browser language, then English', () => {
    expect(resolveLocale('ar', 'en-US,en;q=0.9')).toBe('ar')
    expect(resolveLocale(undefined, 'ar-SA,ar;q=0.9,en;q=0.8')).toBe('ar')
    expect(resolveLocale(undefined, 'fr-FR,fr;q=0.9')).toBe('en')
    expect(resolveLocale('xx', null)).toBe('en')
  })
  it('Arabic is right-to-left', () => {
    expect(dirFor('ar')).toBe('rtl')
    expect(dirFor('en')).toBe('ltr')
  })
})
