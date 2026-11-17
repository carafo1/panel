'use client'

import React, { useState, useEffect, useCallback } from 'react'
import { apiFetch } from '@/store/auth-store'
import { toast } from 'sonner'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  GitMerge,
  Play,
  Pause,
  Trash2,
  Plus,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  MoreVertical,
  ChevronRight,
  Settings,
  Settings2,
  Eye,
  Copy,
  Hammer,
  TestTube,
  Rocket,
  Package,
  Search,
  Mail,
  Puzzle,
  GitBranch,
  Zap,
  GripVertical,
  RotateCcw,
} from 'lucide-react'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'

// ── Types ────────────────────────────────────────────────────────────

interface PipelineStage {
  id: string
  name: string
  type: 'build' | 'test' | 'deploy' | 'package' | 'lint' | 'notify' | 'custom'
  command: string
  workingDir: string
  env: Record<string, string>
  timeout: number
  continueOnError: boolean
  order: number
}

interface StageResult {
  name: string
  type: string
  status: string
  duration: number
  output: string
}

interface PipelineProject {
  id: string
  name: string
  slug: string
  framework?: string
  status?: string
}

interface PipelineRun {
  id: string
  pipelineId: string
  status: string
  trigger: string
  commit?: string | null
  branch?: string | null
  stages: string
  stageResults?: StageResult[]
  startedAt: string
  completedAt?: string | null
  duration?: number | null
  pipeline?: {
    id: string
    name: string
    status: string
    triggerBranch: string
  }
}

interface Pipeline {
  id: string
  name: string
  description?: string | null
  projectId: string
  stages: string
  status: string
  triggerBranch: string
  triggerEvents: string
  lastRunAt?: string | null
  lastRunStatus?: string | null
  project: PipelineProject
  lastRun?: {
    id: string
    status: string
    trigger: string
    startedAt: string
    duration: number
  } | null
  runs?: PipelineRun[]
  createdAt: string
  updatedAt: string
}

interface Project {
  id: string
  name: string
  subdomain: string
  status: string
}

// ── Stage Type Definitions ───────────────────────────────────────────

const STAGE_TYPES: {
  type: PipelineStage['type']
  label: string
  emoji: string
  icon: typeof Hammer
  defaultCommand: string
  color: string
  accent: string
  border: string
  bg: string
}[] = [
  {
    type: 'build',
    label: 'Build',
    emoji: '🏗️',
    icon: Hammer,
    defaultCommand: 'npm run build',
    color: 'text-amber-600 dark:text-amber-400',
    accent: 'border-amber-400 dark:border-amber-600',
    border: 'border-amber-300 dark:border-amber-700',
    bg: 'bg-amber-50 dark:bg-amber-950/30',
  },
  {
    type: 'test',
    label: 'Test',
    emoji: '🧪',
    icon: TestTube,
    defaultCommand: 'npm test',
    color: 'text-indigo-600 dark:text-indigo-400',
    accent: 'border-indigo-400 dark:border-indigo-600',
    border: 'border-indigo-300 dark:border-indigo-700',
    bg: 'bg-indigo-50 dark:bg-indigo-950/30',
  },
  {
    type: 'deploy',
    label: 'Deploy',
    emoji: '🚀',
    icon: Rocket,
    defaultCommand: 'npm run deploy',
    color: 'text-indigo-600 dark:text-indigo-400',
    accent: 'border-indigo-400 dark:border-indigo-600',
    border: 'border-indigo-300 dark:border-indigo-700',
    bg: 'bg-indigo-50 dark:bg-indigo-950/30',
  },
  {
    type: 'package',
    label: 'Package',
    emoji: '📦',
    icon: Package,
    defaultCommand: 'docker build -t app .',
    color: 'text-orange-600 dark:text-orange-400',
    accent: 'border-orange-400 dark:border-orange-600',
    border: 'border-orange-300 dark:border-orange-700',
    bg: 'bg-orange-50 dark:bg-orange-950/30',
  },
  {
    type: 'lint',
    label: 'Lint',
    emoji: '🔍',
    icon: Search,
    defaultCommand: 'npx eslint .',
    color: 'text-indigo-600 dark:text-indigo-400',
    accent: 'border-indigo-400 dark:border-indigo-600',
    border: 'border-indigo-300 dark:border-indigo-700',
    bg: 'bg-indigo-50 dark:bg-indigo-950/30',
  },
  {
    type: 'notify',
    label: 'Notify',
    emoji: '📧',
    icon: Mail,
    defaultCommand: 'curl -X POST $WEBHOOK_URL',
    color: 'text-indigo-600 dark:text-indigo-400',
    accent: 'border-indigo-400 dark:border-indigo-600',
    border: 'border-indigo-300 dark:border-indigo-700',
    bg: 'bg-indigo-50 dark:bg-indigo-950/30',
  },
  {
    type: 'custom',
    label: 'Custom',
    emoji: '⚙️',
    icon: Settings2,
    defaultCommand: 'echo "Hello"',
    color: 'text-gray-600 dark:text-gray-400',
    accent: 'border-gray-400 dark:border-gray-600',
    border: 'border-gray-300 dark:border-gray-700',
    bg: 'bg-gray-50 dark:bg-gray-950/30',
  },
]

function getStageTypeDef(type: string) {
  return STAGE_TYPES.find((s) => s.type === type) || STAGE_TYPES[STAGE_TYPES.length - 1]
}

// ── Helpers ──────────────────────────────────────────────────────────

function generateStageId(): string {
  return `stage_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function createDefaultStage(type: PipelineStage['type'], order: number): PipelineStage {
  const def = getStageTypeDef(type)
  return {
    id: generateStageId(),
    name: def.label,
    type,
    command: def.defaultCommand,
    workingDir: '/',
    env: {},
    timeout: 300,
    continueOnError: false,
    order,
  }
}

/** Migrate old-style stages (no id, command as config.command) to new format */
function migrateStages(raw: unknown[]): PipelineStage[] {
  return (raw as Record<string, unknown>[]).map((s, i) => ({
    id: (s.id as string) || generateStageId(),
    name: (s.name as string) || `Stage ${i + 1}`,
    type: (s.type as PipelineStage['type']) || 'custom',
    command: (s.command as string) || (s.config && typeof s.config === 'object' ? String((s.config as Record<string, unknown>).command || '') : '') || '',
    workingDir: (s.workingDir as string) || '/',
    env: (s.env as Record<string, string>) || {},
    timeout: (s.timeout as number) ?? 300,
    continueOnError: (s.continueOnError as boolean) ?? false,
    order: (s.order as number) ?? i,
  }))
}

function parseStages(raw: string): PipelineStage[] {
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return migrateStages(parsed)
  } catch {
    return []
  }
}

function parseTriggerEvents(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatTime(dateStr: string): string {
  const d = new Date(dateStr)
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}m ${secs}s`
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'success':
      return 'bg-indigo-500'
    case 'failed':
      return 'bg-red-500'
    case 'running':
      return 'bg-amber-500'
    case 'cancelled':
      return 'bg-gray-400'
    case 'active':
      return 'bg-indigo-500'
    case 'paused':
      return 'bg-amber-500'
    case 'draft':
      return 'bg-gray-400'
    default:
      return 'bg-gray-400'
  }
}

function getStatusBadgeVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'success':
    case 'active':
      return 'default'
    case 'failed':
      return 'destructive'
    case 'running':
      return 'secondary'
    default:
      return 'outline'
  }
}

function getStageIcon(type: string) {
  const def = getStageTypeDef(type)
  return def.icon
}

function getTriggerLabel(trigger: string): string {
  switch (trigger) {
    case 'manual':
      return 'Manual'
    case 'push':
      return 'Push'
    case 'pull_request':
      return 'PR'
    case 'schedule':
      return 'Schedule'
    default:
      return trigger
  }
}

