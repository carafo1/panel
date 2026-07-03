'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import {
  Search, Star, Download, ArrowRight, ExternalLink, Loader2,
  Filter, Sparkles, Check, Zap, TrendingUp, Clock, Crown,
  ThumbsUp, MessageSquare, GitBranch, Shield, ChevronRight, X,
} from 'lucide-react'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/store/auth-store'
import { useAppStore } from '@/store/app-store'
import { Skeleton } from '@/components/ui/skeleton'

// ─── Types ───────────────────────────────────────────────────────────────────

interface MarketplaceTemplate {
  id: string
  name: string
  slug: string
  description: string
  category: string
  framework: string
  icon: string
  author: string
  isOfficial: boolean
  status: string
  version: string
  installCount: number
  avgRating: string | null
  ratingCount: number
  demoUrl: string | null
  repoUrl: string | null
  license: string
  features: string[]
  tags: string[]
  previewGradient: string
  createdAt: string
}

interface Review {
  id: string
  rating: number
  title: string
  body: string
  helpfulCount: number
  createdAt: string
  user: { name: string; avatar: string | null; email: string }
}

interface FeaturedData {
  featured: MarketplaceTemplate[]
  popular: MarketplaceTemplate[]
  trending: MarketplaceTemplate[]
  recent: MarketplaceTemplate[]
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CATEGORIES = ['All', 'Framework', 'Backend', 'Static', 'CMS', 'Ecommerce', 'Blog', 'Portfolio', 'SaaS', 'Fullstack', 'Frontend'] as const
const FRAMEWORKS = ['All', 'nextjs', 'react', 'vue', 'nuxt', 'astro', 'svelte', 'express', 'fastapi', 'node', 'static', 'gatsby', 'go', 'php', 'python', 'laravel', 'django', 'flask', 'wordpress'] as const
const SORTS = [
  { value: 'popular', label: 'Most Installed' },
  { value: 'rating', label: 'Highest Rated' },
  { value: 'trending', label: 'Trending' },
  { value: 'recent', label: 'Newest' },
  { value: 'name', label: 'Alphabetical' },
] as const

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return n.toString()
}

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (days < 1) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

// ─── Star Rating Component ───────────────────────────────────────────────────

function StarRating({ rating, size = 'sm' }: { rating: number; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClass = size === 'lg' ? 'h-5 w-5' : size === 'md' ? 'h-4 w-4' : 'h-3 w-3'
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          className={`${sizeClass} ${star <= Math.round(rating) ? 'fill-amber-400 text-amber-400' : 'fill-muted text-muted-foreground'}`}
        />
      ))}
    </div>
  )
}

function InteractiveStarRating({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [hover, setHover] = useState(0)
  return (
    <div className="flex items-center gap-1">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          type="button"
          onMouseEnter={() => setHover(star)}
          onMouseLeave={() => setHover(0)}
          onClick={() => onChange(star)}
          className="hover:scale-110 transition-transform"
        >
          <Star
            className={`h-6 w-6 ${
              star <= (hover || value)
                ? 'fill-amber-400 text-amber-400'
                : 'fill-muted text-muted-foreground'
            }`}
          />
        </button>
      ))}
    </div>
  )
}

// ─── Template Card ───────────────────────────────────────────────────────────

