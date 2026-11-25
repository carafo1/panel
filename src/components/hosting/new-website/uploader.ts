/**
 * Resumable backup upload.
 * =======================
 *
 * Talks to the existing chunked endpoints on /api/hosting/upload:
 *
 *   POST ?action=begin   { filename, totalChunks, sizeBytes } → { uploadId }
 *   POST ?action=chunk&uploadId=…&index=N   raw bytes          (idempotent per index)
 *   POST ?action=finish&uploadId=…          → { uploadId, filename, sizeBytes }
 *   GET  ?uploadId=…                         → { complete, receivedChunks, totalChunks }
 *
 * Every file goes up in 8 MB chunks, even small ones, so every upload can be
 * resumed: a chunk is stored by its index, so sending one again is harmless.
 *
 * Resume works at two levels:
 *   - a dropped request is retried with backoff, and while the browser is
 *     offline the upload waits for the connection to come back;
 *   - the upload id is remembered per file (name + size + modified time), so
 *     choosing the same file again after a reload continues where it stopped.
 */

export const CHUNK_SIZE = 8 * 1024 * 1024
const MAX_ATTEMPTS = 5
const STORAGE_PREFIX = 'apsamo:upload:'

export interface UploadResult {
  uploadId: string
  filename: string
  sizeBytes: number
}

export interface UploadProgress {
  loaded: number
  total: number
  /** Smoothed transfer rate, null until there is enough data. */
  bytesPerSecond: number | null
  secondsLeft: number | null
}

export type UploadPhase = 'uploading' | 'reconnecting' | 'finishing'

/** The connection kept failing; the upload can be resumed later. */
export class UploadInterruptedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UploadInterruptedError'
  }
}

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled')
    this.name = 'UploadCancelledError'
  }
}

interface Remembered {
  uploadId: string
  totalChunks: number
}

const memoryStore = new Map<string, Remembered>()

function fileKey(file: File): string {
  return `${STORAGE_PREFIX}${file.name}:${file.size}:${file.lastModified}`
}

function remember(file: File, value: Remembered | null) {
  const key = fileKey(file)
  if (value) memoryStore.set(key, value)
  else memoryStore.delete(key)
  try {
    if (value) window.localStorage.setItem(key, JSON.stringify(value))
    else window.localStorage.removeItem(key)
  } catch {
    // Storage can be unavailable (private mode); the in-memory copy still
    // covers retries within this page.
  }
}

function recall(file: File): Remembered | null {
  const key = fileKey(file)
  try {
    const raw = window.localStorage.getItem(key)
    if (raw) {
      const parsed = JSON.parse(raw) as Remembered
      if (parsed && typeof parsed.uploadId === 'string') return parsed
    }
  } catch {
    // fall through to memory
  }
  return memoryStore.get(key) ?? null
}

