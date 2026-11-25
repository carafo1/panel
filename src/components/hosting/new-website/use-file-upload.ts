'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { formatBytes, hasAcceptedExtension } from './format'
import {
  UploadCancelledError,
  UploadInterruptedError,
  discardUpload,
  uploadResumable,
  type UploadPhase,
  type UploadProgress,
  type UploadResult,
} from './uploader'

export type FileSlot =
  | { status: 'empty'; error?: string }
  | {
      status: 'uploading'
      name: string
      size: number
      phase: UploadPhase
      progress: UploadProgress
    }
  | { status: 'paused'; name: string; size: number; loaded: number; message: string }
  | { status: 'done'; result: UploadResult }
  | { status: 'failed'; name: string; size: number; message: string }

export interface FileRules {
  accept: string[]
  maxBytes: number
  /** Plain-language name of what is expected, used in error messages. */
  kind: string
}

export interface FileUpload {
  slot: FileSlot
  select: (file: File, override?: FileRules) => void
  cancel: () => void
  resume: () => void
  remove: () => void
  /** Validate without uploading; returns an error message or null. */
  check: (file: File, override?: FileRules) => string | null
}

/**
 * One upload slot: validation, resumable transfer, cancel, resume after a
 * dropped connection, and replace/remove.
 */
export function useFileUpload(
  rules: FileRules,
  hooks: { onDone?: (result: UploadResult, file: File) => void } = {}
): FileUpload {
  const [slot, setSlot] = useState<FileSlot>({ status: 'empty' })
  const slotRef = useRef(slot)
  const fileRef = useRef<File | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const onDoneRef = useRef(hooks.onDone)
  const rulesRef = useRef(rules)
  // Latest values for callbacks, synced after render.
  useLayoutEffect(() => {
    slotRef.current = slot
    onDoneRef.current = hooks.onDone
    rulesRef.current = rules
  })

  useEffect(() => () => abortRef.current?.abort(), [])

  const check = useCallback((file: File, override?: FileRules): string | null => {
    const r = override ?? rulesRef.current
    if (!hasAcceptedExtension(file.name, r.accept)) {
      return `“${file.name}” is not a ${r.kind}. Choose a ${r.accept.join(', ')} file.`
    }
    if (file.size <= 0) return `“${file.name}” is empty.`
    if (file.size > r.maxBytes) {
      return `“${file.name}” is ${formatBytes(file.size)}, which is over the ${formatBytes(
        r.maxBytes
      )} limit for this upload.`
    }
    return null
  }, [])

  const run = useCallback(async (file: File) => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    fileRef.current = file
    setSlot({
      status: 'uploading',
      name: file.name,
      size: file.size,
      phase: 'uploading',
      progress: { loaded: 0, total: file.size, bytesPerSecond: null, secondsLeft: null },
    })
    let lastLoaded = 0
    try {
      const result = await uploadResumable(file, {
        signal: controller.signal,
        onProgress: (progress) => {
          lastLoaded = progress.loaded
          setSlot((s) => (s.status === 'uploading' ? { ...s, progress } : s))
        },
        onPhase: (phase) => setSlot((s) => (s.status === 'uploading' ? { ...s, phase } : s)),
      })
      if (controller.signal.aborted) return
      setSlot({ status: 'done', result })
      onDoneRef.current?.(result, file)
    } catch (err) {
      if (err instanceof UploadCancelledError || controller.signal.aborted) return
      if (err instanceof UploadInterruptedError) {
        setSlot({ status: 'paused', name: file.name, size: file.size, loaded: lastLoaded, message: err.message })
        return
      }
      setSlot({
        status: 'failed',
        name: file.name,
        size: file.size,
        message: err instanceof Error ? err.message : 'The upload failed.',
      })
    } finally {
      if (abortRef.current === controller) abortRef.current = null
    }
  }, [])

  const select = useCallback(
    (file: File, override?: FileRules) => {
      const problem = check(file, override)
      if (problem) {
        setSlot({ status: 'empty', error: problem })
        return
      }
      const prev = slotRef.current
      if (prev.status === 'done') discardUpload(prev.result.uploadId)
      void run(file)
    },
    [check, run]
  )

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    fileRef.current = null
    setSlot({ status: 'empty' })
  }, [])

  const resume = useCallback(() => {
    if (fileRef.current) void run(fileRef.current)
  }, [run])

  const remove = useCallback(() => {
    const prev = slotRef.current
    if (prev.status === 'done') discardUpload(prev.result.uploadId)
    setSlot({ status: 'empty' })
    fileRef.current = null
  }, [])

  // Resume on its own when the connection returns.
  useEffect(() => {
    if (slot.status !== 'paused') return
    const onOnline = () => {
      if (fileRef.current) void run(fileRef.current)
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [slot.status, run])

  return { slot, select, cancel, resume, remove, check }
}
