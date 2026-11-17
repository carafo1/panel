'use client'

/**
 * Admin → global search. Support requests arrive as "my site is down" plus an
 * email, a domain or an invoice number; this finds the customer from any of
 * them (GET /api/admin/search) and jumps to them in the Users tab.
 */
import { useEffect, useRef, useState } from 'react'
import { Search, Loader2, User, Globe, Server, Mail, Receipt, CreditCard, Repeat } from 'lucide-react'
import { apiFetch } from '@/store/auth-store'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'

interface Result {
  type: 'user' | 'project' | 'domain' | 'email' | 'invoice' | 'payment' | 'subscription'
  id: string
  title: string
  subtitle?: string | null
  ownerEmail?: string | null
  status?: string | null
}

const ICONS: Record<Result['type'], typeof User> = {
  user: User,
  project: Server,
  domain: Globe,
  email: Mail,
  invoice: Receipt,
  payment: CreditCard,
  subscription: Repeat,
}
const LABELS: Record<Result['type'], string> = {
  user: 'Customer',
  project: 'Website',
  domain: 'Domain',
  email: 'Mailbox',
  invoice: 'Invoice',
  payment: 'Payment',
  subscription: 'Subscription',
}

export function AdminSearch({ onOpenCustomer }: { onOpenCustomer: (email: string) => void }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Result[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setResults(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    const t = setTimeout(() => {
      apiFetch<{ results: Result[] }>(`/admin/search?q=${encodeURIComponent(term)}`)
        .then((d) => !cancelled && (setResults(d.results || []), setError(null)))
        .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Search failed'))
        .finally(() => !cancelled && setLoading(false))
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [q])

  // Close the results when clicking elsewhere.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const pick = (r: Result) => {
    const email = r.ownerEmail || (r.type === 'user' ? r.title : null)
    if (email) onOpenCustomer(email)
    setOpen(false)
  }

  return (
    <div ref={box} className="relative w-full sm:max-w-md">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <Input
        type="search"
        role="combobox"
        aria-expanded={open && q.trim().length >= 2}
        aria-label="Search customers, websites, domains, mailboxes, invoices, payments"
        placeholder="Find by email, domain, site, invoice or payment ref…"
        className="pl-9"
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
      />
      {open && q.trim().length >= 2 && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg">
          {loading && !results ? (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Searching…
            </div>
          ) : error ? (
            <p className="p-3 text-sm text-destructive">{error}</p>
          ) : results && results.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">Nothing matches “{q.trim()}”.</p>
          ) : (
            <ul role="listbox" className="max-h-80 overflow-y-auto py-1">
              {(results || []).map((r) => {
                const Icon = ICONS[r.type] || Search
                const email = r.ownerEmail || (r.type === 'user' ? r.title : null)
                return (
                  <li key={`${r.type}-${r.id}`} role="option" aria-selected={false}>
                    <button
                      type="button"
                      onClick={() => pick(r)}
                      disabled={!email}
                      className="flex w-full items-start gap-3 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none disabled:cursor-default disabled:opacity-70"
                    >
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate font-medium">{r.title}</span>
                          <Badge variant="outline" className="shrink-0 text-[10px]">
                            {LABELS[r.type]}
                          </Badge>
                          {r.status && <span className="shrink-0 text-xs text-muted-foreground">{r.status}</span>}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {[r.subtitle, r.type !== 'user' && r.ownerEmail ? `owner ${r.ownerEmail}` : null].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
