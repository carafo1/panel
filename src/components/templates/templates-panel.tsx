'use client'

import { useState, useMemo, useCallback, useEffect } from 'react'
import { toast } from 'sonner'
import {
  LayoutGrid,
  Search,
  Star,
  Download,
  ArrowRight,
  ExternalLink,
  Loader2,
  Filter,
  Sparkles,
  Check,
  Zap,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { apiFetch } from '@/store/auth-store'
import { useAppStore } from '@/store/app-store'
import { Skeleton } from '@/components/ui/skeleton'

// ─── Types ───────────────────────────────────────────────────────────────────

interface Template {
  id: string
  name: string
  description: string
  category: string
  framework: string
  stars: number
  deployments: number
  author: string
  tags: string[]
  features: string[]
  repoUrl: string
  previewGradient: string
  icon: string
  isOfficial: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CATEGORIES = ['All', 'Framework', 'Backend', 'Static', 'CMS'] as const

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  }
  return n.toString()
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// ─── Loading Skeleton ────────────────────────────────────────────────────────

function TemplateCardSkeleton() {
  return (
    <Card className="overflow-hidden border-border/60">
      <Skeleton className="h-24 w-full rounded-none" />
      <CardHeader className="pb-2 pt-4 px-4">
        <Skeleton className="h-5 w-3/4 mb-1" />
        <Skeleton className="h-4 w-full" />
      </CardHeader>
      <CardContent className="px-4 pb-2">
        <div className="flex items-center gap-3 mb-3">
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-10" />
        </div>
        <div className="flex gap-1.5">
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-14" />
        </div>
      </CardContent>
      <CardFooter className="px-4 pb-4 pt-0">
        <Skeleton className="h-8 w-full" />
      </CardFooter>
    </Card>
  )
}

// ─── Component ───────────────────────────────────────────────────────────────

export function TemplatesPanel() {
  const { setDashboardTab } = useAppStore()

  // Data state
  const [templates, setTemplates] = useState<Template[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [seeded, setSeeded] = useState(false)

  // Search & filter state
  const [searchQuery, setSearchQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>('All')

  // Template detail dialog
  const [selectedTemplate, setSelectedTemplate] = useState<Template | null>(
    null
  )
  const [detailOpen, setDetailOpen] = useState(false)

  // Deploy dialog
  const [deployOpen, setDeployOpen] = useState(false)
  const [deployingTemplate, setDeployingTemplate] = useState<Template | null>(
    null
  )
  const [projectName, setProjectName] = useState('')
  const [isDeploying, setIsDeploying] = useState(false)
  const [deploySuccess, setDeploySuccess] = useState(false)

  // ── Fetch templates from API ─────────────────────────────────────────────

  const fetchTemplates = useCallback(async () => {
    setIsLoading(true)
    try {
      const params = new URLSearchParams()
      if (activeCategory !== 'All') params.set('category', activeCategory)
      if (searchQuery.trim()) params.set('search', searchQuery.trim())

      const qs = params.toString()
      const data = await apiFetch(`/templates${qs ? `?${qs}` : ''}`)
      setTemplates(data.templates || [])
    } catch (err) {
      console.error('Failed to fetch templates:', err)
      toast.error('Failed to load templates', {
        description: 'Could not fetch templates from the server.',
      })
    } finally {
      setIsLoading(false)
    }
  }, [activeCategory, searchQuery])

  // Seed templates on first load
  useEffect(() => {
    if (seeded) return
    setSeeded(true)
    apiFetch('/templates/seed', { method: 'POST' })
      .then(() => fetchTemplates())
      .catch(() => fetchTemplates())
  }, [seeded, fetchTemplates])

  // Fetch templates when filters change
  useEffect(() => {
    if (!seeded) return // wait until seed is triggered
    fetchTemplates()
  }, [activeCategory, searchQuery, fetchTemplates, seeded])

  // ── Derived: auto-generated subdomain ───────────────────────────────────

  const subdomain = useMemo(() => {
    const slug = slugify(projectName)
    return slug ? `${slug}.deployhub.io` : ''
  }, [projectName])

  // ── Handlers ────────────────────────────────────────────────────────────

  const handleViewTemplate = useCallback((template: Template) => {
    setSelectedTemplate(template)
    setDetailOpen(true)
  }, [])

  const handleOpenDeploy = useCallback(
    (template: Template) => {
      setDeployingTemplate(template)
      setProjectName(template.name)
      setDeploySuccess(false)
      setDetailOpen(false)
      setDeployOpen(true)
    },
    []
  )

  const handleDeploy = useCallback(async () => {
    if (!deployingTemplate || !projectName.trim()) return

    setIsDeploying(true)
    try {
      await apiFetch(`/templates/${deployingTemplate.id}/deploy`, {
        method: 'POST',
        body: JSON.stringify({
          projectName: projectName.trim(),
        }),
      })

      setDeploySuccess(true)
      toast.success('Template deployed!', {
        description: `${projectName} is now live at https://${subdomain}`,
      })

      // Navigate to hosting tab after a short delay
      setTimeout(() => {
        setDeployOpen(false)
        setDashboardTab('hosting')
      }, 1500)
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to deploy template'
      toast.error('Deployment failed', { description: message })
    } finally {
      setIsDeploying(false)
    }
  }, [deployingTemplate, projectName, subdomain, setDashboardTab])

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-6 w-6 text-indigo-500" />
          <h1 className="text-2xl font-bold tracking-tight">
            Template Marketplace
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Browse pre-built deployment templates and launch a new project in
          seconds.
        </p>
      </div>

      {/* ── Search & Filter Bar ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search templates by name, description, or tag…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <Tabs
          value={activeCategory}
          onValueChange={setActiveCategory}
          className="w-full sm:w-auto"
        >
          <TabsList className="h-9">
            {CATEGORIES.map((cat) => (
              <TabsTrigger
                key={cat}
                value={cat}
                className="text-xs px-3 data-[state=active]:bg-indigo-500 data-[state=active]:text-white"
              >
                {cat}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* ── Template Grid ───────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <TemplateCardSkeleton key={i} />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Filter className="h-12 w-12 text-muted-foreground/50 mb-4" />
          <h3 className="text-lg font-semibold">No templates found</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Try adjusting your search or filter criteria.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onView={handleViewTemplate}
              onDeploy={handleOpenDeploy}
            />
          ))}
        </div>
      )}

      {/* ── Template Detail Dialog ──────────────────────────────────────── */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="sm:max-w-lg">
          {selectedTemplate && (
            <>
              <DialogHeader>
                <div className="flex items-center gap-3">
                  <div
                    className={`flex h-12 w-12 items-center justify-center rounded-lg bg-gradient-to-br ${selectedTemplate.previewGradient} text-xl`}
                  >
                    {selectedTemplate.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <DialogTitle className="text-lg">
                      {selectedTemplate.name}
                      {selectedTemplate.isOfficial && (
                        <Badge
                          variant="secondary"
                          className="ml-2 text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-400"
                        >
                          Official
                        </Badge>
                      )}
                    </DialogTitle>
                    <DialogDescription className="text-sm">
                      by {selectedTemplate.author}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>

              <div className="flex flex-col gap-4 mt-2">
                {/* Description */}
                <p className="text-sm text-muted-foreground">
                  {selectedTemplate.description}
                </p>

                {/* Stats */}
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1 text-sm">
                    <Star className="h-4 w-4 text-amber-500 fill-amber-500" />
                    <span className="font-medium">
                      {formatNumber(selectedTemplate.stars)}
                    </span>
                    <span className="text-muted-foreground">stars</span>
                  </div>
                  <div className="flex items-center gap-1 text-sm">
                    <Download className="h-4 w-4 text-indigo-500" />
                    <span className="font-medium">
                      {formatNumber(selectedTemplate.deployments)}
                    </span>
                    <span className="text-muted-foreground">deploys</span>
                  </div>
                </div>

                <Separator />

                {/* Features */}
                <div>
                  <h4 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
                    <Sparkles className="h-4 w-4 text-indigo-500" />
                    Features
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {selectedTemplate.features.map((feature) => (
                      <Badge
                        key={feature}
                        variant="secondary"
                        className="text-xs"
                      >
                        {feature}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Tags */}
                <div>
                  <h4 className="text-sm font-semibold mb-2">Tags</h4>
                  <div className="flex flex-wrap gap-2">
                    {selectedTemplate.tags.map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className="text-xs border-indigo-500/30 text-indigo-600 dark:text-indigo-400"
                      >
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>

                {/* Repo link */}
                {selectedTemplate.repoUrl && (
                  <div className="flex items-center gap-2 text-sm">
                    <ExternalLink className="h-4 w-4 text-muted-foreground" />
                    <a
                      href={selectedTemplate.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 dark:text-indigo-400 hover:underline truncate"
                    >
                      {selectedTemplate.repoUrl}
                    </a>
                  </div>
                )}
              </div>

              <DialogFooter className="mt-4 gap-2">
                <Button
                  variant="outline"
                  onClick={() => setDetailOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  className="bg-indigo-600 hover:bg-indigo-700 text-white"
                  onClick={() => handleOpenDeploy(selectedTemplate)}
                >
                  <Zap className="h-4 w-4 mr-1.5" />
                  Deploy Template
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Deploy Dialog ───────────────────────────────────────────────── */}
      <Dialog open={deployOpen} onOpenChange={setDeployOpen}>
        <DialogContent className="sm:max-w-md">
          {deployingTemplate && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Zap className="h-5 w-5 text-indigo-500" />
                  Deploy {deployingTemplate.name}
                </DialogTitle>
                <DialogDescription>
                  Configure your new project from this template.
                </DialogDescription>
              </DialogHeader>

              {deploySuccess ? (
                <div className="flex flex-col items-center justify-center py-8 gap-3">
                  <div className="flex h-14 w-14 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-900/40">
                    <Check className="h-7 w-7 text-indigo-600 dark:text-indigo-400" />
                  </div>
                  <h3 className="text-lg font-semibold">
                    Deployment Started!
                  </h3>
                  <p className="text-sm text-muted-foreground text-center">
                    Your project{' '}
                    <span className="font-medium text-foreground">
                      {projectName}
                    </span>{' '}
                    is being created and will be live at{' '}
                    <span className="font-medium text-indigo-600 dark:text-indigo-400">
                      https://{subdomain}
                    </span>
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-4 mt-2">
                  {/* Template info banner */}
                  <div className="flex items-center gap-3 rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-950/30 p-3">
                    <div
                      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-gradient-to-br ${deployingTemplate.previewGradient} text-lg`}
                    >
                      {deployingTemplate.icon}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {deployingTemplate.name}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {deployingTemplate.description}
                      </p>
                    </div>
                  </div>

                  {/* Project name */}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="project-name">Project Name</Label>
                    <Input
                      id="project-name"
                      placeholder="my-awesome-project"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                    />
                  </div>

                  {/* Subdomain preview */}
                  <div className="flex flex-col gap-2">
                    <Label>Subdomain</Label>
                    <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm">
                      {subdomain ? (
                        <span>
                          <span className="font-medium">{subdomain}</span>
                        </span>
                      ) : (
                        <span className="text-muted-foreground italic">
                          Enter a project name…
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Framework */}
                  <div className="flex flex-col gap-2">
                    <Label>Framework</Label>
                    <div className="flex h-9 items-center rounded-md border bg-muted/50 px-3 text-sm">
                      <Badge
                        variant="outline"
                        className="border-indigo-500/30 text-indigo-600 dark:text-indigo-400 mr-2"
                      >
                        {deployingTemplate.framework}
                      </Badge>
                      <span className="text-muted-foreground text-xs">
                        Auto-configured from template
                      </span>
                    </div>
                  </div>
                </div>
              )}

              {!deploySuccess && (
                <DialogFooter className="mt-4 gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setDeployOpen(false)}
                    disabled={isDeploying}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="bg-indigo-600 hover:bg-indigo-700 text-white"
                    onClick={handleDeploy}
                    disabled={!projectName.trim() || isDeploying}
                  >
                    {isDeploying ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                        Deploying…
                      </>
                    ) : (
                      <>
                        <ArrowRight className="h-4 w-4 mr-1.5" />
                        Deploy Now
                      </>
                    )}
                  </Button>
                </DialogFooter>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ─── Template Card Sub-Component ─────────────────────────────────────────────

interface TemplateCardProps {
  template: Template
  onView: (template: Template) => void
  onDeploy: (template: Template) => void
}

function TemplateCard({ template, onView, onDeploy }: TemplateCardProps) {
  return (
    <Card className="group overflow-hidden transition-shadow hover:shadow-lg border-border/60">
      {/* Gradient preview strip */}
      <div
        className={`relative h-24 bg-gradient-to-br ${template.previewGradient} flex items-center justify-center cursor-pointer`}
        onClick={() => onView(template)}
      >
        <span className="text-4xl drop-shadow-lg select-none">
          {template.icon}
        </span>

        {/* Category badge overlaid on gradient */}
        <Badge
          variant="secondary"
          className="absolute top-2 right-2 text-[10px] bg-white/20 text-white backdrop-blur-sm border-white/10 hover:bg-white/30"
        >
          {template.category}
        </Badge>

        {/* Official badge */}
        {template.isOfficial && (
          <Badge
            variant="secondary"
            className="absolute top-2 left-2 text-[10px] bg-indigo-500/30 text-white backdrop-blur-sm border-indigo-400/20"
          >
            Official
          </Badge>
        )}
      </div>

      <CardHeader className="pb-2 pt-4 px-4">
        <CardTitle
          className="text-base leading-snug cursor-pointer hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors"
          onClick={() => onView(template)}
        >
          {template.name}
        </CardTitle>
        <CardDescription className="text-xs line-clamp-2">
          {template.description}
        </CardDescription>
      </CardHeader>

      <CardContent className="px-4 pb-2">
        {/* Stats row */}
        <div className="flex items-center gap-3 mb-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
            {formatNumber(template.stars)}
          </span>
          <span className="flex items-center gap-1">
            <Download className="h-3.5 w-3.5 text-indigo-500" />
            {formatNumber(template.deployments)}
          </span>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1.5">
          {template.tags.slice(0, 3).map((tag) => (
            <Badge
              key={tag}
              variant="outline"
              className="text-[10px] px-1.5 py-0 border-indigo-500/30 text-indigo-600 dark:text-indigo-400"
            >
              {tag}
            </Badge>
          ))}
          {template.tags.length > 3 && (
            <Badge
              variant="outline"
              className="text-[10px] px-1.5 py-0"
            >
              +{template.tags.length - 3}
            </Badge>
          )}
        </div>
      </CardContent>

      <CardFooter className="px-4 pb-4 pt-0">
        <Button
          size="sm"
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs"
          onClick={() => onDeploy(template)}
        >
          <Zap className="h-3.5 w-3.5 mr-1.5" />
          Deploy
        </Button>
      </CardFooter>
    </Card>
  )
}