/** Status codes worth retrying: the request may succeed a moment later. */
function isTransient(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** POST a body with upload progress. Resolves with parsed JSON. */
function xhrPost(
  url: string,
  body: Blob | string | null,
  signal: AbortSignal,
  onBytes?: (loaded: number) => void,
  contentType?: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new UploadCancelledError())
      return
    }
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.withCredentials = true
    if (contentType) xhr.setRequestHeader('Content-Type', contentType)
    if (onBytes) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onBytes(e.loaded)
      }
    }
    const onAbort = () => xhr.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    xhr.onload = () => {
      signal.removeEventListener('abort', onAbort)
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(xhr.responseText || '{}')
      } catch {
        // non-JSON body (proxy error page)
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data)
      else
        reject(
          new HttpError(
            xhr.status,
            typeof data.error === 'string' ? data.error : `The server answered ${xhr.status}.`
          )
        )
    }
    xhr.onerror = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new HttpError(0, 'The connection to the server was lost.'))
    }
    xhr.onabort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new UploadCancelledError())
    }
    xhr.send(body)
  })
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(new UploadCancelledError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Resolves when the browser reports it is online again. */
function waitForOnline(signal: AbortSignal): Promise<void> {
  if (typeof navigator === 'undefined' || navigator.onLine) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener('online', done)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = () => {
      window.removeEventListener('online', done)
      reject(new UploadCancelledError())
    }
    window.addEventListener('online', done)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Rolling 10-second window for a steady speed estimate. */
class RateMeter {
  private samples: Array<{ t: number; bytes: number }> = []
  push(bytes: number) {
    const t = performance.now()
    this.samples.push({ t, bytes })
    while (this.samples.length > 2 && t - this.samples[0].t > 10_000) this.samples.shift()
  }
  rate(): number | null {
    if (this.samples.length < 2) return null
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const dt = (last.t - first.t) / 1000
    if (dt < 1) return null
    const rate = (last.bytes - first.bytes) / dt
    return rate > 0 ? rate : null
  }
}

export interface UploadOptions {
  signal: AbortSignal
  onProgress: (p: UploadProgress) => void
  onPhase?: (phase: UploadPhase) => void
}

export async function uploadResumable(file: File, opts: UploadOptions): Promise<UploadResult> {
  const { signal, onProgress, onPhase } = opts
  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE))
  const meter = new RateMeter()

  const report = (loaded: number) => {
    meter.push(loaded)
    const rate = meter.rate()
    onProgress({
      loaded,
      total: file.size,
      bytesPerSecond: rate,
      secondsLeft: rate ? (file.size - loaded) / rate : null,
    })
  }

  // ── Resume an earlier attempt of the same file, if the server still has it.
  let uploadId: string | null = null
  let startIndex = 0
  const previous = recall(file)
  if (previous && previous.totalChunks === totalChunks) {
    try {
      const res = await fetch(`/api/hosting/upload?uploadId=${encodeURIComponent(previous.uploadId)}`, {
        credentials: 'same-origin',
        signal,
      })
      if (res.ok) {
        const status = (await res.json()) as {
          complete?: boolean
          receivedChunks?: number
          filename?: string
          sizeBytes?: number
        }
        if (status.complete) {
          report(file.size)
          return {
            uploadId: previous.uploadId,
            filename: status.filename || file.name,
            sizeBytes: status.sizeBytes || file.size,
          }
        }
        uploadId = previous.uploadId
        // Chunks go up in order, so the count is the next index. Step back one
        // in case the last one was cut short; re-sending it is harmless.
        startIndex = Math.max(0, Math.min(totalChunks - 1, (status.receivedChunks ?? 0) - 1))
      } else {
        remember(file, null)
      }
    } catch (err) {
      if (signal.aborted) throw new UploadCancelledError()
      void err
    }
  }

  onPhase?.('uploading')

  if (!uploadId) {
    const begin = await xhrPost(
      '/api/hosting/upload?action=begin',
      JSON.stringify({ filename: file.name, totalChunks, sizeBytes: file.size }),
      signal,
      undefined,
      'application/json'
    ).catch((err: unknown) => {
      if (err instanceof HttpError && isTransient(err.status)) {
        throw new UploadInterruptedError(err.message)
      }
      throw err
    })
    uploadId = String(begin.uploadId)
    remember(file, { uploadId, totalChunks })
  }

  report(startIndex * CHUNK_SIZE)

  for (let i = startIndex; i < totalChunks; i++) {
    const from = i * CHUNK_SIZE
    const slice = file.slice(from, Math.min(from + CHUNK_SIZE, file.size))
    let attempt = 0
    for (;;) {
      if (signal.aborted) throw new UploadCancelledError()
      try {
        await xhrPost(
          `/api/hosting/upload?action=chunk&uploadId=${encodeURIComponent(uploadId)}&index=${i}`,
          slice,
          signal,
          (loaded) => report(from + loaded),
          'application/octet-stream'
        )
        if (attempt > 0) onPhase?.('uploading')
        break
      } catch (err) {
        if (err instanceof UploadCancelledError) throw err
        const transient = err instanceof HttpError ? isTransient(err.status) : true
        if (!transient) {
          // "Upload not found" means the server discarded it; start clean next time.
          if (err instanceof HttpError && err.status === 400 && /not found/i.test(err.message)) {
            remember(file, null)
          }
          throw err
        }
        attempt++
        onPhase?.('reconnecting')
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          await waitForOnline(signal)
          continue
        }
        if (attempt >= MAX_ATTEMPTS) {
          throw new UploadInterruptedError(
            'The connection keeps dropping. Your progress is saved — press Resume to continue.'
          )
        }
        await wait(Math.min(8000, 1000 * 2 ** (attempt - 1)), signal)
      }
    }
    report(Math.min(file.size, from + slice.size))
  }

  onPhase?.('finishing')
  let finish: Record<string, unknown>
  try {
    finish = await xhrPost(
      `/api/hosting/upload?action=finish&uploadId=${encodeURIComponent(uploadId)}`,
      null,
      signal
    )
  } catch (err) {
    if (err instanceof HttpError && isTransient(err.status)) {
      throw new UploadInterruptedError(err.message)
    }
    if (err instanceof HttpError && /missing/i.test(err.message)) {
      // A chunk was lost on the server; forget the id so a retry starts clean.
      remember(file, null)
    }
    throw err
  }
  remember(file, null)
  return {
    uploadId: String(finish.uploadId ?? uploadId),
    filename: String(finish.filename ?? file.name),
    sizeBytes: Number(finish.sizeBytes ?? file.size),
  }
}

/** Best-effort removal of a staged upload the customer replaced. */
export function discardUpload(uploadId: string): void {
  void fetch(`/api/hosting/upload?uploadId=${encodeURIComponent(uploadId)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  }).catch(() => {})
}
