'use client'

import { useId, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  FileArchive,
  Loader2,
  RotateCw,
  UploadCloud,
  WifiOff,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { formatBytes, formatSpeed, formatTimeLeft } from './format'
import type { FileRules, FileUpload } from './use-file-upload'

/**
 * Drag-and-drop file slot with every state the customer can meet:
 * empty (with accepted formats and limit shown up front), rejected file,
 * uploading (bytes, speed, time left), reconnecting, paused, failed, done.
 */
export function FileDrop({
  label,
  description,
  rules,
  upload,
  optional,
  icon: Icon = FileArchive,
}: {
  label: string
  description?: string
  rules: FileRules
  upload: FileUpload
  optional?: boolean
  icon?: typeof FileArchive
}) {
  const id = useId()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [dragging, setDragging] = useState(false)
  const { slot } = upload
  const formats = rules.accept.join(', ')
  const limit = formatBytes(rules.maxBytes)

  const browse = () => inputRef.current?.click()

  const input = (
    <input
      ref={inputRef}
      id={`${id}-input`}
      type="file"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      accept={rules.accept.join(',')}
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) upload.select(file)
        e.target.value = ''
      }}
    />
  )

  const heading = (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <p id={`${id}-label`} className="text-sm font-medium">
        {label}
        {optional && <span className="ms-1.5 font-normal text-muted-foreground">(optional)</span>}
      </p>
    </div>
  )

  // ── Done ────────────────────────────────────────────────────────────
  if (slot.status === 'done') {
    return (
      <div>
        {heading}
        <div className="flex items-center gap-3 rounded-lg border bg-card p-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-5" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{slot.result.filename}</p>
            <p className="text-xs text-muted-foreground">
              {formatBytes(slot.result.sizeBytes)} · uploaded
            </p>
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={browse}>
            Replace
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={upload.remove}
            aria-label={`Remove ${slot.result.filename}`}
          >
            <X className="size-4" />
          </Button>
        </div>
        {input}
      </div>
    )
  }

  // ── In flight / paused / failed ─────────────────────────────────────
  if (slot.status === 'uploading' || slot.status === 'paused' || slot.status === 'failed') {
    const loaded = slot.status === 'uploading' ? slot.progress.loaded : slot.status === 'paused' ? slot.loaded : 0
    const pct = slot.size > 0 ? Math.min(100, Math.floor((loaded / slot.size) * 100)) : 0
    const reconnecting = slot.status === 'uploading' && slot.phase === 'reconnecting'
    const finishing = slot.status === 'uploading' && slot.phase === 'finishing'
    const speed = slot.status === 'uploading' ? formatSpeed(slot.progress.bytesPerSecond) : ''
    const left = slot.status === 'uploading' ? formatTimeLeft(slot.progress.secondsLeft) : ''

    let statusLine: string
    if (slot.status === 'failed') statusLine = slot.message
    else if (slot.status === 'paused') statusLine = slot.message
    else if (reconnecting) statusLine = 'Connection lost — retrying automatically…'
    else if (finishing) statusLine = 'Putting the pieces together on the server…'
    else statusLine = [`${formatBytes(loaded)} of ${formatBytes(slot.size)}`, speed, left].filter(Boolean).join(' · ')

    return (
      <div>
        {heading}
        <div
          className={cn(
            'rounded-lg border p-3',
            slot.status === 'failed' && 'border-destructive/40 bg-destructive/5',
            (slot.status === 'paused' || reconnecting) && 'border-amber-500/40 bg-amber-500/5'
          )}
        >
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              {slot.status === 'failed' ? (
                <AlertCircle className="size-5 text-destructive" aria-hidden />
              ) : slot.status === 'paused' || reconnecting ? (
                <WifiOff className="size-5 text-amber-600 dark:text-amber-400" aria-hidden />
              ) : (
                <Loader2 className="size-5 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-sm font-medium">{slot.name}</p>
                {slot.status !== 'failed' && (
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{pct}%</span>
                )}
              </div>
              <p
                className={cn(
                  'text-xs text-muted-foreground',
                  slot.status === 'failed' && 'text-destructive'
                )}
              >
                {statusLine}
              </p>
            </div>
          </div>
          {slot.status !== 'failed' && (
            <Progress
              value={pct}
              className="mt-3 h-1.5"
              aria-label={`Uploading ${slot.name}`}
              aria-valuetext={`${pct} percent`}
            />
          )}
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            {slot.status === 'uploading' && (
              <Button type="button" variant="ghost" size="sm" onClick={upload.cancel}>
                Cancel upload
              </Button>
            )}
            {slot.status === 'paused' && (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={upload.cancel}>
                  Discard
                </Button>
                <Button type="button" size="sm" onClick={upload.resume}>
                  <RotateCw className="me-1.5 size-4" aria-hidden />
                  Resume upload
                </Button>
              </>
            )}
            {slot.status === 'failed' && (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={browse}>
                  Choose another file
                </Button>
                <Button type="button" size="sm" onClick={upload.resume}>
                  <RotateCw className="me-1.5 size-4" aria-hidden />
                  Try again
                </Button>
              </>
            )}
          </div>
          {/* Announce state changes, not every percent. */}
          <p className="sr-only" aria-live="polite">
            {slot.status === 'paused'
              ? 'Upload paused. ' + slot.message
              : slot.status === 'failed'
                ? 'Upload failed. ' + slot.message
                : reconnecting
                  ? 'Connection lost, retrying.'
                  : finishing
                    ? 'Upload almost done.'
                    : `Uploading ${Math.floor(pct / 10) * 10} percent`}
          </p>
        </div>
        {input}
      </div>
    )
  }

  // ── Empty ───────────────────────────────────────────────────────────
  const error = slot.status === 'empty' ? slot.error : undefined
  return (
    <div>
      {heading}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          if (!dragging) setDragging(true)
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const file = e.dataTransfer.files?.[0]
          if (file) upload.select(file)
        }}
        className={cn(
          'rounded-lg border-2 border-dashed transition-colors duration-150',
          dragging
            ? 'border-primary bg-primary/5'
            : error
              ? 'border-destructive/50'
              : 'border-border hover:border-primary/50'
        )}
      >
        <button
          type="button"
          onClick={browse}
          aria-describedby={`${id}-formats${error ? ` ${id}-error` : ''}`}
          aria-labelledby={`${id}-label ${id}-cta`}
          className="flex w-full flex-col items-center gap-2 rounded-md px-4 py-7 text-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            {dragging ? <UploadCloud className="size-5" aria-hidden /> : <Icon className="size-5" aria-hidden />}
          </span>
          <span id={`${id}-cta`} className="text-sm font-medium">
            {dragging ? 'Drop to upload' : (
              <>
                Drag a file here, or <span className="text-primary underline underline-offset-2">choose from your computer</span>
              </>
            )}
          </span>
          <span id={`${id}-formats`} className="text-xs text-muted-foreground">
            {formats} · up to {limit}
          </span>
        </button>
      </div>
      {description && !error && <p className="mt-2 text-xs text-muted-foreground">{description}</p>}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
      {input}
    </div>
  )
}
