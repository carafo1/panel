/**
 * Request body limits shared by the proxy configuration and upload routes.
 *
 * Next.js buffers every request body that passes through the proxy
 * (src/proxy.ts) and keeps only the first `proxyClientMaxBodySize` bytes; the
 * rest is DROPPED SILENTLY and the route receives a truncated body. With the
 * default of 10 MB every file-manager upload over 10 MB failed with "Could
 * not parse multipart form", and a streamed site upload over the limit would
 * have been stored cut off.
 *
 * next.config.ts sets proxyClientMaxBodySize to PROXY_BODY_LIMIT_BYTES (the
 * value is repeated there: the config file cannot import from src/). Upload
 * routes refuse a declared body above it with a clear 413 instead of reading
 * a truncated one. Larger files go through the chunked site import (8 MB
 * pieces) or SFTP.
 */
export const PROXY_BODY_LIMIT_BYTES = 100 * 1024 * 1024

/** The declared Content-Length, or null when absent or not a number. */
export function declaredBodyLength(request: Request): number | null {
  const raw = request.headers.get('content-length')
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/** True when the request declares a body the proxy would truncate. */
export function exceedsProxyBodyLimit(request: Request): boolean {
  const n = declaredBodyLength(request)
  return n !== null && n > PROXY_BODY_LIMIT_BYTES
}

export function formatMegabytes(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`
}