function TemplateCard({
  template,
  onDeploy,
  onView,
}: {
  template: MarketplaceTemplate
  onDeploy: (t: MarketplaceTemplate) => void
  onView: (t: MarketplaceTemplate) => void
}) {
  return (
    <Card className="group flex flex-col overflow-hidden transition-all hover:shadow-lg hover:border-primary/30 cursor-pointer" onClick={() => onView(template)}>
      <div className={`h-24 bg-gradient-to-br ${template.previewGradient} flex items-center justify-center relative`}>
        <span className="text-4xl">{template.icon}</span>
        {template.isOfficial && (
          <Badge className="absolute top-2 right-2 bg-blue-500/90 text-white">
            <Shield className="h-3 w-3 mr-1" /> Official
          </Badge>
        )}
        {template.status === 'featured' && (
          <Badge className="absolute top-2 left-2 bg-amber-500/90 text-white">
            <Crown className="h-3 w-3 mr-1" /> Featured
          </Badge>
        )}
      </div>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="text-base group-hover:text-primary transition-colors">{template.name}</CardTitle>
            <CardDescription className="text-xs">by {template.author}</CardDescription>
          </div>
          {template.avgRating && (
            <div className="flex items-center gap-1 text-xs">
              <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
              <span className="font-medium">{template.avgRating}</span>
              <span className="text-muted-foreground">({template.ratingCount})</span>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex-1 pb-2">
        <p className="text-sm text-muted-foreground line-clamp-2 mb-2">{template.description}</p>
        <div className="flex flex-wrap gap-1 mb-2">
          {template.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Download className="h-3 w-3" /> {formatNumber(template.installCount)}
          </span>
          <span className="flex items-center gap-1">
            <GitBranch className="h-3 w-3" /> {template.version}
          </span>
          <span>{template.license}</span>
        </div>
      </CardContent>
      <CardFooter className="pt-0 gap-2">
        <Button size="sm" className="flex-1" onClick={(e) => { e.stopPropagation(); onDeploy(template) }}>
          <Zap className="h-3 w-3 mr-1" /> Deploy
        </Button>
        {template.demoUrl && (
          <Button size="sm" variant="outline" onClick={(e) => { e.stopPropagation(); window.open(template.demoUrl!, '_blank') }}>
            <ExternalLink className="h-3 w-3" />
          </Button>
        )}
      </CardFooter>
    </Card>
  )
}

// ─── Template Detail Dialog ──────────────────────────────────────────────────

function TemplateDetailDialog({
  template,
  open,
  onClose,
  onDeploy,
}: {
  template: MarketplaceTemplate | null
  open: boolean
  onClose: () => void
  onDeploy: (t: MarketplaceTemplate) => void
}) {
  const [reviews, setReviews] = useState<Review[]>([])
  const [userRating, setUserRating] = useState<number | null>(null)
  const [loadingReviews, setLoadingReviews] = useState(false)
  const [showReviewForm, setShowReviewForm] = useState(false)
  const [newReviewRating, setNewReviewRating] = useState(5)
  const [newReviewTitle, setNewReviewTitle] = useState('')
  const [newReviewBody, setNewReviewBody] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!template || !open) return
    setLoadingReviews(true)
    Promise.all([
      apiFetch(`/templates/${template.id}/reviews?limit=5`),
      apiFetch(`/templates/${template.id}/rate`),
    ]).then(([reviewData, ratingData]) => {
      setReviews(reviewData.reviews || [])
      setUserRating(ratingData.rating ?? null)
    }).catch(() => {
      // silent fail
    }).finally(() => setLoadingReviews(false))
  }, [template, open])

  const submitRating = async (rating: number) => {
    try {
      const data = await apiFetch(`/templates/${template!.id}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      })
      setUserRating(rating)
      toast.success(`Rated ${rating} stars`)
    } catch (e: any) {
      toast.error(e.message || 'Failed to rate')
    }
  }

  const submitReview = async () => {
    if (!newReviewTitle.trim() || !newReviewBody.trim()) {
      toast.error('Title and body are required')
      return
    }
    setSubmitting(true)
    try {
      const data = await apiFetch(`/templates/${template!.id}/reviews`, {
        method: 'POST',
        body: JSON.stringify({
          rating: newReviewRating,
          title: newReviewTitle,
          body: newReviewBody,
        }),
      })
      setReviews([data.review, ...reviews])
      setShowReviewForm(false)
      setNewReviewTitle('')
      setNewReviewBody('')
      toast.success('Review published')
    } catch (e: any) {
      toast.error(e.message || 'Failed to submit review')
    } finally {
      setSubmitting(false)
    }
  }

  if (!template) return null

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div className={`h-16 w-16 rounded-lg bg-gradient-to-br ${template.previewGradient} flex items-center justify-center shrink-0`}>
              <span className="text-3xl">{template.icon}</span>
            </div>
            <div className="flex-1">
              <DialogTitle className="text-xl">{template.name}</DialogTitle>
              <DialogDescription className="text-sm">
                by {template.author} • v{template.version} • {template.license}
              </DialogDescription>
              <div className="flex items-center gap-3 mt-2">
                {template.avgRating && (
                  <div className="flex items-center gap-1">
                    <StarRating rating={parseFloat(template.avgRating)} size="sm" />
                    <span className="text-sm font-medium">{template.avgRating}</span>
                    <span className="text-xs text-muted-foreground">({template.ratingCount} ratings)</span>
                  </div>
                )}
                <span className="text-sm text-muted-foreground flex items-center gap-1">
                  <Download className="h-3 w-3" /> {formatNumber(template.installCount)} installs
                </span>
              </div>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {/* Description */}
          <div>
            <h4 className="text-sm font-semibold mb-1">About</h4>
            <p className="text-sm text-muted-foreground">{template.description}</p>
          </div>

          {/* Features */}
          {template.features.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold mb-2">Features</h4>
              <div className="flex flex-wrap gap-1.5">
                {template.features.map((f) => (
                  <Badge key={f} variant="secondary" className="text-xs">
                    <Check className="h-3 w-3 mr-1" /> {f}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Rate this template */}
          <div className="border rounded-lg p-4">
            <h4 className="text-sm font-semibold mb-2">Rate this template</h4>
            {userRating !== null ? (
              <div className="flex items-center gap-2">
                <InteractiveStarRating value={userRating} onChange={submitRating} />
                <span className="text-sm text-muted-foreground">Thanks for rating!</span>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <InteractiveStarRating value={0} onChange={submitRating} />
                <span className="text-sm text-muted-foreground">Click to rate</span>
              </div>
            )}
          </div>

          {/* Reviews */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-semibold">Reviews ({reviews.length})</h4>
              <Button size="sm" variant="outline" onClick={() => setShowReviewForm(!showReviewForm)}>
                <MessageSquare className="h-3 w-3 mr-1" /> Write a Review
              </Button>
            </div>

            {showReviewForm && (
              <div className="border rounded-lg p-4 mb-3 space-y-3">
                <div>
                  <Label className="text-xs">Rating</Label>
                  <InteractiveStarRating value={newReviewRating} onChange={setNewReviewRating} />
                </div>
                <div>
                  <Label className="text-xs">Title</Label>
                  <Input value={newReviewTitle} onChange={(e) => setNewReviewTitle(e.target.value)} placeholder="Great template!" />
                </div>
                <div>
                  <Label className="text-xs">Review</Label>
                  <Textarea value={newReviewBody} onChange={(e) => setNewReviewBody(e.target.value)} placeholder="Share your experience..." rows={3} />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={submitReview} disabled={submitting}>
                    {submitting ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
                    Submit Review
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setShowReviewForm(false)}>Cancel</Button>
                </div>
              </div>
            )}

            {loadingReviews ? (
              <div className="space-y-2">
                {[1, 2].map((i) => <Skeleton key={i} className="h-20" />)}
              </div>
            ) : reviews.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">No reviews yet. Be the first!</p>
            ) : (
              <div className="space-y-2">
                {reviews.map((r) => (
                  <div key={r.id} className="border rounded-lg p-3">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{r.user.name}</span>
                        <StarRating rating={r.rating} size="sm" />
                      </div>
                      <span className="text-xs text-muted-foreground">{timeAgo(r.createdAt)}</span>
                    </div>
                    <p className="text-sm font-medium mb-1">{r.title}</p>
                    <p className="text-sm text-muted-foreground">{r.body}</p>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Links */}
          <div className="flex gap-2 pt-2">
            <Button className="flex-1" onClick={() => onDeploy(template)}>
              <Zap className="h-4 w-4 mr-2" /> Deploy This Template
            </Button>
            {template.repoUrl && (
              <Button variant="outline" onClick={() => window.open(template.repoUrl!, '_blank')}>
                <GitBranch className="h-4 w-4 mr-2" /> View Code
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ─── Submit Template Dialog ──────────────────────────────────────────────────

function SubmitTemplateDialog({ open, onClose, onSubmitted }: { open: boolean; onClose: () => void; onSubmitted: () => void }) {
  const [form, setForm] = useState({
    name: '', description: '', category: 'Framework', framework: 'nextjs',
    icon: '📦', repoUrl: '', demoUrl: '', features: '', tags: '', license: 'MIT',
  })
  const [submitting, setSubmitting] = useState(false)

  const submit = async () => {
    if (!form.name.trim() || !form.description.trim() || !form.repoUrl.trim()) {
      toast.error('Name, description, and repo URL are required')
      return
    }
    setSubmitting(true)
    try {
      await apiFetch('/templates/submit', {
        method: 'POST',
        body: JSON.stringify({
          ...form,
          features: form.features.split(',').map((s) => s.trim()).filter(Boolean),
          tags: form.tags.split(',').map((s) => s.trim()).filter(Boolean),
        }),
      })
      toast.success('Template submitted! Admin will review it soon.')
      setForm({ name: '', description: '', category: 'Framework', framework: 'nextjs', icon: '📦', repoUrl: '', demoUrl: '', features: '', tags: '', license: 'MIT' })
      onSubmitted()
      onClose()
    } catch (e: any) {
      toast.error(e.message || 'Failed to submit')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Submit a Template to the Marketplace</DialogTitle>
          <DialogDescription>
            Share your template with the community. An admin will review it before it appears publicly.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Name *</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="My Awesome Starter" />
            </div>
            <div>
              <Label className="text-xs">Icon (emoji)</Label>
              <Input value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} placeholder="📦" maxLength={4} />
            </div>
          </div>
          <div>
            <Label className="text-xs">Description *</Label>
            <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="A brief description of what this template does" rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Category</Label>
              <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.filter((c) => c !== 'All').map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Framework</Label>
              <Select value={form.framework} onValueChange={(v) => setForm({ ...form, framework: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FRAMEWORKS.filter((f) => f !== 'All').map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-xs">GitHub Repo URL *</Label>
            <Input value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} placeholder="https://github.com/owner/repo" />
          </div>
          <div>
            <Label className="text-xs">Demo URL (optional)</Label>
            <Input value={form.demoUrl} onChange={(e) => setForm({ ...form, demoUrl: e.target.value })} placeholder="https://demo.example.com" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-xs">Features (comma-separated)</Label>
              <Input value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} placeholder="TypeScript, Tailwind, Auth" />
            </div>
            <div>
              <Label className="text-xs">Tags (comma-separated)</Label>
              <Input value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} placeholder="saas, dashboard, starter" />
            </div>
          </div>
          <div>
            <Label className="text-xs">License</Label>
            <Select value={form.license} onValueChange={(v) => setForm({ ...form, license: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {['MIT', 'Apache-2.0', 'GPL-3.0', 'BSD-3-Clause', 'MPL-2.0', 'Unlicense'].map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Submit for Review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ─── Main Marketplace Component ──────────────────────────────────────────────

export function TemplatesMarketplace({ onDeployTemplate }: { onDeployTemplate: (template: MarketplaceTemplate) => void }) {
  const { user } = useAppStore()
  const [loading, setLoading] = useState(true)
  const [templates, setTemplates] = useState<MarketplaceTemplate[]>([])
  const [featured, setFeatured] = useState<FeaturedData | null>(null)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [framework, setFramework] = useState('All')
  const [sort, setSort] = useState('popular')
  const [detailTemplate, setDetailTemplate] = useState<MarketplaceTemplate | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [submitOpen, setSubmitOpen] = useState(false)
  const [activeTab, setActiveTab] = useState('browse')

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams({
        category, framework, sort, limit: '50',
        ...(search ? { search } : {}),
      })
      const data = await apiFetch(`/templates?${params}`)
      setTemplates(data.templates || [])
    } catch (e: any) {
      toast.error(e.message || 'Failed to load templates')
    } finally {
      setLoading(false)
    }
  }, [category, framework, sort, search])

  const fetchFeatured = useCallback(async () => {
    try {
      const data = await apiFetch('/templates/featured')
      setFeatured(data)
    } catch { /* silent */ }
  }, [])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])
  useEffect(() => { fetchFeatured() }, [fetchFeatured])

  const handleDeploy = (template: MarketplaceTemplate) => {
    onDeployTemplate(template)
    setDetailOpen(false)
  }

  const handleView = (template: MarketplaceTemplate) => {
    setDetailTemplate(template)
    setDetailOpen(true)
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <LayoutGrid className="h-6 w-6" /> Template Marketplace
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Browse, deploy, and share website templates
          </p>
        </div>
        <Button onClick={() => setSubmitOpen(true)}>
          <Sparkles className="h-4 w-4 mr-2" /> Submit Template
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList>
          <TabsTrigger value="browse">Browse</TabsTrigger>
          <TabsTrigger value="featured">Featured</TabsTrigger>
          <TabsTrigger value="trending">Trending</TabsTrigger>
        </TabsList>

        {/* Browse Tab */}
        <TabsContent value="browse" className="space-y-4">
          {/* Search + Filters */}
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search templates..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-[140px]"><Filter className="h-4 w-4 mr-2" /><SelectValue /></SelectTrigger>
              <SelectContent>{CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={framework} onValueChange={setFramework}>
              <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
              <SelectContent>{FRAMEWORKS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>{SORTS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>

          {/* Templates Grid */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-64" />)}
            </div>
          ) : templates.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-muted-foreground">No templates found. Try different filters.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {templates.map((t) => (
                <TemplateCard key={t.id} template={t} onDeploy={handleDeploy} onView={handleView} />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Featured Tab */}
        <TabsContent value="featured" className="space-y-6">
          {featured?.featured && featured.featured.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Crown className="h-5 w-5 text-amber-500" /> Featured Templates
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {featured.featured.map((t) => <TemplateCard key={t.id} template={t} onDeploy={handleDeploy} onView={handleView} />)}
              </div>
            </div>
          )}
          {featured?.popular && (
            <div>
              <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-blue-500" /> Most Popular
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {featured.popular.slice(0, 6).map((t) => <TemplateCard key={t.id} template={t} onDeploy={handleDeploy} onView={handleView} />)}
              </div>
            </div>
          )}
        </TabsContent>

        {/* Trending Tab */}
        <TabsContent value="trending" className="space-y-6">
          {featured?.trending && featured.trending.length > 0 && (
            <div>
              <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <TrendingUp className="h-5 w-5 text-green-500" /> Trending Now
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {featured.trending.map((t) => <TemplateCard key={t.id} template={t} onDeploy={handleDeploy} onView={handleView} />)}
              </div>
            </div>
          )}
          {featured?.recent && (
            <div>
              <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                <Clock className="h-5 w-5 text-purple-500" /> Recently Added
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {featured.recent.slice(0, 6).map((t) => <TemplateCard key={t.id} template={t} onDeploy={handleDeploy} onView={handleView} />)}
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Detail Dialog */}
      <TemplateDetailDialog
        template={detailTemplate}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        onDeploy={handleDeploy}
      />

      {/* Submit Dialog */}
      <SubmitTemplateDialog
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmitted={() => { fetchTemplates(); fetchFeatured() }}
      />
    </div>
  )
}

// Need to import LayoutGrid at the top — adding here for the icon
import { LayoutGrid } from 'lucide-react'