// ── Stage Type Icon Component ────────────────────────────────────────

function StageTypeIcon({ type, className }: { type: string; className?: string }) {
  const iconType = getStageIcon(type)
  return React.createElement(iconType, { className: className || 'size-4' })
}

// ── Pipeline Status Badge ────────────────────────────────────────────

function PipelineStatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; className: string }> = {
    draft: { label: 'Draft', className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700' },
    active: { label: 'Active', className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800' },
    paused: { label: 'Paused', className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800' },
  }
  const c = config[status] || config.draft
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full border ${c.className}`}>
      <span className={`size-1.5 rounded-full ${getStatusColor(status)}`} />
      {c.label}
    </span>
  )
}

// ── Run Status Badge ─────────────────────────────────────────────────

function RunStatusBadge({ status }: { status: string }) {
  const config: Record<string, { label: string; icon: React.ReactNode; className: string }> = {
    success: {
      label: 'Success',
      icon: <CheckCircle2 className="size-3" />,
      className: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300',
    },
    failed: {
      label: 'Failed',
      icon: <XCircle className="size-3" />,
      className: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
    },
    running: {
      label: 'Running',
      icon: <Loader2 className="size-3 animate-spin" />,
      className: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    },
    cancelled: {
      label: 'Cancelled',
      icon: <Clock className="size-3" />,
      className: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    },
  }
  const c = config[status] || config.running
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full ${c.className}`}>
      {c.icon}
      {c.label}
    </span>
  )
}

// ── Stage Picker Dialog ──────────────────────────────────────────────

function StagePickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (type: PipelineStage['type']) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-5 text-indigo-600" />
            Add Stage
          </DialogTitle>
          <DialogDescription>
            Choose a stage type to add to your pipeline.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 py-2">
          {STAGE_TYPES.map((st) => {
            const Icon = st.icon
            return (
              <button
                key={st.type}
                type="button"
                onClick={() => {
                  onSelect(st.type)
                  onOpenChange(false)
                }}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all hover:shadow-md hover:scale-[1.02] active:scale-[0.98] ${st.border} ${st.bg} hover:${st.accent}`}
              >
                <span className="text-2xl">{st.emoji}</span>
                <span className={`text-sm font-semibold ${st.color}`}>{st.label}</span>
                <span className="text-[10px] text-muted-foreground font-mono truncate w-full text-center">
                  {st.defaultCommand}
                </span>
              </button>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Stage Config Dialog ──────────────────────────────────────────────

function StageConfigDialog({
  open,
  onOpenChange,
  stage,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stage: PipelineStage | null
  onSave: (updated: PipelineStage) => void
}) {
  if (!stage) return null

  return (
    <StageConfigDialogInner
      key={stage.id}
      open={open}
      onOpenChange={onOpenChange}
      stage={stage}
      onSave={onSave}
    />
  )
}

function StageConfigDialogInner({
  open,
  onOpenChange,
  stage,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  stage: PipelineStage
  onSave: (updated: PipelineStage) => void
}) {
  const [edit, setEdit] = useState<PipelineStage>({ ...stage })

  const def = getStageTypeDef(edit.type)

  const handleSave = () => {
    onSave(edit)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-xl">{def.emoji}</span>
            Configure Stage: {edit.name}
          </DialogTitle>
          <DialogDescription>
            Configure the command, environment, and behavior for this stage.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto pe-1">
          {/* Name */}
          <div className="space-y-2">
            <Label>Stage Name</Label>
            <Input
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              placeholder="e.g. Build Application"
            />
          </div>

          {/* Type */}
          <div className="space-y-2">
            <Label>Stage Type</Label>
            <Select
              value={edit.type}
              onValueChange={(val) => setEdit({ ...edit, type: val as PipelineStage['type'] })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAGE_TYPES.map((st) => (
                  <SelectItem key={st.type} value={st.type}>
                    <span className="flex items-center gap-2">
                      <span>{st.emoji}</span>
                      {st.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Command */}
          <div className="space-y-2">
            <Label>Command</Label>
            <Textarea
              value={edit.command}
              onChange={(e) => setEdit({ ...edit, command: e.target.value })}
              placeholder="e.g. npm run build"
              className="font-mono text-sm min-h-20"
            />
          </div>

          {/* Working Directory */}
          <div className="space-y-2">
            <Label>Working Directory</Label>
            <Input
              value={edit.workingDir}
              onChange={(e) => setEdit({ ...edit, workingDir: e.target.value })}
              placeholder="/"
              className="font-mono"
            />
          </div>

          {/* Timeout */}
          <div className="space-y-2">
            <Label>Timeout (seconds)</Label>
            <Input
              type="number"
              value={edit.timeout}
              onChange={(e) => setEdit({ ...edit, timeout: parseInt(e.target.value) || 300 })}
              min={1}
              max={3600}
            />
          </div>

          {/* Continue on Error */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Continue on Error</Label>
              <p className="text-xs text-muted-foreground">
                Allow the pipeline to continue even if this stage fails
              </p>
            </div>
            <Switch
              checked={edit.continueOnError}
              onCheckedChange={(checked) => setEdit({ ...edit, continueOnError: checked })}
            />
          </div>

          {/* Environment Variables */}
          <div className="space-y-2">
            <Label>Environment Variables</Label>
            <Textarea
              value={Object.entries(edit.env)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n')}
              onChange={(e) => {
                const env: Record<string, string> = {}
                e.target.value.split('\n').forEach((line) => {
                  const idx = line.indexOf('=')
                  if (idx > 0) {
                    env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
                  }
                })
                setEdit({ ...edit, env })
              }}
              placeholder="KEY=value&#10;ANOTHER_KEY=another_value"
              className="font-mono text-sm min-h-20"
            />
            <p className="text-xs text-muted-foreground">
              One variable per line, in KEY=value format
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} className="bg-indigo-600 hover:bg-indigo-700">
            Save Configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Sortable Stage Card ──────────────────────────────────────────────

function SortableStageCard({
  stage,
  index,
  readOnly,
  onRemove,
  onEdit,
}: {
  stage: PipelineStage
  index: number
  readOnly: boolean
  onRemove: () => void
  onEdit: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: stage.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : undefined,
  }

  const def = getStageTypeDef(stage.type)
  const Icon = def.icon

  return (
    <div ref={setNodeRef} style={style} className="flex items-start">
      {/* Stage Card */}
      <div
        className={`relative w-56 rounded-xl border-2 p-4 transition-all hover:shadow-md group ${def.border} ${def.bg}`}
      >
        {/* Drag handle + order badge */}
        <div className="absolute -top-2 -start-2 flex items-center gap-0.5">
          <div className="size-5 rounded-full bg-background border-2 flex items-center justify-center text-[10px] font-bold text-muted-foreground" style={{ borderColor: 'var(--border)' }}>
            {index + 1}
          </div>
          {!readOnly && (
            <div
              {...attributes}
              {...listeners}
              className="size-5 rounded-full bg-background border-2 flex items-center justify-center cursor-grab active:cursor-grabbing hover:bg-muted transition-colors"
              style={{ borderColor: 'var(--border)' }}
            >
              <GripVertical className="size-3 text-muted-foreground" />
            </div>
          )}
        </div>

        {/* Stage header */}
        <div className="flex items-center justify-between mb-2 mt-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <Icon className={`size-4 shrink-0 ${def.color}`} />
            <span className="text-sm font-semibold truncate">{stage.name}</span>
          </div>
          {!readOnly && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6"
                    onClick={onEdit}
                  >
                    <Settings2 className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Configure stage</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-6 text-red-500 hover:text-red-600"
                    onClick={onRemove}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Remove stage</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>

        {/* Stage type badge */}
        <Badge variant="outline" className={`text-[10px] h-5 ${def.color} border-current/20`}>
          {def.emoji} {def.label}
        </Badge>

        {/* Command preview */}
        <div className="mt-2 text-[11px] text-muted-foreground font-mono truncate">
          {stage.command || 'No command configured'}
        </div>

        {/* Quick config pills */}
        <div className="flex flex-wrap gap-1 mt-2">
          {stage.timeout !== 300 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {stage.timeout}s timeout
            </span>
          )}
          {stage.continueOnError && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
              continue on error
            </span>
          )}
          {Object.keys(stage.env).length > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              {Object.keys(stage.env).length} env var{Object.keys(stage.env).length > 1 ? 's' : ''}
            </span>
          )}
          {stage.workingDir !== '/' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
              📁 {stage.workingDir}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Visual Stage Editor (dnd-kit powered) ────────────────────────────

function VisualStageEditor({
  stages,
  onUpdateStages,
  readOnly,
}: {
  stages: PipelineStage[]
  onUpdateStages: (stages: PipelineStage[]) => void
  readOnly?: boolean
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [editingStage, setEditingStage] = useState<PipelineStage | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    })
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id))
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null)
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = stages.findIndex((s) => s.id === active.id)
    const newIndex = stages.findIndex((s) => s.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(stages, oldIndex, newIndex).map((s, i) => ({
      ...s,
      order: i,
    }))
    onUpdateStages(reordered)
  }

  const handleAddStage = (type: PipelineStage['type']) => {
    const newStage = createDefaultStage(type, stages.length)
    onUpdateStages([...stages, newStage])
  }

  const removeStage = (id: string) => {
    const updated = stages.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i }))
    onUpdateStages(updated)
  }

  const updateStage = (id: string, updates: Partial<PipelineStage>) => {
    const updated = stages.map((s) => (s.id === id ? { ...s, ...updates } : s))
    onUpdateStages(updated)
  }

  const openConfig = (stage: PipelineStage) => {
    setEditingStage(stage)
    setConfigOpen(true)
  }

  const handleConfigSave = (updated: PipelineStage) => {
    updateStage(updated.id, updated)
  }

  const activeStage = activeId ? stages.find((s) => s.id === activeId) : null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">Pipeline Stages</Label>
        {!readOnly && (
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)} className="h-7 text-xs">
            <Plus className="size-3 me-1" />
            Add Stage
          </Button>
        )}
      </div>

      {stages.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed rounded-xl">
          <GitMerge className="size-10 text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground mb-1">No stages configured</p>
          <p className="text-xs text-muted-foreground/60 mb-4">
            Add stages to define your pipeline workflow
          </p>
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
              <Plus className="size-3.5 me-1" />
              Add First Stage
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto pb-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={stages.map((s) => s.id)}
              strategy={horizontalListSortingStrategy}
            >
              <div className="flex items-start gap-0 min-w-max">
                {stages.map((stage, index) => (
                  <div key={stage.id} className="flex items-start">
                    <SortableStageCard
                      stage={stage}
                      index={index}
                      readOnly={!!readOnly}
                      onRemove={() => removeStage(stage.id)}
                      onEdit={() => openConfig(stage)}
                    />
                    {/* Connector Arrow */}
                    {index < stages.length - 1 && (
                      <div className="flex items-center h-36 px-1">
                        <div className="flex items-center">
                          <div className="w-6 h-0.5 bg-border" />
                          <ArrowRight className="size-4 text-muted-foreground -ms-0.5" />
                        </div>
                      </div>
                    )}
                  </div>
                ))}

                {/* Add stage button at the end */}
                {!readOnly && stages.length > 0 && (
                  <div className="flex items-center h-36 ps-2">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-8 rounded-full border-dashed"
                          onClick={() => setPickerOpen(true)}
                        >
                          <Plus className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Add stage</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>
            </SortableContext>

            {/* Drag overlay */}
            <DragOverlay>
              {activeStage ? (
                <div className="w-56 rounded-xl border-2 p-4 shadow-xl bg-background opacity-90">
                  <div className="flex items-center gap-1.5 mb-2">
                    {React.createElement(getStageIcon(activeStage.type), {
                      className: `size-4 ${getStageTypeDef(activeStage.type).color}`,
                    })}
                    <span className="text-sm font-semibold">{activeStage.name}</span>
                  </div>
                  <div className="text-[11px] text-muted-foreground font-mono truncate">
                    {activeStage.command || 'No command'}
                  </div>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {/* Stage Picker Dialog */}
      <StagePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={handleAddStage}
      />

      {/* Stage Config Dialog */}
      <StageConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        stage={editingStage}
        onSave={handleConfigSave}
      />
    </div>
  )
}

// ── Horizontal Run Progress ──────────────────────────────────────────

function HorizontalRunProgress({
  stageResults,
  stages,
  selectedStage,
  onSelectStage,
}: {
  stageResults: StageResult[]
  stages: PipelineStage[]
  selectedStage: number | null
  onSelectStage: (index: number | null) => void
}) {
  if (stageResults.length === 0 && stages.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        No stage data available
      </div>
    )
  }

  const displayStages = stageResults.length > 0
    ? stageResults.map((sr, i) => ({
        name: sr.name,
        type: sr.type,
        status: sr.status,
        duration: sr.duration,
        output: sr.output,
        index: i,
      }))
    : stages.map((s, i) => ({
        name: s.name,
        type: s.type,
        status: 'pending',
        duration: 0,
        output: '',
        index: i,
      }))

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex items-start gap-0 min-w-max">
        {displayStages.map((stage, index) => {
          const def = getStageTypeDef(stage.type)
          const Icon = def.icon

          const statusStyles: Record<string, { border: string; bg: string; dot: string; glow: string }> = {
            pending: {
              border: 'border-gray-300 dark:border-gray-700',
              bg: 'bg-gray-50 dark:bg-gray-900/30',
              dot: 'bg-gray-400',
              glow: '',
            },
            running: {
              border: 'border-indigo-400 dark:border-indigo-600',
              bg: 'bg-indigo-50 dark:bg-indigo-950/30',
              dot: 'bg-indigo-500',
              glow: 'ring-2 ring-indigo-400/30',
            },
            success: {
              border: 'border-indigo-400 dark:border-indigo-600',
              bg: 'bg-indigo-50 dark:bg-indigo-950/30',
              dot: 'bg-indigo-500',
              glow: '',
            },
            failed: {
              border: 'border-red-400 dark:border-red-600',
              bg: 'bg-red-50 dark:bg-red-950/30',
              dot: 'bg-red-500',
              glow: '',
            },
            skipped: {
              border: 'border-yellow-400 dark:border-yellow-600',
              bg: 'bg-yellow-50 dark:bg-yellow-950/30',
              dot: 'bg-yellow-500',
              glow: '',
            },
          }

          const st = statusStyles[stage.status] || statusStyles.pending
          const isSelected = selectedStage === index

          const statusIcon =
            stage.status === 'success' ? (
              <CheckCircle2 className="size-4 text-indigo-500" />
            ) : stage.status === 'failed' ? (
              <XCircle className="size-4 text-red-500" />
            ) : stage.status === 'running' ? (
              <Loader2 className="size-4 text-indigo-500 animate-spin" />
            ) : stage.status === 'skipped' ? (
              <Clock className="size-4 text-yellow-500" />
            ) : (
              <Clock className="size-4 text-gray-400" />
            )

          return (
            <div key={index} className="flex items-start">
              <button
                type="button"
                onClick={() => onSelectStage(isSelected ? null : index)}
                className={`relative w-48 rounded-xl border-2 p-3 transition-all hover:shadow-md text-start ${st.border} ${st.bg} ${st.glow} ${isSelected ? 'ring-2 ring-indigo-500/50 shadow-lg' : ''}`}
              >
                {/* Status indicator */}
                <div className="absolute -top-1.5 -start-1.5">
                  {statusIcon}
                </div>

                {/* Stage name + type */}
                <div className="flex items-center gap-1.5 mb-1 mt-1">
                  <Icon className={`size-3.5 ${def.color}`} />
                  <span className="text-sm font-semibold truncate">{stage.name}</span>
                </div>

                <Badge variant="outline" className={`text-[9px] h-4 px-1.5 ${def.color}`}>
                  {def.emoji} {def.label}
                </Badge>

                {/* Duration */}
                {stage.duration > 0 && (
                  <div className="mt-1.5 text-[10px] font-mono text-muted-foreground">
                    {formatDuration(stage.duration)}
                  </div>
                )}

                {/* Status text */}
                <div className="mt-1 text-[10px] font-medium capitalize" style={{
                  color: stage.status === 'success' ? '#059669' :
                    stage.status === 'failed' ? '#dc2626' :
                    stage.status === 'running' ? '#0284c7' :
                    stage.status === 'skipped' ? '#ca8a04' :
                    '#9ca3af'
                }}>
                  {stage.status}
                </div>
              </button>

              {/* Connector Arrow */}
              {index < displayStages.length - 1 && (
                <div className="flex items-center h-28 px-0.5">
                  <div className="flex items-center">
                    <div className={`w-5 h-0.5 ${
                      stage.status === 'success' ? 'bg-indigo-300 dark:bg-indigo-700' :
                      stage.status === 'running' ? 'bg-indigo-300 dark:bg-indigo-700' :
                      'bg-border'
                    }`} />
                    <ArrowRight className={`size-3 -ms-0.5 ${
                      stage.status === 'success' ? 'text-indigo-400' :
                      stage.status === 'running' ? 'text-indigo-400' :
                      'text-muted-foreground'
                    }`} />
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Run Timeline (vertical, with logs) ───────────────────────────────

function RunTimeline({
  stageResults,
  expandedStage,
  onToggleStage,
}: {
  stageResults: StageResult[]
  expandedStage: number | null
  onToggleStage: (index: number) => void
}) {
  if (stageResults.length === 0) {
    return (
      <div className="text-sm text-muted-foreground text-center py-8">
        No stage results available
      </div>
    )
  }

  return (
    <div className="space-y-0">
      {stageResults.map((stage, index) => {
        const statusIcon =
          stage.status === 'success' ? (
            <CheckCircle2 className="size-5 text-indigo-500" />
          ) : stage.status === 'failed' ? (
            <XCircle className="size-5 text-red-500" />
          ) : stage.status === 'running' ? (
            <Loader2 className="size-5 text-indigo-500 animate-spin" />
          ) : stage.status === 'skipped' ? (
            <Clock className="size-5 text-yellow-500" />
          ) : (
            <Clock className="size-5 text-gray-400" />
          )

        const statusBg =
          stage.status === 'success'
            ? 'bg-indigo-50 dark:bg-indigo-950/20 border-indigo-200 dark:border-indigo-800'
            : stage.status === 'failed'
              ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
              : stage.status === 'running'
                ? 'bg-indigo-50 dark:bg-indigo-950/20 border-indigo-200 dark:border-indigo-800'
                : 'bg-gray-50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-800'

        const isExpanded = expandedStage === index

        return (
          <div key={index} className="flex gap-4">
            {/* Timeline line + dot */}
            <div className="flex flex-col items-center">
              <button type="button" onClick={() => onToggleStage(index)} className="shrink-0 mt-1 hover:scale-110 transition-transform">
                {statusIcon}
              </button>
              {index < stageResults.length - 1 && (
                <div className={`w-px flex-1 min-h-[24px] my-1 ${
                  stage.status === 'success' ? 'bg-indigo-300 dark:bg-indigo-700' :
                  stage.status === 'failed' ? 'bg-red-300 dark:bg-red-700' :
                  'bg-border'
                }`} />
              )}
            </div>

            {/* Stage content */}
            <div className={`flex-1 rounded-lg border p-3 mb-2 cursor-pointer transition-all ${statusBg} ${isExpanded ? 'shadow-md' : ''}`} onClick={() => onToggleStage(index)}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <StageTypeIcon type={stage.type} className="size-3.5 text-muted-foreground" />
                  <span className="text-sm font-medium">{stage.name}</span>
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5">
                    {stage.type}
                  </Badge>
                  <Badge variant="outline" className="text-[10px] h-4 px-1.5 capitalize">
                    {stage.status}
                  </Badge>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground font-mono">
                    {formatDuration(stage.duration)}
                  </span>
                  <ChevronRight className={`size-3.5 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
                </div>
              </div>
              {isExpanded && stage.output && (
                <pre className="text-xs font-mono text-muted-foreground bg-white/60 dark:bg-black/20 rounded p-2 mt-1.5 whitespace-pre-wrap overflow-x-auto max-h-48 overflow-y-auto">
                  {stage.output}
                </pre>
              )}
              {isExpanded && !stage.output && (
                <p className="text-xs text-muted-foreground/60 mt-1.5 italic">No output available</p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Pipeline Flowchart (read-only visual) ────────────────────────────

function PipelineFlowchart({ stages }: { stages: PipelineStage[] }) {
  if (stages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <GitMerge className="size-10 mb-3 opacity-40" />
        <p className="text-sm">No stages configured</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto pb-2">
      <div className="flex items-center gap-0 min-w-max">
        {/* Start node */}
        <div className="flex items-center">
          <div className="w-10 h-10 rounded-full bg-indigo-100 dark:bg-indigo-900/40 border-2 border-indigo-400 dark:border-indigo-600 flex items-center justify-center">
            <Play className="size-4 text-indigo-600 dark:text-indigo-400" />
          </div>
          <div className="w-8 h-0.5 bg-indigo-300 dark:bg-indigo-700" />
          <ArrowRight className="size-4 text-indigo-400 -ms-0.5" />
        </div>

        {stages.map((stage, index) => {
          const def = getStageTypeDef(stage.type)
          const Icon = def.icon

          return (
            <div key={stage.id} className="flex items-center">
              <div className={`w-52 rounded-xl border-2 p-3 ${def.border} ${def.bg}`}>
                <div className="flex items-center gap-1.5 mb-1">
                  <Icon className={`size-4 ${def.color}`} />
                  <span className="text-sm font-semibold truncate">{stage.name}</span>
                </div>
                <Badge variant="outline" className={`text-[9px] h-4 px-1.5 ${def.color} border-current/20`}>
                  {def.emoji} {def.label}
                </Badge>
                <div className="mt-1 text-[10px] text-muted-foreground font-mono truncate">
                  {stage.command || 'No command'}
                </div>
              </div>

              {index < stages.length - 1 && (
                <div className="flex items-center px-0.5">
                  <div className="w-6 h-0.5 bg-border" />
                  <ArrowRight className="size-3.5 text-muted-foreground -ms-0.5" />
                </div>
              )}
            </div>
          )
        })}

        {/* End node */}
        <div className="flex items-center">
          <div className="w-6 h-0.5 bg-border" />
          <ArrowRight className="size-3.5 text-muted-foreground -ms-0.5" />
          <div className="w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-900/40 border-2 border-gray-400 dark:border-gray-600 flex items-center justify-center">
            <CheckCircle2 className="size-4 text-gray-600 dark:text-gray-400" />
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Main Pipelines Panel ─────────────────────────────────────────────

type ViewMode = 'list' | 'detail' | 'run'

export default function PipelinesPanel() {
  const [view, setView] = useState<ViewMode>('list')
  const [pipelines, setPipelines] = useState<Pipeline[]>([])
  const [selectedPipeline, setSelectedPipeline] = useState<Pipeline | null>(null)
  const [selectedRun, setSelectedRun] = useState<PipelineRun | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [runLoading, setRunLoading] = useState(false)
  const [triggeringRun, setTriggeringRun] = useState(false)

  // Create dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newPipelineName, setNewPipelineName] = useState('')
  const [newPipelineProjectId, setNewPipelineProjectId] = useState('')
  const [newPipelineDescription, setNewPipelineDescription] = useState('')
  const [creating, setCreating] = useState(false)

  // Delete dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [pipelineToDelete, setPipelineToDelete] = useState<Pipeline | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Stage editor state
  const [editStages, setEditStages] = useState<PipelineStage[]>([])
  const [savingStages, setSavingStages] = useState(false)

  // Run visualization state
  const [selectedRunStage, setSelectedRunStage] = useState<number | null>(null)
  const [expandedTimelineStage, setExpandedTimelineStage] = useState<number | null>(null)

  // ── Fetch pipelines ────────────────────────────────────────────────
  const fetchPipelines = useCallback(async () => {
    setLoading(true)
    try {
      const data = await apiFetch('/pipelines')
      setPipelines(data.pipelines || [])
    } catch (err) {
      toast.error('Failed to load pipelines', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Fetch projects (for create dialog) ─────────────────────────────
  const fetchProjects = useCallback(async () => {
    try {
      const data = await apiFetch('/hosting')
      setProjects(data.projects || [])
    } catch {
      // Silently handle — projects are only needed for create dialog
    }
  }, [])

  useEffect(() => {
    fetchPipelines()
    fetchProjects()
  }, [fetchPipelines, fetchProjects])

  // ── Fetch pipeline detail ──────────────────────────────────────────
  const fetchPipelineDetail = useCallback(async (pipelineId: string) => {
    setDetailLoading(true)
    try {
      const data = await apiFetch(`/pipelines/${pipelineId}`)
      const pipeline = data.pipeline
      setSelectedPipeline(pipeline)
      setEditStages(parseStages(pipeline.stages))
    } catch (err) {
      toast.error('Failed to load pipeline', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      setView('list')
    } finally {
      setDetailLoading(false)
    }
  }, [])

  // ── Fetch run detail ───────────────────────────────────────────────
  const fetchRunDetail = useCallback(async (pipelineId: string, runId: string) => {
    setRunLoading(true)
    try {
      const data = await apiFetch(`/pipelines/${pipelineId}/runs/${runId}`)
      setSelectedRun(data.run)
    } catch (err) {
      toast.error('Failed to load run details', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
      setView('detail')
    } finally {
      setRunLoading(false)
    }
  }, [])

  // ── Navigate to pipeline detail ────────────────────────────────────
  const openPipeline = (pipeline: Pipeline) => {
    setView('detail')
    fetchPipelineDetail(pipeline.id)
  }

  // ── Navigate to run detail ─────────────────────────────────────────
  const openRun = (run: PipelineRun) => {
    if (!selectedPipeline) return
    setView('run')
    setSelectedRunStage(null)
    setExpandedTimelineStage(null)
    fetchRunDetail(selectedPipeline.id, run.id)
  }

  // ── Navigate back ──────────────────────────────────────────────────
  const goBack = () => {
    if (view === 'run') {
      setView('detail')
      setSelectedRun(null)
      setSelectedRunStage(null)
      setExpandedTimelineStage(null)
    } else if (view === 'detail') {
      setView('list')
      setSelectedPipeline(null)
      setEditStages([])
    }
  }

  // ── Create pipeline ────────────────────────────────────────────────
  const handleCreatePipeline = async () => {
    if (!newPipelineName.trim()) {
      toast.error('Pipeline name is required')
      return
    }
    if (!newPipelineProjectId) {
      toast.error('Please select a project')
      return
    }
    setCreating(true)
    try {
      const data = await apiFetch('/pipelines', {
        method: 'POST',
        body: JSON.stringify({
          name: newPipelineName.trim(),
          projectId: newPipelineProjectId,
          description: newPipelineDescription.trim() || undefined,
        }),
      })
      toast.success('Pipeline created', {
        description: `"${data.pipeline.name}" has been created as a draft.`,
      })
      setCreateDialogOpen(false)
      setNewPipelineName('')
      setNewPipelineProjectId('')
      setNewPipelineDescription('')
      fetchPipelines()
    } catch (err) {
      toast.error('Failed to create pipeline', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setCreating(false)
    }
  }

  // ── Delete pipeline ────────────────────────────────────────────────
  const handleDeletePipeline = async () => {
    if (!pipelineToDelete) return
    setDeleting(true)
    try {
      await apiFetch(`/pipelines/${pipelineToDelete.id}`, { method: 'DELETE' })
      toast.success('Pipeline deleted', {
        description: `"${pipelineToDelete.name}" has been deleted.`,
      })
      setDeleteDialogOpen(false)
      setPipelineToDelete(null)
      if (selectedPipeline?.id === pipelineToDelete.id) {
        setView('list')
        setSelectedPipeline(null)
      }
      fetchPipelines()
    } catch (err) {
      toast.error('Failed to delete pipeline', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setDeleting(false)
    }
  }

  // ── Update pipeline status ─────────────────────────────────────────
  const handleStatusChange = async (pipeline: Pipeline, newStatus: string) => {
    try {
      await apiFetch(`/pipelines/${pipeline.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: newStatus }),
      })
      toast.success(`Pipeline ${newStatus}`, {
        description: `"${pipeline.name}" is now ${newStatus}.`,
      })
      fetchPipelineDetail(pipeline.id)
      fetchPipelines()
    } catch (err) {
      toast.error('Failed to update pipeline', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // ── Save stages ────────────────────────────────────────────────────
  const handleSaveStages = async () => {
    if (!selectedPipeline) return
    setSavingStages(true)
    try {
      await apiFetch(`/pipelines/${selectedPipeline.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ stages: editStages }),
      })
      toast.success('Stages saved', {
        description: 'Pipeline configuration has been updated.',
      })
      fetchPipelineDetail(selectedPipeline.id)
    } catch (err) {
      toast.error('Failed to save stages', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSavingStages(false)
    }
  }

  // ── Trigger manual run ─────────────────────────────────────────────
  const handleTriggerRun = async (pipeline: Pipeline) => {
    if (pipeline.status !== 'active') {
      toast.error('Pipeline must be active to trigger a run')
      return
    }
    setTriggeringRun(true)
    try {
      const data = await apiFetch(`/pipelines/${pipeline.id}/runs`, {
        method: 'POST',
        body: JSON.stringify({ trigger: 'manual' }),
      })
      toast.success('Pipeline run triggered', {
        description: `Run #${data.run.id.slice(-6)} has started.`,
      })
      fetchPipelineDetail(pipeline.id)
      fetchPipelines()
    } catch (err) {
      toast.error('Failed to trigger run', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setTriggeringRun(false)
    }
  }

  // ── Duplicate pipeline ─────────────────────────────────────────────
  const handleDuplicatePipeline = async (pipeline: Pipeline) => {
    try {
      const data = await apiFetch('/pipelines', {
        method: 'POST',
        body: JSON.stringify({
          name: `${pipeline.name} (Copy)`,
          projectId: pipeline.projectId,
          description: pipeline.description || undefined,
          stages: parseStages(pipeline.stages),
          triggerBranch: pipeline.triggerBranch,
          triggerEvents: parseTriggerEvents(pipeline.triggerEvents),
        }),
      })
      toast.success('Pipeline duplicated', {
        description: `"${data.pipeline.name}" has been created.`,
      })
      fetchPipelines()
    } catch (err) {
      toast.error('Failed to duplicate pipeline', {
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // ── Render: Loading Skeletons ──────────────────────────────────────

  const renderLoadingSkeletons = () => (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-9 w-36" />
      </div>
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="p-5">
            <div className="flex items-center justify-between">
              <div className="space-y-2 flex-1">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-32" />
              </div>
              <Skeleton className="h-6 w-20" />
            </div>
            <div className="flex items-center gap-4 mt-4">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-24" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )

  // ── Render: List View ──────────────────────────────────────────────

  const renderListView = () => {
    if (loading) return renderLoadingSkeletons()

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">Pipelines</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Manage CI/CD pipelines for your projects
            </p>
          </div>
          <Button
            onClick={() => setCreateDialogOpen(true)}
            className="bg-indigo-600 hover:bg-indigo-700"
          >
            <Plus className="size-4 me-1.5" />
            New Pipeline
          </Button>
        </div>

        {/* Empty State */}
        {pipelines.length === 0 && (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-16">
              <GitMerge className="size-12 text-muted-foreground/40 mb-4" />
              <h3 className="text-lg font-semibold mb-1">No pipelines yet</h3>
              <p className="text-sm text-muted-foreground mb-4 text-center max-w-sm">
                Create your first pipeline to automate builds, tests, and deployments for your projects.
              </p>
              <Button
                onClick={() => setCreateDialogOpen(true)}
                className="bg-indigo-600 hover:bg-indigo-700"
              >
                <Plus className="size-4 me-1.5" />
                Create Pipeline
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Pipeline Cards */}
        <div className="space-y-3">
          {pipelines.map((pipeline) => {
            const stages = parseStages(pipeline.stages)
            const events = parseTriggerEvents(pipeline.triggerEvents)

            return (
              <Card
                key={pipeline.id}
                className="hover:shadow-md transition-shadow cursor-pointer group"
                onClick={() => openPipeline(pipeline)}
              >
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <GitMerge className="size-4 text-indigo-600 shrink-0" />
                        <h3 className="font-semibold truncate">{pipeline.name}</h3>
                        <PipelineStatusBadge status={pipeline.status} />
                      </div>
                      {pipeline.description && (
                        <p className="text-sm text-muted-foreground mb-2 line-clamp-1">
                          {pipeline.description}
                        </p>
                      )}
                      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <span className="font-medium text-foreground">{pipeline.project?.name || 'Unknown'}</span>
                        </span>
                        <span className="flex items-center gap-1">
                          <GitBranch className="size-3" />
                          {pipeline.triggerBranch}
                        </span>
                        <span className="flex items-center gap-1">
                          <Zap className="size-3" />
                          {events.join(', ')}
                        </span>
                        <span className="flex items-center gap-1">
                          <Clock className="size-3" />
                          {stages.length} stage{stages.length !== 1 ? 's' : ''}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {/* Last run status */}
                      {pipeline.lastRun ? (
                        <div className="text-end hidden sm:block">
                          <RunStatusBadge status={pipeline.lastRun.status} />
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {formatDuration(pipeline.lastRun.duration)} ago
                          </p>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground hidden sm:inline">No runs yet</span>
                      )}

                      {/* Actions dropdown */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              openPipeline(pipeline)
                            }}
                          >
                            <Eye className="size-3.5 me-2" />
                            View Details
                          </DropdownMenuItem>
                          {pipeline.status === 'active' && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                handleTriggerRun(pipeline)
                              }}
                            >
                              <Play className="size-3.5 me-2" />
                              Trigger Run
                            </DropdownMenuItem>
                          )}
                          {pipeline.status === 'draft' && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                handleStatusChange(pipeline, 'active')
                              }}
                            >
                              <Play className="size-3.5 me-2" />
                              Activate
                            </DropdownMenuItem>
                          )}
                          {pipeline.status === 'active' && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                handleStatusChange(pipeline, 'paused')
                              }}
                            >
                              <Pause className="size-3.5 me-2" />
                              Pause
                            </DropdownMenuItem>
                          )}
                          {pipeline.status === 'paused' && (
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation()
                                handleStatusChange(pipeline, 'active')
                              }}
                            >
                              <Play className="size-3.5 me-2" />
                              Resume
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDuplicatePipeline(pipeline)
                            }}
                          >
                            <Copy className="size-3.5 me-2" />
                            Duplicate
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            className="text-red-600 focus:text-red-600"
                            onClick={(e) => {
                              e.stopPropagation()
                              setPipelineToDelete(pipeline)
                              setDeleteDialogOpen(true)
                            }}
                          >
                            <Trash2 className="size-3.5 me-2" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Stage mini-preview with flowchart style */}
                  {stages.length > 0 && (
                    <div className="flex items-center gap-0.5 mt-3 overflow-x-auto">
                      {stages.map((stage, idx) => {
                        const def = getStageTypeDef(stage.type)
                        return (
                          <div key={stage.id} className="flex items-center">
                            <div className={`flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] ${def.bg} ${def.border} border ${def.color} font-medium`}>
                              {React.createElement(def.icon, { className: 'size-2.5' })}
                              <span className="whitespace-nowrap">{stage.name}</span>
                            </div>
                            {idx < stages.length - 1 && (
                              <ArrowRight className="size-2.5 text-muted-foreground/40 mx-0.5 shrink-0" />
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      </div>
    )
  }

  // ── Render: Detail View ────────────────────────────────────────────

  const renderDetailView = () => {
    if (detailLoading) {
      return (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Skeleton className="size-8" />
            <Skeleton className="h-6 w-48" />
          </div>
          <Card>
            <CardContent className="p-5 space-y-4">
              <Skeleton className="h-5 w-64" />
              <Skeleton className="h-32 w-full" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-5 space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </CardContent>
          </Card>
        </div>
      )
    }

    if (!selectedPipeline) return null

    const stages = parseStages(selectedPipeline.stages)
    const events = parseTriggerEvents(selectedPipeline.triggerEvents)
    const runs = selectedPipeline.runs || []

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="size-8" onClick={goBack}>
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold">{selectedPipeline.name}</h2>
                <PipelineStatusBadge status={selectedPipeline.status} />
              </div>
              <p className="text-sm text-muted-foreground">
                {selectedPipeline.project?.name} &middot; {selectedPipeline.triggerBranch}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {selectedPipeline.status === 'draft' && (
              <Button
                size="sm"
                onClick={() => handleStatusChange(selectedPipeline, 'active')}
                className="bg-indigo-600 hover:bg-indigo-700 h-8"
              >
                <Play className="size-3.5 me-1" />
                Activate
              </Button>
            )}
            {selectedPipeline.status === 'active' && (
              <>
                <Button
                  size="sm"
                  onClick={() => handleTriggerRun(selectedPipeline)}
                  disabled={triggeringRun}
                  className="bg-indigo-600 hover:bg-indigo-700 h-8"
                >
                  {triggeringRun ? (
                    <Loader2 className="size-3.5 me-1 animate-spin" />
                  ) : (
                    <Play className="size-3.5 me-1" />
                  )}
                  Run Now
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleStatusChange(selectedPipeline, 'paused')}
                  className="h-8"
                >
                  <Pause className="size-3.5 me-1" />
                  Pause
                </Button>
              </>
            )}
            {selectedPipeline.status === 'paused' && (
              <Button
                size="sm"
                onClick={() => handleStatusChange(selectedPipeline, 'active')}
                className="bg-indigo-600 hover:bg-indigo-700 h-8"
              >
                <Play className="size-3.5 me-1" />
                Resume
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="size-8">
                  <MoreVertical className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleDuplicatePipeline(selectedPipeline)}>
                  <Copy className="size-3.5 me-2" />
                  Duplicate
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-red-600 focus:text-red-600"
                  onClick={() => {
                    setPipelineToDelete(selectedPipeline)
                    setDeleteDialogOpen(true)
                  }}
                >
                  <Trash2 className="size-3.5 me-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Pipeline Info + Trigger Config */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2">
            <CardContent className="p-5">
              {selectedPipeline.description && (
                <p className="text-sm text-muted-foreground mb-3">{selectedPipeline.description}</p>
              )}
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <GitBranch className="size-3.5" />
                  <span>Branch:</span>
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{selectedPipeline.triggerBranch}</code>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Zap className="size-3.5" />
                  <span>Triggers:</span>
                  <div className="flex gap-1">
                    {events.map((e) => (
                      <Badge key={e} variant="outline" className="text-[10px] h-5">
                        {e}
                      </Badge>
                    ))}
                  </div>
                </div>
                {selectedPipeline.lastRunAt && (
                  <div className="flex items-center gap-1.5 text-muted-foreground">
                    <Clock className="size-3.5" />
                    <span>Last run:</span>
                    <span>{formatDate(selectedPipeline.lastRunAt)}</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Trigger Config Sidebar Card */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-2">
                <Zap className="size-3.5 text-indigo-600" />
                Trigger Configuration
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Branch</span>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{selectedPipeline.triggerBranch}</code>
              </div>
              <Separator />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Events</span>
                <div className="flex gap-1 flex-wrap justify-end">
                  {events.map((e) => (
                    <Badge key={e} variant="outline" className="text-[9px] h-4 px-1.5">
                      {e}
                    </Badge>
                  ))}
                </div>
              </div>
              <Separator />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Status</span>
                <PipelineStatusBadge status={selectedPipeline.status} />
              </div>
              <Separator />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Stages</span>
                <span className="font-medium">{stages.length}</span>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs: Visual + Editor + Runs */}
        <Tabs defaultValue="visual" className="space-y-4">
          <TabsList>
            <TabsTrigger value="visual">
              <Eye className="size-3.5 me-1" />
              Visual
            </TabsTrigger>
            <TabsTrigger value="editor">
              <Settings className="size-3.5 me-1" />
              Editor
            </TabsTrigger>
            <TabsTrigger value="runs">
              <Clock className="size-3.5 me-1" />
              Runs
            </TabsTrigger>
          </TabsList>

          {/* Visual Tab */}
          <TabsContent value="visual" className="space-y-4">
            {/* Pipeline Flowchart */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <GitMerge className="size-4 text-indigo-600" />
                  Pipeline Flowchart
                </CardTitle>
              </CardHeader>
              <CardContent>
                <PipelineFlowchart stages={stages} />
              </CardContent>
            </Card>

            {/* Recent Runs with Visual Status */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="size-4 text-indigo-600" />
                  Recent Runs
                </CardTitle>
              </CardHeader>
              <CardContent>
                {runs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10">
                    <Clock className="size-8 text-muted-foreground/30 mb-2" />
                    <p className="text-sm text-muted-foreground">No runs yet</p>
                    <p className="text-xs text-muted-foreground/60">
                      {selectedPipeline.status === 'active'
                        ? 'Click "Run Now" to trigger your first pipeline run'
                        : 'Activate the pipeline to start running'}
                    </p>
                  </div>
                ) : (
                  <ScrollArea className="max-h-96">
                    <div className="space-y-2">
                      {runs.map((run) => {
                        // Parse stage results for mini progress
                        const runStageResults = run.stageResults || []
                        const runStages = parseStages(run.stages)
                        const displayItems = runStageResults.length > 0 ? runStageResults : runStages

                        return (
                          <div
                            key={run.id}
                            className="flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/30 transition-colors cursor-pointer"
                            onClick={() => openRun(run)}
                          >
                            {/* Status dot */}
                            <div className={`size-2.5 rounded-full shrink-0 ${getStatusColor(run.status)}`} />

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium font-mono">
                                  #{run.id.slice(-6)}
                                </span>
                                <RunStatusBadge status={run.status} />
                              </div>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                                <span className="flex items-center gap-1">
                                  <Zap className="size-2.5" />
                                  {getTriggerLabel(run.trigger)}
                                </span>
                                {run.branch && (
                                  <span className="flex items-center gap-1">
                                    <GitBranch className="size-2.5" />
                                    {run.branch}
                                  </span>
                                )}
                                <span>{formatDate(run.startedAt)}</span>
                              </div>

                              {/* Mini stage progress bar */}
                              {displayItems.length > 0 && (
                                <div className="flex items-center gap-0.5 mt-1.5">
                                  {displayItems.map((s: { status?: string; type?: string; name?: string }, si: number) => {
                                    const sStatus = (s as StageResult).status || 'pending'
                                    return (
                                      <Tooltip key={si}>
                                        <TooltipTrigger asChild>
                                          <div
                                            className={`h-1.5 flex-1 min-w-3 rounded-full ${
                                              sStatus === 'success' ? 'bg-indigo-500' :
                                              sStatus === 'failed' ? 'bg-red-500' :
                                              sStatus === 'running' ? 'bg-indigo-500 animate-pulse' :
                                              sStatus === 'skipped' ? 'bg-yellow-500' :
                                              'bg-gray-300 dark:bg-gray-700'
                                            }`}
                                          />
                                        </TooltipTrigger>
                                        <TooltipContent>
                                          {s.name || `Stage ${si + 1}`}: {sStatus}
                                        </TooltipContent>
                                      </Tooltip>
                                    )
                                  })}
                                </div>
                              )}
                            </div>

                            <div className="flex items-center gap-3 shrink-0">
                              <span className="text-sm font-mono text-muted-foreground">
                                {formatDuration(run.duration)}
                              </span>
                              <ChevronRight className="size-4 text-muted-foreground" />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Editor Tab */}
          <TabsContent value="editor">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Settings className="size-4 text-indigo-600" />
                    Pipeline Stages
                  </CardTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSaveStages}
                    disabled={savingStages || JSON.stringify(editStages) === selectedPipeline.stages}
                    className="h-7 text-xs"
                  >
                    {savingStages ? (
                      <Loader2 className="size-3 me-1 animate-spin" />
                    ) : null}
                    Save Changes
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <VisualStageEditor
                  stages={editStages}
                  onUpdateStages={setEditStages}
                  readOnly={selectedPipeline.status === 'active'}
                />
                {selectedPipeline.status === 'active' && (
                  <p className="text-xs text-muted-foreground mt-3 flex items-center gap-1">
                    <Settings className="size-3" />
                    Pause the pipeline to edit stages
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* Runs Tab */}
          <TabsContent value="runs">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="size-4 text-indigo-600" />
                  Run History
                </CardTitle>
              </CardHeader>
              <CardContent>
                {runs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10">
                    <Clock className="size-8 text-muted-foreground/30 mb-2" />
                    <p className="text-sm text-muted-foreground">No runs yet</p>
                    <p className="text-xs text-muted-foreground/60">
                      {selectedPipeline.status === 'active'
                        ? 'Click "Run Now" to trigger your first pipeline run'
                        : 'Activate the pipeline to start running'}
                    </p>
                  </div>
                ) : (
                  <ScrollArea className="max-h-96">
                    <div className="space-y-2">
                      {runs.map((run) => (
                        <div
                          key={run.id}
                          className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/30 transition-colors cursor-pointer"
                          onClick={() => openRun(run)}
                        >
                          <div className="flex items-center gap-3">
                            <div className={`size-2 rounded-full ${getStatusColor(run.status)}`} />
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium font-mono">
                                  #{run.id.slice(-6)}
                                </span>
                                <RunStatusBadge status={run.status} />
                              </div>
                              <div className="flex items-center gap-2 text-xs text-muted-foreground mt-0.5">
                                <span className="flex items-center gap-1">
                                  <Zap className="size-2.5" />
                                  {getTriggerLabel(run.trigger)}
                                </span>
                                {run.branch && (
                                  <span className="flex items-center gap-1">
                                    <GitBranch className="size-2.5" />
                                    {run.branch}
                                  </span>
                                )}
                                <span>{formatDate(run.startedAt)}</span>
                                <span>{formatTime(run.startedAt)}</span>
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            <span className="text-sm font-mono text-muted-foreground">
                              {formatDuration(run.duration)}
                            </span>
                            <ChevronRight className="size-4 text-muted-foreground" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    )
  }

  // ── Render: Run Detail View ────────────────────────────────────────

  const renderRunView = () => {
    if (runLoading) {
      return (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Skeleton className="size-8" />
            <Skeleton className="h-6 w-48" />
          </div>
          <Card>
            <CardContent className="p-5 space-y-4">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-40 w-full" />
            </CardContent>
          </Card>
        </div>
      )
    }

    if (!selectedRun) return null

    const stageResults = selectedRun.stageResults || []
    const runStages = parseStages(selectedRun.stages)

    return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="size-8" onClick={goBack}>
              <ArrowLeft className="size-4" />
            </Button>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold font-mono">
                  #{selectedRun.id.slice(-6)}
                </h2>
                <RunStatusBadge status={selectedRun.status} />
              </div>
              <p className="text-sm text-muted-foreground">
                {selectedRun.pipeline?.name || 'Pipeline'} &middot; {getTriggerLabel(selectedRun.trigger)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {selectedPipeline?.status === 'active' && selectedPipeline && (
              <Button
                size="sm"
                onClick={() => handleTriggerRun(selectedPipeline)}
                disabled={triggeringRun}
                className="bg-indigo-600 hover:bg-indigo-700 h-8"
              >
                {triggeringRun ? (
                  <Loader2 className="size-3.5 me-1 animate-spin" />
                ) : (
                  <RotateCcw className="size-3.5 me-1" />
                )}
                Re-run
              </Button>
            )}
          </div>
        </div>

        {/* Run Info */}
        <Card>
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              {selectedRun.branch && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <GitBranch className="size-3.5" />
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{selectedRun.branch}</code>
                </div>
              )}
              {selectedRun.commit && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <GitMerge className="size-3.5" />
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{selectedRun.commit.slice(0, 7)}</code>
                </div>
              )}
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Zap className="size-3.5" />
                <span>Trigger:</span>
                <span className="font-medium">{getTriggerLabel(selectedRun.trigger)}</span>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="size-3.5" />
                <span>Started:</span>
                <span>{formatDate(selectedRun.startedAt)} {formatTime(selectedRun.startedAt)}</span>
              </div>
              {selectedRun.duration != null && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Clock className="size-3.5" />
                  <span>Duration:</span>
                  <span className="font-mono font-medium">{formatDuration(selectedRun.duration)}</span>
                </div>
              )}
              {selectedRun.completedAt && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <CheckCircle2 className="size-3.5" />
                  <span>Completed:</span>
                  <span>{formatDate(selectedRun.completedAt)} {formatTime(selectedRun.completedAt)}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Horizontal Stage Progress */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <GitMerge className="size-4 text-indigo-600" />
              Stage Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <HorizontalRunProgress
              stageResults={stageResults}
              stages={runStages}
              selectedStage={selectedRunStage}
              onSelectStage={setSelectedRunStage}
            />
          </CardContent>
        </Card>

        {/* Selected Stage Detail */}
        {selectedRunStage !== null && stageResults[selectedRunStage] && (
          <Card className="border-indigo-200 dark:border-indigo-800">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  {React.createElement(getStageIcon(stageResults[selectedRunStage].type), {
                    className: `size-4 ${getStageTypeDef(stageResults[selectedRunStage].type).color}`,
                  })}
                  {stageResults[selectedRunStage].name}
                  <Badge variant="outline" className="text-[10px] h-5 capitalize">
                    {stageResults[selectedRunStage].status}
                  </Badge>
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-xs"
                  onClick={() => setSelectedRunStage(null)}
                >
                  Close
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4 text-sm text-muted-foreground mb-3">
                <span className="flex items-center gap-1">
                  <Clock className="size-3" />
                  Duration: {formatDuration(stageResults[selectedRunStage].duration)}
                </span>
                <Badge variant="outline" className="text-[10px] h-5">
                  {stageResults[selectedRunStage].type}
                </Badge>
              </div>
              {stageResults[selectedRunStage].output ? (
                <pre className="text-xs font-mono bg-muted/50 rounded-lg p-4 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                  {stageResults[selectedRunStage].output}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground italic">No output available for this stage.</p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Stage Results Timeline */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <GitMerge className="size-4 text-indigo-600" />
              Stage Results
            </CardTitle>
          </CardHeader>
          <CardContent>
            <RunTimeline
              stageResults={stageResults}
              expandedStage={expandedTimelineStage}
              onToggleStage={(index) =>
                setExpandedTimelineStage(expandedTimelineStage === index ? null : index)
              }
            />
          </CardContent>
        </Card>

        {/* Raw Stage Data */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Settings className="size-4 text-indigo-600" />
              Raw Output
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs font-mono bg-muted/50 rounded-lg p-4 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
              {selectedRun.stages || 'No raw data available'}
            </pre>
          </CardContent>
        </Card>
      </div>
    )
  }

  // ── Main Render ────────────────────────────────────────────────────

  return (
    <>
      {view === 'list' && renderListView()}
      {view === 'detail' && renderDetailView()}
      {view === 'run' && renderRunView()}

      {/* Create Pipeline Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="size-5 text-indigo-600" />
              Create Pipeline
            </DialogTitle>
            <DialogDescription>
              Set up a new CI/CD pipeline for your project. Default stages will be created automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="pipeline-name">Pipeline Name</Label>
              <Input
                id="pipeline-name"
                placeholder="e.g. Production Deploy"
                value={newPipelineName}
                onChange={(e) => setNewPipelineName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreatePipeline()
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="pipeline-project">Project</Label>
              <Select value={newPipelineProjectId} onValueChange={setNewPipelineProjectId}>
                <SelectTrigger id="pipeline-project">
                  <SelectValue placeholder="Select a project" />
                </SelectTrigger>
                <SelectContent>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {projects.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  No projects found. Create a project first in the Hosting section.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="pipeline-desc">Description (optional)</Label>
              <Input
                id="pipeline-desc"
                placeholder="Brief description of this pipeline"
                value={newPipelineDescription}
                onChange={(e) => setNewPipelineDescription(e.target.value)}
              />
            </div>
            <div className="rounded-lg bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">
                A default pipeline with Build, Test, and Deploy stages will be created.
                You can customize stages after creation using the visual editor.
                The pipeline will start in <strong>Draft</strong> status — activate it when ready.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim() || !newPipelineProjectId}
              className="bg-indigo-600 hover:bg-indigo-700"
            >
              {creating ? (
                <>
                  <Loader2 className="size-3.5 me-1 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <Plus className="size-3.5 me-1" />
                  Create Pipeline
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Pipeline Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Pipeline</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{pipelineToDelete?.name}&rdquo;? This action cannot be undone.
              All pipeline runs and configuration will be permanently deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeletePipeline}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700"
            >
              {deleting ? (
                <>
                  <Loader2 className="size-3.5 me-1 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-3.5 me-1" />
                  Delete
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
