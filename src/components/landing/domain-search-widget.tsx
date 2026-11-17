'use client'

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { apiFetch } from '@/store/auth-store'
import {
  Search, Loader2, CheckCircle2, XCircle, Sparkles, Globe,
  ArrowRight, RefreshCw, ShoppingBag,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

interface Suggestion {
  domain: string
  available: boolean
  premium: boolean
  registrationPrice: number
}

interface SearchResult {
  domain: string
  available: boolean
  premium: boolean
  registrationPrice: number | null
  renewalPrice: number | null
  transferPrice: number | null
  currency: string
  provider: string
  tld: string
  suggestions: Suggestion[]
}

const POPULAR_TLDS = ['.com', '.net', '.org', '.io', '.dev', '.app', '.co', '.ai', '.xyz', '.tech']

interface DomainSearchWidgetProps {
  onGetStarted: () => void
  variant?: 'hero' | 'section'
  title?: string
  subtitle?: string
  className?: string
}

export function DomainSearchWidget({
  onGetStarted,
  variant = 'section',
  title,
  subtitle,
  className,
}: DomainSearchWidgetProps) {
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const isHero = variant === 'hero'

  const handleSearch = useCallback(async (searchTerm?: string) => {
    const term = (searchTerm ?? query).trim()
    if (!term) return
    const normalized = term.includes('.') ? term : `${term}.com`
    setQuery(normalized)
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const data = await apiFetch(`/domains/search?domain=${encodeURIComponent(normalized)}`)
      setResult(data.data)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Search failed'
      setError(msg)
      toast.error('Domain search failed', { description: msg })
    } finally {
      setLoading(false)
    }
  }, [query])

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSearch()
  }

  const reset = () => {
    setQuery('')
    setResult(null)
    setError(null)
  }

  return (
    <div className={cn('w-full', className)}>
      {(title || subtitle) && (
        <div className={cn('text-center mb-6', isHero && 'text-white')}>
          {title && (
            <h2 className={cn(
              'text-2xl sm:text-3xl font-extrabold tracking-tight',
              isHero ? 'text-white' : 'text-foreground'
            )}>
              {title}
            </h2>
          )}
          {subtitle && (
            <p className={cn(
              'mt-2 text-sm sm:text-base',
              isHero ? 'text-indigo-200/80' : 'text-muted-foreground'
            )}>
              {subtitle}
            </p>
          )}
        </div>
      )}

      {/* Search box */}
      <div className={cn(
        'relative rounded-2xl p-1.5 transition-all duration-300',
        isHero
          ? 'bg-white/10 backdrop-blur-2xl border border-white/25 shadow-glow-indigo-lg focus-within:border-indigo-300/70 focus-within:bg-white/15 focus-within:shadow-glow-indigo-lg'
          : 'bg-card border border-indigo-500/15 shadow-modern-lg focus-within:border-indigo-500/50 focus-within:shadow-glow-indigo focus-within:-translate-y-0.5'
      )}>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className={cn('relative flex-1 rounded-xl transition-colors', isHero ? 'focus-within:bg-white/5' : '')}>
            <Globe className={cn(
              'absolute start-3 top-1/2 -translate-y-1/2 size-5 pointer-events-none transition-colors',
              isHero ? 'text-indigo-300' : 'text-indigo-500'
            )} />
            <Input
              placeholder="Find your perfect domain — e.g. mybrand.com"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className={cn(
                'h-12 sm:h-14 text-base ps-11 border-0 bg-transparent shadow-none focus-visible:ring-0',
                isHero
                  ? 'text-white placeholder:text-indigo-200/50'
                  : 'text-foreground placeholder:text-muted-foreground'
              )}
              aria-label="Domain name search"
            />
          </div>
          <Button
            size="lg"
            onClick={() => handleSearch()}
            disabled={loading || !query.trim()}
            className={cn(
              'btn-shimmer h-12 sm:h-14 px-6 sm:px-8 text-base border-0 shrink-0 transition-all duration-300',
              'bg-gradient-to-r from-indigo-500 to-indigo-400 hover:from-indigo-600 hover:to-indigo-500 text-white',
              'hover:scale-[1.02] active:scale-95',
              'shadow-glow-indigo hover:shadow-glow-indigo-lg'
            )}
          >
            {loading ? <Loader2 className="size-5 animate-spin" /> : <Search className="size-5" />}
            <span className="hidden sm:inline ms-1 font-semibold tracking-wide">Search</span>
          </Button>
        </div>
      </div>

      {/* Popular TLD chips */}
      {!result && !loading && !error && (
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <span className={cn('text-xs font-medium me-1', isHero ? 'text-indigo-200/70' : 'text-muted-foreground')}>
            Popular:
          </span>
          {POPULAR_TLDS.map((tld) => (
            <button
              key={tld}
              onClick={() => {
                const base = query.trim().split('.')[0] || 'mybrand'
                handleSearch(`${base}${tld}`)
              }}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-xs font-semibold border transition-all duration-200 hover:scale-105 active:scale-95',
                isHero
                  ? 'bg-white/10 text-white border-white/15 hover:bg-indigo-500/40 hover:border-indigo-300/60 hover:shadow-glow-indigo'
                  : 'bg-indigo-500/5 text-indigo-600 dark:text-indigo-400 border-indigo-500/20 hover:bg-indigo-500/15 hover:border-indigo-500/50 hover:shadow-glow-indigo'
              )}
            >
              {tld}
            </button>
          ))}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className={cn(
          'mt-4 rounded-2xl border p-6 animate-pulse',
          isHero ? 'bg-white/10 backdrop-blur-xl border-white/15' : 'bg-card border-indigo-500/15'
        )}>
          <div className="flex items-center gap-3 mb-4">
            <div className={cn('size-10 rounded-full', isHero ? 'bg-white/20' : 'bg-muted')} />
            <div className="flex-1 space-y-2">
              <div className={cn('h-4 w-1/3 rounded', isHero ? 'bg-white/20' : 'bg-muted')} />
              <div className={cn('h-3 w-1/4 rounded', isHero ? 'bg-white/15' : 'bg-muted')} />
            </div>
            <div className={cn('h-8 w-20 rounded', isHero ? 'bg-indigo-400/30' : 'bg-muted')} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className={cn('h-16 rounded-lg', isHero ? 'bg-white/10' : 'bg-muted')} />
            <div className={cn('h-16 rounded-lg', isHero ? 'bg-white/10' : 'bg-muted')} />
            <div className={cn('h-16 rounded-lg', isHero ? 'bg-white/10' : 'bg-muted')} />
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className={cn(
          'mt-4 rounded-2xl border p-6 text-center',
          isHero ? 'bg-red-500/10 backdrop-blur-xl border-red-400/30' : 'border-red-500/30 bg-red-500/5'
        )}>
          <XCircle className="size-8 text-red-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-red-300">Couldn&apos;t check that domain</p>
          <p className={cn('text-xs mt-1 mb-3', isHero ? 'text-red-200/70' : 'text-muted-foreground')}>{error}</p>
          <Button variant="outline" size="sm" onClick={() => handleSearch()}>
            <RefreshCw className="size-3.5 me-1.5" /> Try again
          </Button>
        </div>
      )}

      {/* Result */}
      {result && !loading && (
        <div className="mt-5 space-y-4 animate-fade-in-up">
          <div className={cn(
            'rounded-2xl border p-5 sm:p-6 transition-all',
            result.available
              ? isHero
                ? 'bg-white/10 backdrop-blur-xl border-indigo-300/40 shadow-glow-indigo'
                : 'bg-indigo-500/5 border-indigo-500/30 shadow-glow-indigo'
              : isHero
                ? 'bg-red-500/10 backdrop-blur-xl border-red-400/30'
                : 'border-red-500/30 bg-red-500/5'
          )}>
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="space-y-2 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className={cn(
                    'text-xl sm:text-2xl font-bold truncate tracking-tight',
                    isHero ? 'text-white' : 'text-foreground'
                  )}>
                    {result.domain}
                  </h3>
                  {result.premium && (
                    <Badge className="bg-amber-500/20 text-amber-300 border-amber-400/40">
                      <Sparkles className="size-3 me-1" /> Premium
                    </Badge>
                  )}
                </div>
                {result.available ? (
                  <div className="flex items-center gap-2 text-indigo-300">
                    <CheckCircle2 className="size-4" />
                    <span className="text-sm font-semibold">Available</span>
                    <Badge variant="outline" className={cn('ms-1 text-[10px]', isHero ? 'border-indigo-300/40 text-indigo-200' : 'border-indigo-500/30 text-indigo-600 dark:text-indigo-400')}>{result.provider}</Badge>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-red-300">
                    <XCircle className="size-4" />
                    <span className="text-sm font-semibold">Already taken</span>
                  </div>
                )}
              </div>
              {result.available && result.registrationPrice != null && (
                <div className="text-end shrink-0">
                  <div className={cn(
                    'text-3xl sm:text-4xl font-extrabold leading-none',
                    isHero ? 'text-gradient-brand' : 'text-indigo-600 dark:text-indigo-400'
                  )}>
                    ${result.registrationPrice}
                  </div>
                  <div className={cn('text-xs mt-1', isHero ? 'text-indigo-200/60' : 'text-muted-foreground')}>/year</div>
                </div>
              )}
            </div>

            {result.available && result.registrationPrice != null && (
              <>
                <div className="grid grid-cols-3 gap-2.5 mt-5">
                  {[
                    { label: 'Register', value: result.registrationPrice, highlight: true },
                    { label: 'Renew', value: result.renewalPrice },
                    { label: 'Transfer', value: result.transferPrice },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className={cn(
                        'rounded-xl p-3 text-center border transition-colors',
                        item.highlight
                          ? (isHero ? 'bg-indigo-500/20 border-indigo-300/50' : 'bg-indigo-500/10 border-indigo-500/40')
                          : (isHero ? 'bg-white/5 border-white/10' : 'bg-background/70 border-transparent')
                      )}
                    >
                      <div className={cn(
                        'text-[10px] uppercase tracking-wider font-medium',
                        isHero ? 'text-indigo-200/70' : 'text-muted-foreground'
                      )}>
                        {item.label}
                      </div>
                      <div className={cn(
                        'font-bold text-base sm:text-lg mt-0.5',
                        item.highlight
                          ? (isHero ? 'text-white' : 'text-indigo-600 dark:text-indigo-400')
                          : (isHero ? 'text-indigo-100' : 'text-foreground')
                      )}>
                        ${item.value}
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex flex-col sm:flex-row gap-2.5 mt-5">
                  <Button
                    onClick={onGetStarted}
                    className="btn-shimmer flex-1 bg-gradient-to-r from-indigo-500 to-indigo-400 hover:from-indigo-600 hover:to-indigo-500 text-white border-0 h-12 shadow-glow-indigo hover:shadow-glow-indigo-lg hover:scale-[1.01] active:scale-95 transition-all duration-300"
                  >
                    <ShoppingBag className="size-4 me-2" />
                    Register This Domain
                    <ArrowRight className="size-4 ms-2" />
                  </Button>
                  <Button
                    variant="outline"
                    onClick={reset}
                    className={cn(
                      'h-12 transition-all duration-200 hover:scale-[1.01] active:scale-95',
                      isHero && 'bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white hover:border-white/30'
                    )}
                  >
                    <RefreshCw className="size-4 me-2" />
                    New Search
                  </Button>
                </div>
              </>
            )}

            {!result.available && (
              <div className="mt-5">
                <Button
                  variant="outline"
                  onClick={reset}
                  className={cn(
                    'w-full sm:w-auto h-12 transition-all duration-200 hover:scale-[1.01] active:scale-95',
                    isHero && 'bg-white/10 border-white/20 text-white hover:bg-white/20 hover:text-white hover:border-white/30'
                  )}
                >
                  <RefreshCw className="size-4 me-2" />
                  Search Another Domain
                </Button>
              </div>
            )}
          </div>

          {result.suggestions && result.suggestions.length > 0 && (
            <div className={cn(
              'rounded-2xl border p-5 sm:p-6',
              isHero ? 'bg-white/10 backdrop-blur-xl border-white/15' : 'bg-card border-indigo-500/15'
            )}>
              <div className="flex items-center gap-2 mb-4">
                <Sparkles className="size-4 text-indigo-400" />
                <h4 className={cn('font-semibold text-sm', isHero ? 'text-white' : 'text-foreground')}>
                  {result.available ? 'More TLD options' : 'Try these alternatives'}
                </h4>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {result.suggestions.map((s) => (
                  <button
                    key={s.domain}
                    onClick={() => handleSearch(s.domain)}
                    className={cn(
                      'flex items-center justify-between rounded-xl border p-3 text-start transition-all duration-200 hover:shadow-md hover:scale-[1.01] active:scale-95',
                      s.available
                        ? isHero
                          ? 'border-indigo-300/30 bg-white/5 hover:border-indigo-300/60 hover:bg-indigo-500/20 hover:shadow-glow-indigo'
                          : 'border-indigo-500/20 hover:border-indigo-500/50 hover:bg-indigo-500/10 hover:shadow-glow-indigo'
                        : isHero
                          ? 'border-white/10 bg-white/5 opacity-60 hover:opacity-100'
                          : 'border-muted opacity-60 hover:opacity-100'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {s.available ? (
                        <CheckCircle2 className="size-4 text-indigo-300 shrink-0" />
                      ) : (
                        <XCircle className={cn('size-4 shrink-0', isHero ? 'text-red-300/60' : 'text-muted-foreground')} />
                      )}
                      <span className={cn('font-medium text-sm truncate', isHero ? 'text-indigo-50' : 'text-foreground')}>
                        {s.domain}
                      </span>
                      {s.premium && <Sparkles className="size-3 text-amber-400 shrink-0" />}
                    </div>
                    {s.available && (
                      <span className={cn(
                        'text-sm font-mono font-semibold shrink-0 ms-2',
                        isHero ? 'text-indigo-200' : 'text-indigo-600 dark:text-indigo-400'
                      )}>
                        ${s.registrationPrice}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
